# Flight Intent Analysis

Use this reference to normalize natural-language flight requirements before calling Simplifly Flight OpenAPI. This file only covers requirement parsing and query-condition normalization. It does not define authentication, verification, order creation, payment, refund, change, or any write operation behavior.

## Workflow

1. Decide whether the user request can be normalized into executable search or pricing inputs.
2. If a flight number is abnormal and the original request includes date, route, or time context, try current flight-data or validation capabilities first when available.
3. If a critical field is missing, conflicting, or abnormal and cannot be reasonably inferred, ask one concise confirmation question; 一次只问一个问题.
4. During confirmation, ask only the current question. Do not output JSON, full extracted fields, internal identifiers, or summaries.
5. After the user confirms the current item, continue with the next missing or conflicting item only if needed.
6. When no confirmation is needed, normalize the request into route, date, passenger count, cabin, and preference inputs for shopping or pricing.

## Final Output Shape

When confirmation is complete or unnecessary, output queryable fields. If the user asks for JSON, use compact JSON. If the user asks for a Chinese description, use these fields when applicable:

```text
查询意图：
行程类型：
人数/分组：
航段：
舱位：
航司/航班：
机场/三字码：
时间偏好：
直飞/转机：
行李要求：
价格/库存策略：
查询组合建议：
推断信息：
缺失/歧义：
修正记录：
```

JSON should include: `status`, `request_intent`, `trip_type`, `passenger_groups`, `segments`, `pricing_preference`, `itinerary_recombination_options`, `inferences`, `missing_fields`, `ambiguities`, and `correction_log`. Each segment should include date, origin/city or airport code, destination/city or airport code, flight number, airline, cabin, time, nonstop/transfer preference, baggage, and notes when available.

## Extracted Intent

Identify these fields when present:

- Query intent: search price, compare fares, check availability, holdable option, lowest price, itinerary proposal, known-flight pricing.
- Trip type: one-way, round trip, multi-city, or open-jaw.
- Passenger groups: passenger count, passenger type, group or batch names when supplied.
- Segments: date, origin, destination, airport or city code, airline, flight number, departure time, arrival time.
- Cabin: economy, premium economy, business, first, mixed cabin, default economy, and requested concrete booking code when present.
- Date flexibility: "左右", alternatives, date ranges, stay length, fixed dates, or flexible return dates.
- Preferences and constraints: morning departure, afternoon arrival, earliest return, nonstop, transfer allowed, airport, airline, checked baggage, lowest price, shortest duration, fewer stops, or holdable inventory.
- Query combination advice: original multi-city, recomposed round trips or open-jaw options, split-ticket candidates, and estimated ticket count.
- Inferences, missing fields, ambiguities, and user corrections.

## Defaults And Inference

- If the user does not specify cabin, use `cabinClass: economy` and mark "用户未指定，默认经济舱". Map "经济舱" and "economy cabin" to `economy`; do not use fare-bucket shortcuts such as `Y` as `cabinClass`.
- If the user specifies a concrete booking code such as `经济Z舱`, `经济 V`, `V舱`, or `economy Q class`, parse it as `requestedBookingCode` normalized to uppercase, while keeping `cabinClass` as the full cabin such as `economy`. If only a booking code is given, default `cabinClass` to `economy` and mark that as the executable default. If the user pairs an uncommon cabin and booking code, such as `商务V舱`, preserve the stated full cabin and booking code instead of correcting it without evidence.
- If the user does not specify passenger count, mark the parsed requirement as "用户未提供". For executable search and verification planning, use 1 adult as the default and state this execution default when needed.
- If the user provides a city with multiple airports, use the city code first when available. If no results return, try common airport-code combinations and summarize which routes were tried.
- If a round trip has a stay length but no exact return date, infer the return date from the stay length. 停留天数推返程日期时，the departure date counts as day 1, so return date equals departure date plus stay days minus 1.
- If the return destination is omitted but the outbound origin or normal return point is clear from context, infer that destination for a searchable return.
- If the user says "左右" or gives a flexible date range, create candidate dates and compare results after shopping.
- If text appears inconsistent, first decide whether the later text is a supplement, correction, relaxed constraint, conditional strategy, or alternative. Ask only when priority cannot be determined.
- Do not fabricate airline, flight number, baggage, fare rule, price, or availability data. Mark inferred values and only use API-returned data for commercial facts.

