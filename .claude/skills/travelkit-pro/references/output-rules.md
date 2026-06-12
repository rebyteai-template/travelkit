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

Search script stdout is agent-internal raw API input. Before replying to a user, pass ordinary search raw output through `scripts/flight_search_compact.py --input <raw-json>` when available, then summarize the compact output into the fixed search output formats below. Do not paste `rawResponse`, raw request/response envelopes, compact JSON, `data.solutions`, `data.segments`, `solutionId`, `orderKey`, credentials, PNR, or ticket numbers.

## Price Rules

Summarize prices only from returned data:

- Prefer the sum of `(priceDetail.priceList[].publishPrice + tax) * num`.
- If `publishPrice` is missing, use `salePrice * num`.
- If both `publishPrice` and `salePrice` are missing, use `(price + tax) * num`.
- If itemized price fields are absent, use `priceDetail.priceTotal` when present.

For ordinary user-facing replies, do not expose internal price field names such as `publishPrice`, `salePrice`, `price + tax`, or describe the internal price-priority logic. When showing `价格明细`, render `publishPrice` as `票价` and `tax` as `税费`, for example `票价 ¥1400 + 税费 ¥200`. If a script output includes `priceBreakdownDisplay`, use that exact user-facing string. Mention `salePrice` only when the user explicitly asks for developer diagnostics or raw field comparison.

Do not invent missing fare, tax, baggage, refund/change policy, service fee, ticketing, deadline, or status data. If a field is absent, say it was not returned.

When multiple solutions have the same flight combination, route, departure time, and arrival time, display the lowest computed total that satisfies the active user preference or default recommendation policy unless the user explicitly asks to compare fare products. The displayed price, private `solutionId`, private `orderKey`, and later verification must all refer to that same lowest fare solution.

## Ordinary Search Output

Use this fixed table format for ordinary one-way or ordinary single-search results:

`序号 | 航程 | 行程详情 | 时长 | 舱位 | 行李额 | 价格`

Field rules:

- `序号` is the displayed option number and must stay bound to the private mapping used for verification.
- One complete itinerary option owns one `序号`. For round-trip or multi-city options, use one row per journey; in Markdown show the `序号` only on the first row and leave later rows blank.
- `航程` contains direction plus transfer count: `单程直飞`, `单程中转x次`, `去程直飞`, `回程中转x次`, `第一程直飞`, `第二程中转x次`. Transfer count equals segment count minus 1. A stopover without aircraft change remains `直飞`; add `经停xxx` in `行程详情`.
- `行程详情` contains one flight segment per line: `MU5186  10月05日  北京大兴(PKX) -> 上海浦东(PVG)  07:45 - 10:05+1`. Always include the departure date after the flight number. For ordinary search tables, keep overnight arrivals as `+1` on the arrival time instead of expanding the arrival date.
- `时长` contains total duration plus transfer durations when returned or derivable, for example `总时长12h30<br>中转时长3h15` or `总时长22h20<br>第一次中转时长7h12<br>第二次中转时长2h05`.
- `舱位` contains display cabin plus booking code when returned, for example `经济舱 H舱` or `商务舱 C舱`. If the booking code is missing, show the returned cabin name and `待确认`; do not invent a booking code.
- `行李额` contains checked baggage allowance as pieces and weight when returned, for example `1件，23kg/件` or `2件，32kg/件`. If checked baggage is missing or not included, write `无托运/未返回` and do not put the option in the default recommendation section.
- For known-flight pricing with a requested booking code, if price is returned for the matching booking code but baggage rules are missing, show the price and write `未返回/待确认` for baggage. Do not display baggage from a different booking code on the same flight.
- `价格` contains only the displayed total price, for example `¥620`; include tax scope only when returned or already derivable from the source data.
- Do not put price in `时长`; do not put duration in `行程详情`; do not leave `价格` empty when a displayed price is derivable. Preserve source option order unless the active recommendation policy or user request requires sorting.

Default ordinary search sections when the user has no display preference:

1. `推荐方案`: this must be visibly grouped into exactly four time sections in this order: `早 06:00-12:00`, `中 12:00-18:00`, `晚 18:00-24:00`, and `凌晨 24:00-06:00`. In each time section, show up to two cheapest baggage-qualified direct options whose first departure time is in that section. Also include up to two cheapest baggage-qualified transfer options with total duration less than 8 hours in the time section of their first departure. If a section has no qualifying option, still show that section and write `无符合默认推荐条件的方案`. Do not merge all default recommendations into one ungrouped table.
2. `低价提醒`: if a no-checked-baggage or baggage-missing option is cheaper than the cheapest recommended baggage-qualified option, show only the single cheapest such option and label it `不含托运行李/行李未返回`; do not mix it into `推荐方案`.
3. `下一步`: ask the user to reply with a displayed option number for verification.

