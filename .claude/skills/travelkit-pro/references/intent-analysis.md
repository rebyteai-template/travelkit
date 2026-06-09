# Flight Intent Analysis

Use this reference to normalize natural-language flight requirements before calling Simplifly Flight OpenAPI. This file only covers requirement parsing and query-condition normalization. It does not define authentication, verification, order creation, payment, refund, change, or any write operation behavior.

## Workflow

1. Decide whether the user request can be normalized into executable search or pricing inputs.
2. If a critical field is missing, conflicting, or abnormal and cannot be reasonably inferred, ask one concise confirmation question; 一次只问一个问题.
3. During confirmation, ask only the current question. Do not output JSON, full extracted fields, internal identifiers, or summaries.
4. After the user confirms the current item, continue with the next missing or conflicting item only if needed.
5. When no confirmation is needed, normalize the request into route, date, passenger count, cabin, and preference inputs for shopping or pricing.

## Extracted Intent

Identify these fields when present:

- Query intent: search price, compare fares, check availability, holdable option, lowest price, itinerary proposal, known-flight pricing.
- Trip type: one-way, round trip, multi-city, or open-jaw.
- Passenger groups: passenger count, passenger type, group or batch names when supplied.
- Segments: date, origin, destination, airport or city code, airline, flight number, departure time, arrival time.
- Cabin: economy, premium economy, business, first, mixed cabin, or default economy.
- Date flexibility: "左右", alternatives, date ranges, stay length, fixed dates, or flexible return dates.
- Preferences and constraints: morning departure, afternoon arrival, earliest return, nonstop, transfer allowed, airport, airline, checked baggage, lowest price, shortest duration, fewer stops, or holdable inventory.
- Inferences, missing fields, ambiguities, and user corrections.

## Defaults And Inference

- If the user does not specify cabin, use `cabinClass: economy`. Map "经济舱" and "economy cabin" to `economy`; do not use fare-bucket shortcuts such as `Y`.
- If the user does not specify passenger count, use 1 adult for search and verification planning.
- If the user provides a city with multiple airports, use the city code first when available. If no results return, try common airport-code combinations and summarize which routes were tried.
- If a round trip has a stay length but no exact return date, infer the return date from the stay length. 停留天数推返程日期时，the departure date counts as day 1, so return date equals departure date plus stay days minus 1.
- If the return destination is omitted but the outbound origin or normal return point is clear from context, infer that destination for a searchable return.
- If the user says "左右" or gives a flexible date range, create candidate dates and compare results after shopping.
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

- Passenger count is omitted; use 1 adult for search planning.
- Cabin is omitted; use `cabinClass: economy`.
- The user gives a city but not a specific airport; search by city code first.
- Airline, flight number, baggage, or nonstop preference is omitted.

## Abnormal Field Handling

For abnormal fields, make the smallest useful confirmation request.

- If a flight number looks malformed, use available route/date/time context to search or validate candidates only when a current system capability exists. Without such data, do not invent a candidate flight number.
- If fields are stuck together, split high-confidence pieces and confirm only the minimum ambiguous part. For example, `WUHPEKI` can be treated as WUH plus likely PEK, then ask whether the arrival airport is PEK.
- Candidate values must not be treated as final until the user confirms them.

Suggested confirmation style:

```text
我发现{字段} `{原值}` 可能有误：{异常原因}。

{若有候选：我根据{依据}找到候选 `{候选}`。请确认{字段}是否为 `{候选}`？}
{若无候选：当前没有可用基础数据能校验这个字段。请确认正确的{字段}是什么？}
```
