# flight-search ref

Use `flight_search` when the user describes route/date needs. If they provide complete flight number + airports + date + cabin, use `flight_pricing`.

## Inputs

Collect only route/date, passenger counts, cabin, and preferences. Defaults: 1 adult, economy, no airline restriction, no baggage guarantee. Do not collect name, birthday, ID/passport, phone, or email during search. Convert relative dates to `YYYY-MM-DD`.

## Tool Use

- Airport constraints: pass specified airport codes such as PEK/PKX/PVG/SHA, then hard-filter by actual route.
- Airline constraints: pass `includeAirlines` / `excludeAirlines` when clear, then hard-filter by IATA code.
- Nonstop: use `maxSegments: 1`; otherwise omit stop limit unless requested.
- Continuous multi-city routes become one `flight_search` with up to 5 `journeys[]`.
- Cheapest among multiple candidate dates: search one-way candidates and combine locally; use multi-journey round trip only when user needs one round-trip fare/order.

## Fast Path

For user-facing lists, filtering, sorting, recommendation, and option mapping, use only `data.displayOptions`.

- Do not parse raw MCP JSON, `data.solutions`, or `solutions[].segments` for search display.
- Default ranking: hard-filter first, then sort by `displayOptions[].priceTotal` low to high.
- Keep private option mapping from `displayOptions[].solutionId` for later `flight_verify_solution`.
- Never expose internal IDs, filtered-out IDs, raw JSON, or MCP fields.

## Lowest-Price Integrity（最低价完整性）

- Do not deduplicate by flight number, route, or time in a way that drops cheaper fare options.
- If the same flight combination / itinerary has multiple prices, cabin codes, or fare codes, keep the lowest-price option by default and recommend it.
- Default 10 options are selected from all displayable fare options sorted by `priceTotal`, not from folded flight combinations.
- If you collapse duplicate-looking flight combinations for readability, collapse only to the lowest `priceTotal` option and keep that exact option's `solutionId` private mapping.
- If showing multiple fare options for the same flight, every visible option number must map to its own `solutionId`; never reuse another fare option's mapping.

## Filtering And Ranking

- Hard filters: specified airport, airline include/exclude, max stops, and other explicit constraints.
- If hard filtering leaves no options, ask whether to relax constraints; do not silently show same-city alternatives.
- Default display: first 10 filtered/sorted options; if fewer than 10, show all and say only these matched.
- If user asks for N options, show N. If user asks for more, show the next 10. If user asks for all, explain there may be many and display in batches of 10.
- Default recommendation: lowest price, explicitly say it is lowest. If user asks for fastest/time window/airport/airline/baggage/fewer stops, recommend by that goal after hard filters.
- If a cheaper option violates a soft preference, mention briefly only when useful.

## Display

Use exactly 6 columns:

```markdown
| 选项 | 航班 | 行程 | 时间 | 舱位 | 价格 |
|---|---|---|---|---|---:|
| 1 | CA1714 | 北京首都 PEK T3 → 杭州 HGH T4 | 12:30-14:40｜直飞约2小时10分 | 经济舱 | ¥790 |
```

Rules:

- Option labels are plain numbers; recommendation stays outside the table.
- `航班` shows only complete flight numbers, no airline names.
- `行程` shows route/terminals when returned; expand common airport names when only IATA is returned, otherwise keep IATA.
- `舱位` may include returned cabin/fare code, e.g. `经济舱 / PP9`; do not invent codes.
- `价格` must be the current displayed option's `priceTotal`.
- Direct time format: `18:55-23:00｜直飞约5小时05分`.
- Multi-segment rows list every flight number and each segment time, e.g. `PEK→HKG 07:25-10:55；HKG→BKK 14:30-16:30｜中转1次约10小时05分`.
- Cross-date times show dates on affected times, e.g. `5/20 22:15-5/21 00:10`.
- If a segment time is missing, show `{origin}→{destination} 时间未返回`; do not invent it.
- Do not add baggage column; mention baggage only if user asks or verified result returns it.

## Footer And Handoff

End search results with:

> 你回复 1、2 等选项号，我先帮你确认实时价格。确认后如果继续预订，我再收集乘机人信息。你也可以继续补充筛选需求，比如航程偏好、航司、机场、时间段、价格上限或行李要求。

If more filtered options exist, add: `如需我也可以继续展示更多航班。`

When user selects an option, use the private option-to-`solutionId` mapping with `flight_verify_solution`. Say you will confirm real-time price first; do not call it "下单" or "付款".
