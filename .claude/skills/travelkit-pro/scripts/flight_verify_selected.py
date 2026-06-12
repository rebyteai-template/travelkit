#!/usr/bin/env python3
"""Verify a displayed shopping option from flight_search_compact.py.

The compact display mapping is the source of truth for option selection. This
script reads the selected option's private solutionId and verifies that exact
solution through the same direct Simplifly HTTP configuration used by
flight_search.py.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import flight_search  # noqa: E402
import flight_search_compact  # noqa: E402


VERIFY_ENDPOINT_TEMPLATE = "/openapi/v3/flight/solutions/{solution_id}/verification"
EXPIRED_CODES = {"207013"}


class VerifySelectedError(Exception):
    pass


def main() -> int:
    args = parse_args()
    try:
        compact = read_json(Path(args.compact_file))
        selected = selected_mapping(compact, args.option)
        passenger_count = {
            "adult": args.adult,
            "child": args.child,
            "infant": args.infant,
        }
        result = verify_selected_option(selected, passenger_count)
        print_json(result, Path(args.output) if args.output else None)
        return 0 if result.get("ok") else 2
    except (VerifySelectedError, flight_search.ConfigError, flight_search.NetworkError, flight_search.ResponseParseError) as exc:
        print_json({"ok": False, "errorType": "verify_selected_error", "message": flight_search.sanitize_text(str(exc))}, None)
        return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify a selected flight_search_compact display option.")
    parser.add_argument("--compact-file", required=True, help="JSON file produced by flight_search_compact.py")
    parser.add_argument("--option", required=True, help="Displayed option number to verify")
    parser.add_argument("--adult", type=int, default=1, help="Adult passenger count, default: 1")
    parser.add_argument("--child", type=int, default=0, help="Child passenger count, default: 0")
    parser.add_argument("--infant", type=int, default=0, help="Infant passenger count, default: 0")
    parser.add_argument("--output", help="Optional output JSON path. Defaults to stdout.")
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise VerifySelectedError(f"Cannot read compact JSON: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise VerifySelectedError(f"Compact JSON is not valid JSON: {exc.msg}") from exc
    if not isinstance(value, dict):
        raise VerifySelectedError("Compact JSON must be an object.")
    return value


def selected_mapping(compact: dict[str, Any], option: str) -> dict[str, Any]:
    mapping = compact.get("displayMapping")
    if not isinstance(mapping, dict):
        raise VerifySelectedError("Compact JSON is missing displayMapping.")
    selected = mapping.get(str(option))
    if not isinstance(selected, dict):
        raise VerifySelectedError(f"Option {option} was not found in displayMapping.")
    solution_id = selected.get("solutionId")
    if not isinstance(solution_id, str) or not solution_id:
        raise VerifySelectedError(f"Option {option} has no valid solutionId.")
    return selected


def verify_selected_option(selected: dict[str, Any], passenger_count: dict[str, int]) -> dict[str, Any]:
    solution_id = selected["solutionId"]
    request_body = {
        "solutionId": solution_id,
        "passengerCount": passenger_count,
    }
    endpoint = VERIFY_ENDPOINT_TEMPLATE.format(solution_id=solution_id)
    payload, http_status = flight_search.post_json(flight_search.load_config(), endpoint, request_body)
    response_code = payload.get("code")
    data = payload.get("data") if isinstance(payload, dict) else None
    verified = summarize_verified_solution(data) if isinstance(data, dict) else None
    selected_summary = summarize_selected_mapping(selected)
    comparison = compare_summaries(selected_summary, verified)
    error_type = classify_error(response_code, payload.get("message") or payload.get("realMessage") or "")

    return {
        "ok": response_code == 0,
        "endpoint": endpoint,
        "httpStatus": http_status,
        "responseCode": response_code,
        "message": flight_search.sanitize_text(payload.get("message") or payload.get("realMessage") or ""),
        "errorType": error_type,
        "request": {
            "solutionId": solution_id,
            "passengerCount": passenger_count,
        },
        "selectedOption": selected_summary,
        "verifiedOption": verified,
        "comparison": comparison,
        "orderKey": data.get("orderKey") if isinstance(data, dict) else None,
        "rawResponse": payload,
    }


def classify_error(response_code: Any, message: str) -> str | None:
    if response_code == 0:
        return None
    if str(response_code) in EXPIRED_CODES or "搜索已过期" in str(message):
        return "expired_search"
    return "verification_failed"


def summarize_selected_mapping(selected: dict[str, Any]) -> dict[str, Any]:
    return {
        "solutionId": selected.get("solutionId"),
        "source": selected.get("source"),
        "flights": flight_numbers_from_journeys(selected.get("journeys")),
        "journeys": selected.get("journeys") if isinstance(selected.get("journeys"), list) else [],
        "price": selected.get("price"),
        "cabin": selected.get("cabin"),
        "baggage": selected.get("baggage"),
        "hasCheckedBaggage": selected.get("hasCheckedBaggage"),
    }


def summarize_verified_solution(data: dict[str, Any]) -> dict[str, Any]:
    journeys = data.get("journeys") if isinstance(data.get("journeys"), list) else []
    segments_lookup = data.get("segments") if isinstance(data.get("segments"), dict) else {}
    normalized_journeys = []
    cabin_parts = []
    checked_summaries = []

    for journey_index, journey in enumerate(journeys):
        if not isinstance(journey, dict):
            continue
        segment_refs = journey.get("segments") if isinstance(journey.get("segments"), list) else []
        normalized_segments = []
        for segment_ref in segment_refs:
            if not isinstance(segment_ref, dict):
                continue
            segment = segment_from_ref(segment_ref, segments_lookup, journey)
            normalized_segment = flight_search_compact.normalize_segment(segment, segment_ref)
            normalized_segments.append(normalized_segment)
            cabin_parts.append(normalized_segment["cabin"])
            checked_summaries.append(normalized_segment["checkedBaggage"])
        if not normalized_segments:
            continue
        duration_minutes = flight_search_compact.duration_to_minutes(journey.get("duration")) or sum(
            flight_search_compact.duration_to_minutes(segment["flightTime"]) or 0 for segment in normalized_segments
        )
        normalized_journeys.append(
            {
                "journeyIndex": journey_index + 1,
                "origin": journey.get("origin"),
                "destination": journey.get("destination"),
                "departureDate": normalized_segments[0]["departureDate"],
                "departureTime": normalized_segments[0]["departureTime"],
                "arrivalDate": normalized_segments[-1]["arrivalDate"],
                "arrivalTime": normalized_segments[-1]["arrivalTime"],
                "duration": flight_search_compact.minutes_to_duration(duration_minutes),
                "durationMinutes": duration_minutes,
                "transferCount": max(len(normalized_segments) - 1, flight_search_compact.int_or_zero(journey.get("transferNum"))),
                "segments": normalized_segments,
            }
        )

    has_checked = bool(checked_summaries) and all(item for item in checked_summaries)
    return {
        "solutionId": data.get("solutionId"),
        "source": data.get("source"),
        "flights": flight_numbers_from_journeys(normalized_journeys),
        "journeys": normalized_journeys,
        "price": flight_search_compact.compute_price(data.get("priceDetail") or {}),
        "priceBreakdownDisplay": price_breakdown_display(data.get("priceDetail") or {}),
        "cabin": flight_search_compact.summarize_cabin(cabin_parts),
        "baggage": flight_search_compact.summarize_baggage(checked_summaries) if has_checked else "无托运/未返回",
        "hasCheckedBaggage": has_checked,
    }


def price_breakdown_display(price_detail: dict[str, Any]) -> str | None:
    price_list = price_detail.get("priceList")
    if not isinstance(price_list, list) or not price_list:
        return None
    parts = []
    for item in price_list:
        if not isinstance(item, dict):
            continue
        count = flight_search_compact.int_or_one(item.get("num"))
        currency = item.get("currency") or price_detail.get("currency") or "CNY"
        if item.get("publishPrice") is not None:
            fare = float(item["publishPrice"]) * count
            tax = float(item.get("tax") or 0) * count
            parts.append(f"票价 {format_money(fare, currency)} + 税费 {format_money(tax, currency)}")
        elif item.get("salePrice") is not None:
            parts.append(f"价格 {format_money(float(item['salePrice']) * count, currency)}")
        elif item.get("price") is not None:
            fare = float(item.get("price") or 0) * count
            tax = float(item.get("tax") or 0) * count
            parts.append(f"价格 {format_money(fare + tax, currency)}")
    return "；".join(parts) if parts else None


def format_money(amount: float, currency: Any) -> str:
    rounded = int(amount) if amount.is_integer() else round(amount, 2)
    return f"¥{rounded}" if str(currency or "CNY").upper() == "CNY" else f"{currency} {rounded}"


def segment_from_ref(segment_ref: dict[str, Any], segments_lookup: dict[str, Any], journey: dict[str, Any]) -> dict[str, Any]:
    segment_id = segment_ref.get("coreSegmentId")
    segment = segments_lookup.get(segment_id)
    if isinstance(segment, dict):
        return segment
    parsed = parse_core_segment_id(str(segment_id or ""))
    return {
        "id": segment_id,
        "flightNo": parsed.get("flightNo") or "",
        "departure": parsed.get("departure") or "",
        "arrival": parsed.get("arrival") or "",
        "departureDate": journey.get("departureDate") or "",
        "arrivalDate": journey.get("arrivalDate") or "",
        "departureTime": journey.get("departureTime") or "",
        "arrivalTime": journey.get("arrivalTime") or "",
        "flightTime": journey.get("duration") or "",
        "departureTerminal": "",
        "arrivalTerminal": "",
        "opFlightNo": "",
    }


def parse_core_segment_id(segment_id: str) -> dict[str, str]:
    parts = segment_id.split("-")
    if len(parts) >= 4:
        return {
            "departure": parts[1],
            "arrival": parts[2],
            "flightNo": parts[3],
        }
    return {}


def flight_numbers_from_journeys(journeys: Any) -> list[str]:
    flights = []
    if not isinstance(journeys, list):
        return flights
    for journey in journeys:
        if not isinstance(journey, dict):
            continue
        segments = journey.get("segments") if isinstance(journey.get("segments"), list) else []
        for segment in segments:
            if isinstance(segment, dict) and segment.get("flightNo"):
                flights.append(str(segment["flightNo"]))
    return flights


def compare_summaries(selected: dict[str, Any], verified: dict[str, Any] | None) -> dict[str, Any]:
    if verified is None:
        return {
            "verified": False,
            "changed": None,
            "changedFields": [],
        }
    field_pairs = {
        "flights": (selected.get("flights"), verified.get("flights")),
        "price": (amount_of(selected.get("price")), amount_of(verified.get("price"))),
        "cabin": (selected.get("cabin"), verified.get("cabin")),
        "baggage": (selected.get("baggage"), verified.get("baggage")),
        "hasCheckedBaggage": (selected.get("hasCheckedBaggage"), verified.get("hasCheckedBaggage")),
    }
    changed_fields = [field for field, (before, after) in field_pairs.items() if before != after]
    return {
        "verified": True,
        "changed": bool(changed_fields),
        "changedFields": changed_fields,
        "fields": {
            field: {"selected": before, "verified": after}
            for field, (before, after) in field_pairs.items()
        },
    }


def amount_of(price: Any) -> Any:
    return price.get("amount") if isinstance(price, dict) else None


def print_json(value: dict[str, Any], output_path: Path | None) -> None:
    text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    if output_path:
        output_path.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)


if __name__ == "__main__":
    sys.exit(main())