When the user states a display preference, follow the user's preference instead of the default sections, while still showing baggage status for displayed options when returned.

When the user requests a concrete booking code such as `Z`, `V`, `E`, or `Q`, display only solutions that matched the requested `cabinCode` or `subCabinCode`; do not use the default four time-section recommendation layout for that response. Show the cabin as `经济舱 Z舱`, `经济舱 V舱`, or the equivalent returned cabin plus booking code. If a returned option lacks a concrete booking code, show `经济舱（未返回具体舱位）` or the equivalent returned cabin, and do not count it as a match for the requested booking code.

## Copy Mode

When the user replies after a displayed option table with a selected option number or number plus `复制`, output only that selected itinerary as copy-ready plain text. Triggers include `1`, `2复制`, `序号1复制`, `复制方案二`, and `方案二复制`.

Copy-mode rules:

- Output plain text only. Do not include a Markdown table, code fence, explanation, or `方案一` / `方案二` heading.
- Omit all duration content: no `总时长`, no `中转时长`, and no transfer-duration lines.
- Keep each journey block: `航程` label first, then flight segment lines. Add `经停xxx` as its own line when present.
- Put shared `舱位`, `行李额`, and `价格` after all journey blocks. If these values differ by journey, put them inside each journey block.
- Keep the same user-safe redaction rules as ordinary replies; do not expose internal IDs, raw API data, PNR, or ticket numbers.

## Complex Search Output

Use this fixed structure for complex results requiring multiple shopping calls, local combination, or comparison across dates/routes:

1. `查询请求`: passenger count, cabin, searched date range, route/city assumptions, and user preferences.
2. `推荐方案`: by default, visibly group best combinations into exactly four time sections in this order: `早 06:00-12:00`, `中 12:00-18:00`, `晚 18:00-24:00`, and `凌晨 24:00-06:00`. For one-way complex searches, group by the first departure time. For round-trip or multi-city searches, group by the first journey's first departure time. In each section, show up to two cheapest baggage-qualified options. If a section has no qualifying option, still show that section and write `无符合默认推荐条件的方案`. Columns: `方案`, `去程`, `回程`, `往返总价`, `推荐理由`. For one-way complex searches, replace `回程` with `-`.
3. `方案详情`: expand each recommended option with flight number, itinerary, time, cabin, price, and checked baggage allowance if returned.
4. `低价提醒`: when the default policy is active and a no-checked-baggage or baggage-missing option is cheaper than the cheapest baggage-qualified recommendation, show only the single cheapest such option.
5. `候选摘要`: when expansion was used, show separate outbound/return candidate summaries, up to 5 rows each.
6. `未返回结果`: list searched dates/routes that returned no results; omit if every searched route/date returned options.
7. `下一步`: ask the user to reply with a displayed option number for verification.

Rules:

- Keep option numbers stable across sections.
- Every displayed option must map to the exact lowest-fare `solutionId` used for the displayed price.
- Do not expose internal IDs, raw API responses, signatures, credentials, PNR, or ticket numbers.
- Unless the user explicitly asks for a different display preference, ordinary and complex search replies must contain all four default time sections plus `低价提醒` and `下一步`. If any required section is missing, rewrite the reply before sending it.

## Flight Time Presentation

When presenting flight search, pricing, verification, order confirmation, or change options, show departure, arrival, and duration as separate readable values.

- For ordinary search result tables, use the fixed `行程详情` and `时长` columns defined in `Ordinary Search Output`; for verification, order confirmation, change options, and other non-search-result tables, keep departure, arrival, and duration separate.
- Ordinary search result tables may use `+1` on the arrival time for overnight arrivals, for example `07:45 - 10:05+1`.
- Write departure and arrival with dates, for example `6/10 02:35 出发 -> 6/10 21:35 到达`.
- If arrival is on a later date, show the full arrival date and add `次日` when appropriate, for example `6/16 19:25 出发 -> 6/17 13:30 到达（次日）`.
- Show total duration separately, for example `总时长 18h05m`.
- Outside ordinary search result tables and copy mode, do not use `+1` as the only cross-day indicator.
- Do not use time-only ranges such as `02:35-21:35` when dates are available.
- In non-search-result tables, use separate columns for `起飞`, `到达`, and `时长`.
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
