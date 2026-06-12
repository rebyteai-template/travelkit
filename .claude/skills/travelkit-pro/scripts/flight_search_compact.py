#!/usr/bin/env python3
"""Compact Simplifly shopping raw output into agent-ready display data.

This script is intentionally offline-only: it reads the JSON produced by
`flight_search.py`, normalizes fares/segments/baggage, deduplicates repeated
itineraries, and emits a smaller JSON document for agent rendering.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


TIME_SECTIONS = [
    ("早 06:00-12:00", 6 * 60, 12 * 60),
    ("中 12:00-18:00", 12 * 60, 18 * 60),
    ("晚 18:00-24:00", 18 * 60, 24 * 60),
    ("凌晨 24:00-06:00", 0, 6 * 60),
]

AIRPORT_NAMES = {
    "PEK": "北京首都",
    "PKX": "北京大兴",
    "SHA": "上海虹桥",
    "PVG": "上海浦东",
    "CAN": "广州白云",
    "SZX": "深圳宝安",
    "CTU": "成都双流",
    "TFU": "成都天府",
    "HGH": "杭州萧山",
    "NKG": "南京禄口",
    "WUH": "武汉天河",
    "XIY": "西安咸阳",
    "CKG": "重庆江北",
}

CABIN_NAMES = {
    "economy": "经济舱",
    "premium_economy": "高端经济舱",
    "business": "商务舱",
    "premium_business": "高端商务舱",
    "first": "头等舱",
    "premium_first": "高端头等舱",
}

SENSITIVE_KEYS = {
    "authorization",
    "bearer",
    "jwt",
    "token",
    "secret",
    "pnr",
    "airlinePnr",
    "ticketNo",
}


class CompactError(Exception):
    pass


def main() -> int:
    args = parse_args()
    try:
        raw = read_json(Path(args.input))
        compact = compact_search_output(raw, args.max_per_section, args.transfer_max_minutes)
        print_json(compact, Path(args.output) if args.output else None)
        return 0 if compact.get("ok") else 2
    except CompactError as exc:
        print_json({"ok": False, "errorType": "compact_error", "message": sanitize_text(str(exc))}, None)
        return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compact flight_search.py raw JSON into display-ready JSON.")
    parser.add_argument("--input", required=True, help="Path to flight_search.py raw JSON output")
    parser.add_argument("--output", help="Optional output JSON path. Defaults to stdout.")
    parser.add_argument("--max-per-section", type=int, default=2, help="Recommended options per time section")
    parser.add_argument(
        "--transfer-max-minutes",
        type=int,
        default=8 * 60,
        help="Maximum total duration for transfer options in default recommendations",
    )
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise CompactError(f"Cannot read input JSON: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise CompactError(f"Input is not valid JSON: {exc.msg}") from exc
    if not isinstance(value, dict):
        raise CompactError("Input JSON must be an object.")
    return value


def compact_search_output(raw: dict[str, Any], max_per_section: int, transfer_max_minutes: int) -> dict[str, Any]:
    if max_per_section <= 0:
        raise CompactError("--max-per-section must be greater than zero.")
    if transfer_max_minutes <= 0:
        raise CompactError("--transfer-max-minutes must be greater than zero.")

    searched = raw.get("searchedRequests")
    if not isinstance(searched, list):
        raise CompactError("Input JSON is missing searchedRequests[].")

    compact_requests = []
    global_options = []
    global_mapping = {}
    next_option_number = 1

    for request in searched:
        compact_request = compact_searched_request(request, max_per_section, transfer_max_minutes)
        renumbered_options = []
        renumbered_mapping = {}
        for option in compact_request["displayOptions"]:
            old_number = str(option["optionNumber"])
            new_number = next_option_number
            next_option_number += 1
            option = dict(option)
            option["optionNumber"] = new_number
            renumbered_options.append(option)
            renumbered_mapping[str(new_number)] = compact_request["displayMapping"][old_number]
            global_options.append(option)
            global_mapping[str(new_number)] = compact_request["displayMapping"][old_number]

        compact_request["displayOptions"] = renumbered_options
        compact_request["displayMapping"] = renumbered_mapping
        compact_requests.append(compact_request)

    return {
        "ok": raw.get("ok") is True and all(item.get("ok") for item in compact_requests),
        "endpoint": raw.get("endpoint"),
        "searchedRequests": compact_requests,
        "displayOptions": global_options,
        "displayMapping": global_mapping,
        "summary": {
            "searchCount": len(compact_requests),
            "displayOptionCount": len(global_options),
        },
    }


def compact_searched_request(
    request: dict[str, Any],
    max_per_section: int,
    transfer_max_minutes: int,
) -> dict[str, Any]:
    raw_response = request.get("rawResponse") or {}
    data = raw_response.get("data") or {}
    segments = data.get("segments") or {}
    solutions = data.get("solutions") or []
    warnings = []

    if not isinstance(segments, dict):
        segments = {}
        warnings.append("rawResponse.data.segments was not an object.")
    if not isinstance(solutions, list):
        solutions = []
        warnings.append("rawResponse.data.solutions was not an array.")

    candidates = []
    for index, solution in enumerate(solutions):
        if not isinstance(solution, dict):
            continue
        candidate = normalize_solution(solution, segments, index, warnings)
        if candidate is not None:
            candidates.append(candidate)

    baggage_candidates = dedupe_candidates([item for item in candidates if item["hasCheckedBaggage"]])
    all_candidates = dedupe_candidates(candidates)
    recommendation_candidates = [
        item
        for item in baggage_candidates
        if item["transferCount"] == 0 or item["durationMinutes"] <= transfer_max_minutes
    ]

    sections = []
    selected = []
    for label, start_minute, end_minute in TIME_SECTIONS:
        section_candidates = [
            item
            for item in recommendation_candidates
            if start_minute <= item["firstDepartureMinute"] < end_minute
        ]
        options = sorted(section_candidates, key=sort_key)[:max_per_section]
        selected.extend((label, option) for option in options)
        sections.append(
            {
                "label": label,
                "options": [public_option(item, 0, section=label) for item in options],
                "empty": not options,
            }
        )

    selected_candidates = [item for _, item in selected]
    cheapest_recommended = min((item["price"]["amount"] for item in selected_candidates), default=None)
    low_price_reminder = None
    if cheapest_recommended is not None:
        no_bag_candidates = [
            item
            for item in all_candidates
            if not item["hasCheckedBaggage"] and item["price"]["amount"] < cheapest_recommended
        ]
        if no_bag_candidates:
            low_price_reminder = sorted(no_bag_candidates, key=sort_key)[0]

    display_items = selected + ([("低价提醒", low_price_reminder)] if low_price_reminder else [])
    display_options = []
    display_mapping = {}
    for number, (section, item) in enumerate(display_items, start=1):
        display_options.append(public_option(item, number, section=section))
        display_mapping[str(number)] = private_mapping(item)

    return {
        "ok": request.get("responseCode") == 0,
        "searchIndex": request.get("searchIndex"),
        "searchLabel": request.get("searchLabel"),
        "request": request.get("request"),
        "responseCode": request.get("responseCode"),
        "message": sanitize_text(request.get("message") or ""),
        "candidateCount": len(candidates),
        "uniqueCandidateCount": len(all_candidates),
        "sections": sections,
        "lowPriceReminder": public_option(low_price_reminder, 0) if low_price_reminder else None,
        "displayOptions": display_options,
        "displayMapping": display_mapping,
        "warnings": warnings,
    }


def normalize_solution(
    solution: dict[str, Any],
    segment_lookup: dict[str, Any],
    solution_index: int,
    warnings: list[str],
) -> dict[str, Any] | None:
    price = compute_price(solution.get("priceDetail") or {})
    if price is None:
        warnings.append(f"solutions[{solution_index}] skipped: no derivable price.")
        return None

    journeys = solution.get("journeys")
    if not isinstance(journeys, list) or not journeys:
        warnings.append(f"solutions[{solution_index}] skipped: no journeys.")
        return None

    normalized_journeys = []
    all_segment_keys = []
    checked_summaries = []
    cabin_parts = []
    first_departure_minute = None
    total_duration_minutes = 0
    transfer_count = 0

    for journey_index, journey in enumerate(journeys):
        if not isinstance(journey, dict):
            warnings.append(f"solutions[{solution_index}].journeys[{journey_index}] skipped: invalid journey.")
            return None
        segment_refs = journey.get("segments")
        if not isinstance(segment_refs, list) or not segment_refs:
            warnings.append(f"solutions[{solution_index}] skipped: journey has no segments.")
            return None

        normalized_segments = []
        journey_checked = []
        for segment_ref in segment_refs:
            if not isinstance(segment_ref, dict):
                return None
            segment_id = segment_ref.get("coreSegmentId")
            segment = segment_lookup.get(segment_id)
            if not isinstance(segment, dict):
                warnings.append(f"solutions[{solution_index}] skipped: missing segment {segment_id}.")
                return None

            normalized_segment = normalize_segment(segment, segment_ref)
            normalized_segments.append(normalized_segment)
            all_segment_keys.append(
                (
                    normalized_segment["flightNo"],
                    normalized_segment["departure"],
                    normalized_segment["arrival"],
                    normalized_segment["departureDate"],
                    normalized_segment["departureTime"],
                    normalized_segment["arrivalDate"],
                    normalized_segment["arrivalTime"],
                )
            )
            journey_checked.append(normalized_segment["checkedBaggage"])
            cabin_parts.append(normalized_segment["cabin"])

        departure_minute = time_to_minutes(normalized_segments[0]["departureTime"])
        if first_departure_minute is None:
            first_departure_minute = departure_minute
        journey_duration = duration_to_minutes(journey.get("duration")) or sum(
            duration_to_minutes(segment["flightTime"]) or 0 for segment in normalized_segments
        )
        total_duration_minutes += journey_duration
        transfer_count += max(len(normalized_segments) - 1, int_or_zero(journey.get("transferNum")))
        checked_summaries.extend(journey_checked)

        normalized_journeys.append(
            {
                "journeyIndex": journey_index + 1,
                "origin": journey.get("origin"),
                "destination": journey.get("destination"),
                "departureDate": normalized_segments[0]["departureDate"],
                "departureTime": normalized_segments[0]["departureTime"],
                "arrivalDate": normalized_segments[-1]["arrivalDate"],
                "arrivalTime": normalized_segments[-1]["arrivalTime"],
                "duration": minutes_to_duration(journey_duration),
                "durationMinutes": journey_duration,
                "transferCount": max(len(normalized_segments) - 1, int_or_zero(journey.get("transferNum"))),
                "segments": normalized_segments,
            }
        )

    has_checked = bool(checked_summaries) and all(item for item in checked_summaries)
    baggage_display = summarize_baggage(checked_summaries) if has_checked else "无托运/未返回"
    cabin_display = summarize_cabin(cabin_parts)
    first_journey = normalized_journeys[0]
    last_journey = normalized_journeys[-1]

    return {
        "dedupeKey": (
            tuple(all_segment_keys),
            first_journey["departureDate"],
            first_journey["departureTime"],
            last_journey["arrivalDate"],
            last_journey["arrivalTime"],
        ),
        "solutionId": solution.get("solutionId"),
        "source": solution.get("source"),
        "journeys": normalized_journeys,
        "price": price,
        "cabin": cabin_display,
        "baggage": baggage_display,
        "hasCheckedBaggage": has_checked,
        "duration": minutes_to_duration(total_duration_minutes),
        "durationMinutes": total_duration_minutes,
        "transferCount": transfer_count,
        "firstDepartureMinute": first_departure_minute if first_departure_minute is not None else 0,
    }


def normalize_segment(segment: dict[str, Any], segment_ref: dict[str, Any]) -> dict[str, Any]:
    checked = checked_baggage(segment_ref)
    cabin_class = segment_ref.get("cabinClass")
    cabin_code = segment_ref.get("cabinCode") or segment_ref.get("subCabinCode") or "待确认"
    return {
        "flightNo": segment.get("flightNo") or "",
        "operatingFlightNo": segment.get("opFlightNo") or "",
        "departure": segment.get("departure") or "",
        "departureName": airport_display(segment.get("departure")),
        "departureDate": segment.get("departureDate") or "",
        "departureTime": segment.get("departureTime") or "",
        "departureTerminal": segment.get("departureTerminal") or "",
        "arrival": segment.get("arrival") or "",
        "arrivalName": airport_display(segment.get("arrival")),
        "arrivalDate": segment.get("arrivalDate") or "",
        "arrivalTime": segment.get("arrivalTime") or "",
        "arrivalTerminal": segment.get("arrivalTerminal") or "",
        "flightTime": segment.get("flightTime") or "",
        "cabin": f"{CABIN_NAMES.get(str(cabin_class), str(cabin_class or '舱位待确认'))} {cabin_code}舱",
        "checkedBaggage": checked,
    }


def compute_price(price_detail: dict[str, Any]) -> dict[str, Any] | None:
    price_list = price_detail.get("priceList")
    if isinstance(price_list, list) and price_list:
        total = 0.0
        has_value = False
        currency = None
        for item in price_list:
            if not isinstance(item, dict):
                continue
            count = int_or_one(item.get("num"))
            currency = currency or item.get("currency")
            if item.get("publishPrice") is not None:
                total += (float(item["publishPrice"]) + float(item.get("tax") or 0)) * count
                has_value = True
            elif item.get("salePrice") is not None:
                total += float(item["salePrice"]) * count
                has_value = True
            elif item.get("price") is not None:
                total += (float(item.get("price") or 0) + float(item.get("tax") or 0)) * count
                has_value = True
        if has_value:
            return normalize_price(total, currency or price_detail.get("currency") or "CNY")
    if price_detail.get("priceTotal") is not None:
        return normalize_price(float(price_detail["priceTotal"]), price_detail.get("currency") or "CNY")
    return None


def normalize_price(amount: float, currency: Any) -> dict[str, Any]:
    rounded = int(amount) if amount.is_integer() else round(amount, 2)
    return {
        "amount": rounded,
        "currency": str(currency or "CNY"),
        "display": f"¥{rounded}" if str(currency or "CNY").upper() == "CNY" else f"{currency} {rounded}",
    }


def checked_baggage(segment_ref: dict[str, Any]) -> str | None:
    rules = segment_ref.get("baggageRules")
    if not isinstance(rules, list) or not rules:
        return None
    first_rule = rules[0]
    if not isinstance(first_rule, dict):
        return None
    checked = first_rule.get("checked")
    if not isinstance(checked, dict):
        return None
    pieces = checked.get("pieces")
    weight = checked.get("weight")
    unit = str(checked.get("unit") or "kg").lower()
    if pieces and weight:
        return f"{pieces}件，{weight}{unit}/件"
    if pieces:
        return f"{pieces}件"
    if weight:
        return f"{weight}{unit}"
    return None


def dedupe_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    best: dict[Any, dict[str, Any]] = {}
    for candidate in candidates:
        key = candidate["dedupeKey"]
        old = best.get(key)
        if old is None or sort_key(candidate) < sort_key(old):
            best[key] = candidate
    return list(best.values())


def public_option(candidate: dict[str, Any] | None, option_number: int, section: str | None = None) -> dict[str, Any] | None:
    if candidate is None:
        return None
    option = {
        "optionNumber": option_number,
        "section": section,
        "journeyType": journey_type(candidate),
        "journeys": candidate["journeys"],
        "duration": candidate["duration"],
        "durationMinutes": candidate["durationMinutes"],
        "cabin": candidate["cabin"],
        "baggage": candidate["baggage"],
        "hasCheckedBaggage": candidate["hasCheckedBaggage"],
        "price": candidate["price"],
    }
    return option


def private_mapping(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "solutionId": candidate.get("solutionId"),
        "source": candidate.get("source"),
        "journeys": candidate["journeys"],
        "price": candidate["price"],
        "cabin": candidate["cabin"],
        "baggage": candidate["baggage"],
        "hasCheckedBaggage": candidate["hasCheckedBaggage"],
    }


def journey_type(candidate: dict[str, Any]) -> str:
    if len(candidate["journeys"]) == 1:
        return "单程直飞" if candidate["transferCount"] == 0 else f"单程中转{candidate['transferCount']}次"
    return "多程"


def summarize_baggage(values: list[str | None]) -> str:
    unique = sorted({value for value in values if value})
    if not unique:
        return "无托运/未返回"
    if len(unique) == 1:
        return unique[0]
    return "；".join(unique)


def summarize_cabin(values: list[str]) -> str:
    unique = []
    for value in values:
        if value and value not in unique:
            unique.append(value)
    if not unique:
        return "舱位待确认"
    if len(unique) == 1:
        return unique[0]
    return "；".join(unique)


def airport_display(code: Any) -> str:
    text = str(code or "")
    if not text:
        return ""
    return f"{AIRPORT_NAMES.get(text, text)}({text})"


def sort_key(candidate: dict[str, Any]) -> tuple[Any, ...]:
    return (
        candidate["price"]["amount"],
        candidate["durationMinutes"],
        candidate["firstDepartureMinute"],
        candidate["journeys"][0]["segments"][0]["flightNo"],
    )


def time_to_minutes(value: Any) -> int:
    match = re.match(r"^(\d{1,2}):(\d{2})$", str(value or ""))
    if not match:
        return 0
    return int(match.group(1)) * 60 + int(match.group(2))


def duration_to_minutes(value: Any) -> int:
    match = re.match(r"^(?:(\d+)h)?(?:(\d+)m)?$", str(value or ""))
    if not match:
        return 0
    return int(match.group(1) or 0) * 60 + int(match.group(2) or 0)


def minutes_to_duration(value: int) -> str:
    hours, minutes = divmod(max(value, 0), 60)
    if hours and minutes:
        return f"{hours}h{minutes}m"
    if hours:
        return f"{hours}h"
    return f"{minutes}m"


def int_or_zero(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def int_or_one(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 1
    return parsed if parsed > 0 else 1


def sanitize_text(value: Any) -> str:
    text = "" if value is None else str(value)
    text = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", text, flags=re.IGNORECASE)
    for key in SENSITIVE_KEYS:
        text = re.sub(rf"(?i)\b{re.escape(key)}\b\s*[:=]\s*\S+", f"{key}=[redacted]", text)
    return text


def print_json(value: dict[str, Any], output_path: Path | None) -> None:
    rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    if output_path:
        output_path.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)


if __name__ == "__main__":
    sys.exit(main())
