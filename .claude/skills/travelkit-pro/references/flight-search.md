# Flight Search and Pricing

Use this reference for general shopping, complex comparisons, known-flight pricing, ranking, lowest-fare deduplication, and option tracking. Natural-language parsing lives in `intent-analysis.md`; API field details live in `api-map.md`; user-facing table formats live in `output-rules.md`.

## Search Workflow

1. Collect only route, departure date, passenger counts, cabin, and search preferences. For complex, ambiguous, conflicting, flexible-date, round-trip, multi-city, conditional, or known-flight requests, first normalize the user's intent with `intent-analysis.md`.
2. Call `shopping` with `journeys`, `passengers`, `cabinClass`, default `maxResultCount: 50`, and applicable optional filters. Send `maxSegments: 1` for nonstop/direct requests. Prefer request filters such as `maxPrice`, `includeAirlines`, `excludeAirlines`, `mustHaveBag`, and `maxDuration` when the user gives those preferences.
3. Normalize returned solutions before summarizing. Read only compact fields needed for display and verification: flight numbers, route, dates/times, duration, transfer count, cabin, baggage summary, computed total price, and private `solutionId` / `orderKey`.
4. Deduplicate identical itineraries to the lowest computed fare and keep a private displayed-option mapping to that exact `solutionId` / `orderKey`.
5. Rank results by user preference, then present user-safe options using `output-rules.md`.
6. Keep `solutionId` and `orderKey` internal.
7. When the user selects an option, proceed to verification in `flight-booking.md`.

## Complex Search

Handle these patterns by expanding into multiple shopping calls when needed:

- Round trip: create outbound and return journeys, or run separate searches and combine locally.
- Date range or flexible dates: run one shopping request per candidate date, then compare returned options.
- Multi-airport city: use city code first, then common airport-code combinations if no results.
- Time preferences: filter/rank returned journeys locally by departure or arrival windows.
- Conditional searches: for example, "先查直飞，没有再看转机" means search nonstop first, then transfer options only if needed.

When multiple calls are needed, summarize request assumptions, searched routes/dates, best 3-5 options, recommendation reason, and any routes/dates that returned no results. Keep every displayed option bound to its exact private solution mapping.

## Known-Flight Pricing Workflow

Use when the user supplies known flight numbers instead of asking for general search.

1. Collect flight number, origin, destination, date, cabin, journey index, and passenger counts.
2. Default missing cabin to `economy`; never send fare-bucket shortcuts as `cabinClass`.
3. Call `pricing`.
4. Present priced options using `output-rules.md`.
5. Keep returned `solutionId` internal and verify before booking.

## Baggage Transit

Use `baggage_transit` only when the user explicitly asks about baggage through-check, baggage transit, or interline baggage handling for a concrete itinerary. Summarize only returned baggage/transit facts; if the API does not return through-check details, say it was not returned.

## Ranking and Lowest Fare

- Default ranking is lowest total price unless the user states a stronger preference.
- If the user states a clear preference such as shortest duration, nonstop, morning departure, airport, airline, baggage, or max price, filter/rank by that preference first.
- For large result sets, sort and deduplicate compact normalized options rather than raw solution payloads.
- When the same flight combination, route, departure time, and arrival time appears with multiple fare options, display only the lowest sellable fare unless the user explicitly asks to compare fare products, rules, or cabin/fare-code differences.
- The displayed price, private `solutionId`, private `orderKey`, and later verification must all refer to that same lowest fare solution.

## Fare Brand Presentation

Use this only when the API returns fare product fields such as `brandCode`, or when the user explicitly asks to compare fare products.

- Display `brandCode` as `票价产品`.
- Known labels: `BAS` -> `BAS（基础产品）`; `FLE` -> `FLE（灵活产品）`.
- If a fare brand code meaning is not confirmed, show the code and say benefits are based only on returned baggage, refund/change, and price fields.
- For the same flight and cabin with multiple fare products, highlight returned differences: price, checked baggage, refund/change rules, or other returned benefits.
- Do not pass `BAS`, `FLE`, or other fare brand codes as request `cabinClass`; use full cabin values such as `economy`.

## Large Result Handling

- Ordinary search must request `maxResultCount: 50` by default and show Top 5 results.
- If the user asks for more, show the next compact batch, up to 10 options per reply.
- Complex searches must apply `maxResultCount` to every shopping request, keep only each request's local Top 3-5 compact options, then merge those compact candidates.
- If more normalized candidates exist after the displayed list, say more options are available and invite filtering or the next batch.

## Selected Option Tracking

Every displayed option number must stay bound to the same internal solution object that produced the displayed route, times, cabin, and price.

- If options are sorted, filtered, grouped, or deduplicated before display, build the displayed mapping from the final displayed list.
- When the user selects an option, verify only the `solutionId` from that displayed mapping.
- Do not use the original raw `solutions[index]` after reordering, filtering, grouping, or deduplication.
- Before verification, restate the selected displayed option with flight numbers, route, times, transfer count, and search price. Keep `solutionId` hidden.
