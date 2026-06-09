# Output Rules and Redaction

Use this reference for user-facing formatting, hidden fields, price display, time display, fare rules, and developer diagnostics boundaries.

## Redaction Rules

Do not expose these fields in ordinary user replies:

- `solutionId`
- `orderKey`
- `orderID` unless needed for developer diagnostics
- `passengerIds`, `segmentIds`, raw passenger IDs, raw segment IDs
- PNR, `pnr`, `airlinePnr`
- ticket numbers, `ticketNo`
- JWT tokens, bearer tokens, API secrets, raw headers, secret-loading paths
- raw request/response envelopes unless the user asks for developer diagnostics

Normal user-visible replies must never contain PNR or ticket numbers, even if returned, empty, or present in an error message. Ask about passengers and segments using names, dates, routes, and flight numbers, not raw IDs.

## Price Rules

Summarize prices only from returned data:

- Prefer the sum of `priceDetail.priceList[].salePrice * num`.
- If `salePrice` is missing, use `(price + tax) * num`.
- If itemized price fields are absent, use `priceDetail.priceTotal` when present.

Do not invent missing fare, tax, baggage, refund/change policy, service fee, ticketing, deadline, or status data. If a field is absent, say it was not returned.

When multiple solutions have the same flight combination, route, departure time, and arrival time, display the lowest computed total unless the user explicitly asks to compare fare products. The displayed price, private `solutionId`, private `orderKey`, and later verification must all refer to that same lowest fare solution.

## Ordinary Search Output

Use this fixed table format for ordinary one-way or ordinary single-search results:

`方案 | 航班 | 航司 | 路线 | 起飞 | 到达 | 时长 | 经停/中转 | 舱位 | 价格`

Field rules:

- `起飞` contains departure date/time and airport or terminal, for example `6/21 07:45 大兴(PKX)`.
- `到达` contains arrival date/time and airport or terminal, for example `6/21 10:05 浦东T1`.
- `时长` contains only flight or total itinerary duration, for example `2h20m`.
- `价格` contains only total displayed price, for example `¥620`.
- `经停/中转` contains nonstop, stop count, transfer count, or transfer airport summary when returned.
- `舱位` contains display cabin, for example `经济舱`; do not put fare-bucket shortcuts here unless the user asks for fare-code detail.
- Do not put price in `时长`; do not put duration in `到达`; do not leave `价格` empty when a displayed price is derivable.
- Keep option numbers stable and bound to the private mapping used for verification.

## Complex Search Output

Use this fixed structure for complex results requiring multiple shopping calls, local combination, or comparison across dates/routes:

1. `查询请求`: passenger count, cabin, searched date range, route/city assumptions, and user preferences.
2. `推荐方案`: best 3-5 combinations in one table. Columns: `方案`, `去程`, `回程`, `往返总价`, `推荐理由`. For one-way complex searches, replace `回程` with `-`.
3. `方案详情`: expand each recommended option with flight numbers, route, departure, arrival, duration, transfer count, itinerary price, and checked baggage if returned.
4. `候选摘要`: when expansion was used, show separate outbound/return candidate summaries, up to 5 rows each.
5. `未返回结果`: list searched dates/routes that returned no results; omit if every searched route/date returned options.
6. `下一步`: ask the user to reply with a displayed option number for verification.

Rules:

- Keep option numbers stable across sections.
- Every displayed option must map to the exact lowest-fare `solutionId` used for the displayed price.
- Do not expose internal IDs, raw API responses, signatures, credentials, PNR, or ticket numbers.

## Flight Time Presentation

When presenting flight search, pricing, verification, order confirmation, or change options, show departure, arrival, and duration as separate readable values.

- Write departure and arrival with dates, for example `6/10 02:35 出发 -> 6/10 21:35 到达`.
- If arrival is on a later date, show the full arrival date and add `次日` when appropriate, for example `6/16 19:25 出发 -> 6/17 13:30 到达（次日）`.
- Show total duration separately, for example `总时长 18h05m`.
- Do not use `+1` as the only cross-day indicator.
- Do not use time-only ranges such as `02:35-21:35` when dates are available.
- In tables, use separate columns for `起飞`, `到达`, and `时长`.
- Do not merge departure and arrival into a single `出发` column in tables.

## Fare Rule Presentation

When presenting `fareRules.refund` and `fareRules.change`, use this time-key mapping. Do not guess from literal signs `<0` / `>0`.

- Fixed table columns: `规则 | 起飞前 | 起飞后`
- `refund[">0"]` -> 起飞前退票费
- `refund["<0"]` -> 起飞后退票费
- `change[">0"]` -> 起飞前改签费
- `change["<0"]` -> 起飞后改签费
- If a field is missing, show only values returned by the API.
- `canVoid` means whether voiding is permitted. Do not merge it into refund or change fee rows.

## Developer Diagnostics

When the user explicitly asks for developer diagnostics, raw technical details may be summarized, but still do not reveal JWT tokens, bearer tokens, API secrets, real credentials, or raw auth headers.

Keep diagnostics scoped to the requested issue: endpoint path, operation name, mounted/optional status, sanitized request shape, response `code`, and sanitized `message` / `realMessage`.
