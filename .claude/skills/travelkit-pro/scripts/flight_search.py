#!/usr/bin/env python3
"""运行 Simplifly 航班 shopping 搜索，并把 API 原始响应交给 agent。

脚本优先从当前目录向上查找 `.simplifly.env`，读取 Simplifly 网关地址和
Bearer token；找不到该文件时，改从平台注入的进程环境变量读取配置。
随后调用 `/openapi/v3/flight/shopping`。stdout 是 agent 内部输入，不是
用户展示结果；用户可见脱敏由 skill/output rules 负责。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping


SHOPPING_ENDPOINT = "/openapi/v3/flight/shopping"

# stdout 可包含 API 业务字段；凭证、headers、配置路径仍不能输出。
SENSITIVE_ERROR_KEYS = ("authorization", "token", "secret", "jwt", "bearer")


def main() -> int:
    # 主流程：解析 CLI 参数 -> 读取本地配置 -> 组装一个或多个请求 -> 调接口 -> 输出 JSON。
    # 不同错误返回不同退出码，方便脚本被 agent 或 CI 调用时判断失败类型。
    args = parse_args()

    try:
        validate_args(args)
        config = load_config()
        searches = build_search_requests(args)
        responses = []
        for index, search in enumerate(searches, start=1):
            payload, http_status = post_json(config, SHOPPING_ENDPOINT, search["body"])
            responses.append(
                {
                    "index": index,
                    "label": search["label"],
                    "body": search["body"],
                    "payload": payload,
                    "httpStatus": http_status,
                }
            )
        result = build_output(responses, SHOPPING_ENDPOINT)
        print_json(result)
        return 0 if result.get("ok") else 2
    except ConfigError as exc:
        print_json(error_output("config_error", str(exc), SHOPPING_ENDPOINT))
        return 1
    except InputError as exc:
        print_json(error_output("input_error", str(exc), SHOPPING_ENDPOINT))
        return 1
    except NetworkError as exc:
        print_json(error_output("network_error", str(exc), SHOPPING_ENDPOINT))
        return 3
    except ResponseParseError as exc:
        print_json(error_output("response_parse_error", str(exc), SHOPPING_ENDPOINT))
        return 4


class ConfigError(Exception):
    pass


class InputError(Exception):
    pass


class NetworkError(Exception):
    pass


class ResponseParseError(Exception):
    pass


def parse_args() -> argparse.Namespace:
    # 保留固定参数便于人工测试；agent 工作流统一使用 --request-file。
    parser = argparse.ArgumentParser(
        description="Search Simplifly flight shopping and print raw API responses for agent processing.",
    )
    parser.add_argument("--request-file", help="JSON file containing one or more structured shopping searches")
    parser.add_argument("--origin", help="Origin city or airport IATA code, e.g. BJS")
    parser.add_argument("--destination", help="Destination city or airport IATA code, e.g. SHA")
    parser.add_argument("--date", help="Departure date in YYYY-MM-DD format")
    parser.add_argument("--adult", type=int, default=1, help="Adult passenger count, default: 1")
    parser.add_argument("--child", type=int, default=0, help="Child passenger count, default: 0")
    parser.add_argument("--infant", type=int, default=0, help="Infant passenger count, default: 0")
    parser.add_argument(
        "--cabin",
        default="economy",
        choices=[
            "economy",
            "premium_economy",
            "business",
            "premium_business",
            "first",
            "premium_first",
        ],
        help="Cabin class, default: economy",
    )
    parser.add_argument("--top", type=int, default=10, help="Manual CLI compatibility only; ignored in raw output mode")
    parser.add_argument("--nonstop", action="store_true", help="Send maxSegments=1")
    parser.add_argument("--max-price", type=float, help="Maximum total price filter")
    parser.add_argument("--max-duration", type=int, help="Maximum duration in minutes")
    parser.add_argument(
        "--include-airline",
        action="append",
        default=[],
        help="Airline code to include. Repeat or pass comma-separated values.",
    )
    parser.add_argument(
        "--exclude-airline",
        action="append",
        default=[],
        help="Airline code to exclude. Repeat or pass comma-separated values.",
    )
    parser.add_argument("--must-have-bag", action="store_true", help="Require checked baggage")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    # 在发起网络请求前尽早拦截明显非法的输入。
    if args.request_file:
        if args.origin or args.destination or args.date:
            raise InputError("--request-file cannot be combined with --origin, --destination, or --date.")
    else:
        missing = [name for name in ("origin", "destination", "date") if not getattr(args, name)]
        if missing:
            raise InputError(f"Missing required arguments without --request-file: {', '.join('--' + name for name in missing)}")
    if args.adult < 0 or args.child < 0 or args.infant < 0:
        raise InputError("Passenger counts must not be negative.")
    if args.adult + args.child + args.infant <= 0:
        raise InputError("At least one passenger is required.")
    if args.top <= 0:
        raise InputError("--top must be greater than zero.")
    if args.max_price is not None and args.max_price <= 0:
        raise InputError("--max-price must be greater than zero.")
    if args.max_duration is not None and args.max_duration <= 0:
        raise InputError("--max-duration must be greater than zero.")


def load_config() -> dict[str, str]:
    # 本地配置优先；没有 `.simplifly.env` 时兼容平台注入的进程环境变量。
    # 这里只返回运行所需的配置值，不输出配置文件路径或 token。
    env_path = find_env_file(Path.cwd())
    if env_path is None:
        return config_from_values(os.environ, "environment variables")
    if "skills" in env_path.parts:
        raise ConfigError("Invalid .simplifly.env placement. Keep it outside the skill package.")

    env = parse_dotenv(env_path)
    return config_from_values(env, ".simplifly.env")


def config_from_values(values: Mapping[str, str], source: str) -> dict[str, str]:
    missing = [name for name in ("SIMPLIFLY_BASE_URL", "SIMPLIFLY_AUTH_TOKEN") if not values.get(name)]
    if missing:
        raise ConfigError(f"Missing required Simplifly config in {source}: {', '.join(missing)}")

    return {
        "base_url": values["SIMPLIFLY_BASE_URL"].rstrip("/"),
        "auth_token": values["SIMPLIFLY_AUTH_TOKEN"],
        "accept_language": values.get("SIMPLIFLY_ACCEPT_LANGUAGE") or "zh-Hans",
        "sf_mode": values.get("SIMPLIFLY_SF_MODE") or "buyer",
    }


def find_env_file(start: Path) -> Path | None:
    # 逐级向父目录查找，避免把某台机器上的绝对路径写死进脚本。
    current = start.resolve()
    while True:
        candidate = current / ".simplifly.env"
        if candidate.is_file():
            return candidate
        if current.parent == current:
            return None
        current = current.parent


def parse_dotenv(path: Path) -> dict[str, str]:
    # 轻量 dotenv 解析器，避免为了读取几项配置引入第三方依赖。
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = strip_inline_comment(value.strip())
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        values[key] = value
    return values


def strip_inline_comment(value: str) -> str:
    if not value or value[0] in {"'", '"'}:
        return value
    return re.split(r"\s+#", value, maxsplit=1)[0].strip()


def build_request_body(args: argparse.Namespace) -> dict[str, Any]:
    # 将命令行参数映射成 Simplifly shopping 接口的请求体字段。
    # 不发送 maxResultCount；脚本输出 raw API 响应，不裁剪候选结果。
    body: dict[str, Any] = {
        "journeys": [
            {
                "origin": args.origin.upper(),
                "destination": args.destination.upper(),
                "departureDate": args.date,
            }
        ],
        "passengers": {
            "adult": args.adult,
            "child": args.child,
            "infant": args.infant,
        },
        "cabinClass": args.cabin,
    }
    if args.nonstop:
        body["maxSegments"] = 1
    if args.max_price is not None:
        body["maxPrice"] = args.max_price
    if args.max_duration is not None:
        body["maxDuration"] = args.max_duration
    include_airlines = normalize_codes(args.include_airline)
    exclude_airlines = normalize_codes(args.exclude_airline)
    if include_airlines:
        body["includeAirlines"] = include_airlines
    if exclude_airlines:
        body["excludeAirlines"] = exclude_airlines
    if args.must_have_bag:
        body["mustHaveBag"] = True
    return body


def build_search_requests(args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.request_file:
        return build_search_requests_from_file(Path(args.request_file))
    return [{"label": "search", "body": build_request_body(args)}]


def build_search_requests_from_file(path: Path) -> list[dict[str, Any]]:
    try:
        request_doc = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise InputError(f"Cannot read --request-file: {sanitize_text(str(exc))}") from exc
    except json.JSONDecodeError as exc:
        raise InputError(f"--request-file is not valid JSON: {exc.msg}") from exc

    if not isinstance(request_doc, dict):
        raise InputError("--request-file must contain a JSON object.")
    searches = request_doc.get("searches")
    if not isinstance(searches, list) or not searches:
        raise InputError("--request-file must contain a non-empty searches array.")

    built_searches = []
    for index, search in enumerate(searches, start=1):
        if not isinstance(search, dict):
            raise InputError(f"searches[{index}] must be an object.")
        label = str(search.get("label") or f"search-{index}")
        built_searches.append({"label": label, "body": build_request_body_from_search(search, index)})
    return built_searches


def build_request_body_from_search(search: dict[str, Any], index: int) -> dict[str, Any]:
    journeys = search.get("journeys")
    if not isinstance(journeys, list) or not journeys:
        raise InputError(f"searches[{index}].journeys must be a non-empty array.")

    normalized_journeys = []
    for journey_index, journey in enumerate(journeys, start=1):
        if not isinstance(journey, dict):
            raise InputError(f"searches[{index}].journeys[{journey_index}] must be an object.")
        origin = journey.get("origin")
        destination = journey.get("destination")
        departure_date = journey.get("departureDate")
        if not origin or not destination or not departure_date:
            raise InputError(
                f"searches[{index}].journeys[{journey_index}] requires origin, destination, and departureDate."
            )
        normalized_journeys.append(
            {
                "origin": str(origin).upper(),
                "destination": str(destination).upper(),
                "departureDate": str(departure_date),
            }
        )

    passengers = normalize_passengers(search.get("passengers"), index)
    body: dict[str, Any] = {
        "journeys": normalized_journeys,
        "passengers": passengers,
        "cabinClass": normalize_cabin(search.get("cabinClass")),
    }

    filters = search.get("filters") or {}
    if not isinstance(filters, dict):
        raise InputError(f"searches[{index}].filters must be an object when provided.")
    for key in (
        "excludeAirlines",
        "includeAirlines",
        "alliances",
        "mustHaveBag",
        "maxPrice",
        "maxDuration",
        "maxSegments",
        "freeBaggage",
        "changeable",
        "refundable",
        "noCodeShare",
        "noOverNight",
        "noVirtualInterline",
        "noMultiAirport",
        "onlyCorporateFares",
    ):
        if key in filters:
            body[key] = filters[key]
    return body


def normalize_passengers(value: Any, index: int) -> dict[str, int]:
    if value is None:
        passengers = {"adult": 1, "child": 0, "infant": 0}
    elif isinstance(value, dict):
        try:
            passengers = {
                "adult": int(value.get("adult", 0)),
                "child": int(value.get("child", 0)),
                "infant": int(value.get("infant", 0)),
            }
        except (TypeError, ValueError) as exc:
            raise InputError(f"searches[{index}].passenger counts must be integers.") from exc
    else:
        raise InputError(f"searches[{index}].passengers must be an object when provided.")
    if any(count < 0 for count in passengers.values()):
        raise InputError(f"searches[{index}].passenger counts must not be negative.")
    if sum(passengers.values()) <= 0:
        raise InputError(f"searches[{index}] requires at least one passenger.")
    return passengers


def normalize_cabin(value: Any) -> str:
    cabin = str(value or "economy")
    allowed = {"economy", "premium_economy", "business", "premium_business", "first", "premium_first"}
    if cabin not in allowed:
        raise InputError(f"Unsupported cabinClass: {cabin}")
    return cabin


def normalize_codes(values: list[str]) -> list[str]:
    # 支持 `--include-airline CA --include-airline MU` 和 `--include-airline CA,MU` 两种写法。
    codes: list[str] = []
    for value in values:
        for code in value.split(","):
            normalized = code.strip().upper()
            if normalized:
                codes.append(normalized)
    return codes


def post_json(config: dict[str, str], endpoint: str, body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    # 使用标准库发起 HTTP POST；Authorization 只进入请求头，不进入任何输出字段。
    url = f"{config['base_url']}{endpoint}"
    encoded_body = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=encoded_body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {config['auth_token']}",
            "Accept-Language": config["accept_language"],
            "X-SF-Mode": config["sf_mode"],
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response_body = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        response_body = exc.read()
        status = exc.code
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise NetworkError(sanitize_text(str(exc))) from exc

    try:
        parsed = json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ResponseParseError("API response was not valid JSON.") from exc

    if not isinstance(parsed, dict):
        raise ResponseParseError("API response JSON was not an object.")
    return parsed, status


def build_output(
    responses: list[dict[str, Any]],
    endpoint: str,
) -> dict[str, Any]:
    # stdout 是 agent 内部输入：保留 API envelope，供 agent 自行排序、脱敏和建映射。
    searched_requests = []
    all_response_codes = []

    for response in responses:
        payload = response["payload"]
        response_code = payload.get("code")
        all_response_codes.append(response_code)
        searched_requests.append(
            {
                "searchIndex": response["index"],
                "searchLabel": response["label"],
                "request": response["body"],
                "httpStatus": response["httpStatus"],
                "responseCode": response_code,
                "message": payload.get("message") or payload.get("realMessage") or "",
                "rawResponse": payload,
            }
        )

    ok = bool(responses) and all(code == 0 for code in all_response_codes)
    return {
        "ok": ok,
        "endpoint": endpoint,
        "searchedRequests": searched_requests,
    }


def sanitize_text(value: Any) -> str:
    # 错误信息仍需屏蔽凭证相关文本，但不要屏蔽 API 业务字段名。
    text = "" if value is None else str(value)
    text = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", text, flags=re.IGNORECASE)
    text = re.sub(r"(?i)(authorization|token|secret|jwt)\s*[:=]\s*\S+", r"\1=[redacted]", text)
    for key in SENSITIVE_ERROR_KEYS:
        text = re.sub(rf"(?i)\b{re.escape(key)}\b\s*[:=]\s*\S+", f"{key}=[redacted]", text)
    return text


def error_output(error_type: str, message: str, endpoint: str) -> dict[str, Any]:
    return {
        "ok": False,
        "endpoint": endpoint,
        "errorType": error_type,
        "message": sanitize_text(message),
    }


def print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    sys.exit(main())
