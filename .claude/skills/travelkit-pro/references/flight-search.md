# Flight Search and Pricing

Use this reference for general shopping, complex comparisons, known-flight pricing, ranking, lowest-fare deduplication, and option tracking. Natural-language parsing lives in `intent-analysis.md`; API field details live in `api-map.md`; user-facing table formats live in `output-rules.md`.

## Search Workflow

1. Collect only route, departure date, passenger counts, cabin, and search preferences. For complex, ambiguous, conflicting, flexible-date, round-trip, multi-city, conditional, or known-flight requests, first normalize the user's intent with `intent-analysis.md`.
2. For every agent-handled shopping/search, write a temporary JSON request file and run `python3 scripts/flight_search.py --request-file <path>` instead of calling `shopping` directly. The simple CLI form is only for manual local smoke tests, not agent workflow.
3. Use this request-file shape for simple and complex searches alike: `{ "searches": [{ "label": "单程", "journeys": [{ "origin": "BJS", "destination": "SHA", "departureDate": "2026-06-20" }], "passengers": { "adult": 1, "child": 0, "infant": 0 }, "cabinClass": "economy", "filters": {} }] }`. Map nonstop/direct -> `filters.maxSegments: 1`, max price -> `filters.maxPrice`, max duration -> `filters.maxDuration`, included/excluded airlines -> `filters.includeAirlines` / `filters.excludeAirlines`, checked baggage required -> `filters.mustHaveBag`.
4. Treat script stdout as agent-internal raw API input. Save it to a temporary JSON file, then run `python3 scripts/flight_search_compact.py --input <raw-json>` for ordinary search display preparation. Do not show raw envelopes to the user.
5. Use the compact script output as the default normalized source for ordinary search replies. It deduplicates repeated itineraries, extracts flight/airport/time/baggage/price fields, groups default recommendations by time section, and emits a private `displayMapping`.
6. When the user selects a displayed option, verify only the compact `displayMapping` entry's `solutionId` through `scripts/flight_verify_selected.py --compact-file <compact-json> --option <number>`, then proceed in `flight-booking.md`. Do not replace that selected script result with a solution from MCP `flight_search`, a fresh raw array index, or another shopping channel. Use verification output as the source of the latest booking `orderKey`.
7. Keep `solutionId`, `orderKey`, raw `data`, raw `solutions`, credentials, PNR, and ticket numbers internal.

## Complex Search

Handle these patterns by creating a `--request-file` for the search script:

- Simple one-way: create one `searches[]` entry with one `journeys[]` item.
- Explicit round trip: create one `searches[]` entry with two `journeys`: outbound `origin -> destination` on the departure date, and return `destination -> origin` on the return date. Do not split fixed-date round trips into separate one-way searches unless the combined request returns no usable result and the fallback is explained.
- Date range or flexible dates: create one `searches[]` entry per candidate date, with clear labels such as `6/20`, `6/21`, or `去程-6/20`.
- Multi-airport city: use city code first. If no results return, create another request file with common airport-code combinations and summarize which routes were tried.
- Time preferences: run the script first, then filter/rank normalized solutions locally by departure or arrival windows.
- Conditional searches: for example, "先查直飞，没有再看转机" means create a request file with `filters.maxSegments: 1` first; run transfer-allowed searches only if direct search returns no usable result.

When multiple calls are needed, summarize request assumptions, searched routes/dates, best 3-5 options, recommendation reason, and any routes/dates that returned no results. Fixed-date explicit round trips are not a multi-call case by default. If a single round-trip request returns no usable result and you fall back to separate outbound/return shopping calls, tell the user: `往返组合查询未返回可用结果，因此改为分别查去程/回程。` Keep every displayed option bound to its exact private solution mapping.

## Known-Flight Pricing Workflow

Use when the user supplies known flight numbers instead of asking for general search.

1. Collect flight number, origin, destination, date, cabin, journey index, passenger counts, and any requested booking code such as `Z`, `V`, `E`, `Q`, `T`, or `Y`.
2. Parse a requested concrete booking/sub-cabin code into internal `requestedBookingCode`, normalized to uppercase. Default missing cabin to `economy`; never send fare-bucket shortcuts as `cabinClass`.
3. Call `pricing` with only the full cabin class such as `economy`, `business`, or `first`; do not pass `requestedBookingCode` as an API request field or as `cabinClass`.
4. If `requestedBookingCode` is present, filter returned solutions after pricing by matching the relevant returned segment's `cabinCode == requestedBookingCode` or `subCabinCode == requestedBookingCode`.
5. If the user asks for checked baggage on a known flight and the matching priced solution has missing baggage rules, run a second `pricing` request for the same known flight with `mustHaveBag: true`, then filter the returned solutions by the same `requestedBookingCode`. Use baggage only from a matching cabin-code solution; never copy baggage allowance from another cabin code on the same flight.
6. When multiple solutions match the requested booking code, sort by the user's stated preference; if none is stated, present the lowest sellable matching solution. Do not replace a requested-code result with the lowest fare from another booking code.
7. If no solution matches the requested booking code, say the pricing response did not return the requested booking code, and do not infer airline inventory or availability outside the returned data. If a matching solution returns price but no baggage rules, say the price was returned but baggage was not returned or remains to be confirmed.
8. Present priced options using `output-rules.md`.
9. Keep returned `solutionId` internal and verify before booking.