## Phrase Interpretation

- "或者", "也可以", "都可以": treat as alternatives to compare.
- "改成", "换成", "以这个为准": treat later text as a correction.
- "这个必须是": treat the field as a hard constraint.
- "如果没有...就...": treat as a conditional search strategy.
- "回程没有的话，就经济": apply the fallback only to the return segment.
- "先查直飞，没有再看转机": search nonstop first, then transfer options if needed.
- "都帮我看下": compare all reasonable alternatives.
- "待一周再回来" or similar stay-length wording: infer a return date or return date range before shopping.

## Itinerary Recombination

When the user provides continuous multi-leg travel, keep the original segments in the parsed facts and also identify whether there are better query combinations. Fewer ticket numbers or ticket books often produce better fares or more stable rules, but this must remain a query candidate and never be stated as guaranteed cheaper.

- For closed or near-closed trips such as A -> B, B -> C, C -> A, check whether the request can be searched as two round trips or one round trip plus one-way.
- For open-jaw returns such as A -> B, C -> A, check whether it can be searched as an open-jaw round trip around the origin and destination region.
- If the user includes surface travel or intermediate travel between destinations, compare the original multi-city query with recomposed round-trip or split-ticket candidates.
- When clear recombination candidates exist, make them the main query candidates and put the original multi-city interpretation in `推断信息` / `inferences` with the recombination rationale.
- For each candidate, state the query combination, covered segments, estimated ticket count, and why it may be worth checking. Always say the final result still requires actual fare search.
- Example: 北京 -> 首尔, 首尔 -> 上海, 上海 -> 首尔, 首尔 -> 北京 can be checked as "北京往返首尔" plus "首尔往返上海" because two round-trip ticket numbers may price better than four separate multi-city legs.

## Confirmation Rules

Ask for confirmation only when the request has a critical error, an executable conflict, or a required search field that cannot be inferred.

Confirm these cases:

- Abnormal airport or city codes that cannot be safely normalized.
- Missing departure date, origin, or destination that cannot be inferred from context.
- Conflicting values for the same field where priority is unclear.
- Passenger group totals that contradict each other.
- Segment direction conflicts.
- Multiple dates, airports, or airlines where it is unclear whether they are alternatives, all-to-search candidates, or priority order.

Do not block on these cases:

- Passenger count is omitted; mark it as not provided and use 1 adult only as the executable search default.
- Cabin is omitted; use `cabinClass: economy`.
- The user gives a city but not a specific airport; search by city code first.
- Airline, flight number, baggage, or nonstop preference is omitted.

## Abnormal Field Handling

For abnormal fields, make the smallest useful confirmation request.

- A flight number with a two-letter airline prefix and five or more digits is abnormal, but do not create a candidate merely by trimming digits.
- If a flight number looks malformed and the original text includes date, route, time, or airline-prefix context, use available route/date/time context to search or validate candidates only when a current system capability exists. Without such data, do not invent a candidate flight number.
- When flight-data validation is available, filter candidates by date, route, airline prefix, and departure/arrival time first, then rank by flight-number similarity. Return only the most credible candidate for confirmation.
- If fields are stuck together, split high-confidence pieces and confirm only the minimum ambiguous part. For example, `WUHPEKI` can be treated as WUH plus likely PEK, then ask whether the arrival airport is PEK.
- For stuck time fields, infer only high-confidence formats and confirm them. For example, `20001210+1` may be confirmed as `20:00-12:10+1`.
- Candidate values must not be treated as final until the user confirms them.

Suggested confirmation style:

```text
我发现{字段} `{原值}` 可能有误：{异常原因}。

{若有候选：我根据{依据}找到候选 `{候选}`。请确认{字段}是否为 `{候选}`？}
{若无候选：当前没有可用基础数据能校验这个字段。请确认正确的{字段}是什么？}
```

## Batch Files

For Excel, CSV, or multiple natural-language requirements:

- Analyze each row or request independently.
- If any row has confirmation items, return a confirmation list or confirm row by row according to the user's requested workflow. Do not directly generate a final corrected file.
- Only write final corrected fields after the user confirms the pending items.
- Rows without confirmation needs can still produce normal analysis results.