## Baggage Transit

Use `baggage_transit` only when the user explicitly asks about baggage through-check, baggage transit, or interline baggage handling for a concrete itinerary. Summarize only returned baggage/transit facts; if the API does not return through-check details, say it was not returned.

## Ranking and Lowest Fare

- If the user states a clear preference such as lowest price, shortest duration, nonstop, morning departure, airport, airline, baggage, max price, no baggage, or unlimited transfer duration, filter/rank by that preference first.
- If the user does not state a display preference, use the default recommendation policy:
  - Deduplicate candidate solutions by the same flight combination, route, departure time, and arrival time before display.
  - Treat a solution as baggage-qualified only when the API returns checked baggage allowance for the itinerary. Missing baggage data is not baggage-qualified.
  - Display only baggage-qualified solutions in the recommendation section.
  - The default grouping is a user-visible output structure, not just an internal ranking detail. Ordinary and complex search replies must show four time sections in this order: `早 06:00-12:00`, `中 12:00-18:00`, `晚 18:00-24:00`, and `凌晨 24:00-06:00`.
  - For nonstop/direct solutions, group by first departure time and show up to the two cheapest options per group. If a group has no qualifying options, show the group with `无符合默认推荐条件的方案`.
  - For transfer solutions, show up to the two cheapest baggage-qualified options whose total itinerary duration is less than 8 hours in the group of their first departure time. If fewer qualifying options exist, show only the qualifying options that exist.
  - For complex one-way searches, group by the first departure time. For round-trip or multi-city searches, group by the first journey's first departure time.
  - If a no-checked-baggage or baggage-missing solution is cheaper than the cheapest baggage-qualified recommendation, show only the single cheapest such option as a low-price reminder, not as a recommendation.
  - Do not backfill recommendation slots with non-qualifying options, and do not output non-qualifying options unless the user explicitly asks for them.
- Explicit user preferences override the default time-section display. Examples include `只看最低价`, `只看下午`, `只要虹桥`, `不限行李`, `只看直飞`, and `只看转机`.
- For large result sets, sort and deduplicate compact normalized options rather than raw solution payloads.
- When the same flight combination, route, departure time, and arrival time appears with multiple fare options, display only the lowest sellable fare that satisfies the active user preference or default policy unless the user explicitly asks to compare fare products, rules, or cabin/fare-code differences.
- The displayed price, private `solutionId`, any returned private `orderKey`, and later verification must all refer to that same lowest fare solution.

## Fare Brand Presentation

Use this only when the API returns fare product fields such as `brandCode`, or when the user explicitly asks to compare fare products.

- Display `brandCode` as `票价产品`.
- Known labels: `BAS` -> `BAS（基础产品）`; `FLE` -> `FLE（灵活产品）`.
- If a fare brand code meaning is not confirmed, show the code and say benefits are based only on returned baggage, refund/change, and price fields.
- For the same flight and cabin with multiple fare products, highlight returned differences: price, checked baggage, refund/change rules, or other returned benefits.
- Do not pass `BAS`, `FLE`, or other fare brand codes as request `cabinClass`; use full cabin values such as `economy`.

## Large Result Handling

- `flight_search.py` stdout is raw; use `flight_search_compact.py` to normalize large ordinary search result sets before displaying results.
- `flight_search_compact.py` stdout is still internal. Use `displayOptions`, `sections`, and `lowPriceReminder` to compose the reply, and retain `displayMapping` for later verification.
- If the user asks for more, show the next compact batch, up to 10 options per reply.
- Complex searches should keep the final user-visible output compact after agent-side merging, usually 3-10 options depending on the user request.
- If more normalized candidates exist after the displayed list, say more options are available and invite filtering or the next batch.

## Selected Option Tracking

Every displayed option number must stay bound to the same internal solution object that produced the displayed flight number, itinerary, time, cabin, price, and baggage allowance.

- If options are sorted, filtered, grouped, or deduplicated before display, build the displayed mapping from the final displayed list.
- When the user selects an option, verify only the `solutionId` from that displayed mapping through the same script/direct-HTTP channel.
- Do not use the original raw `solutions[index]` after reordering, filtering, grouping, or deduplication.
- Do not switch to MCP search/verification to satisfy a selection from a script-generated display table. If the selected script solution is expired, re-run the script search and compact flow, present the refreshed options, and ask the user to choose again.
- Before verification, restate the selected displayed option with the user-visible ordinary search fields: flight number, itinerary, time, cabin, search price, and baggage allowance when returned. Keep `solutionId` hidden.
