# Flight Booking

Use this reference for verification, passenger collection, original order creation, and order lookup. Search and pricing live in `flight-search.md`; API fields live in `api-map.md`; payment lives in `flight-pay.md`; user-facing formatting and redaction live in `output-rules.md`.

## Verification Workflow

Verification is mandatory before collecting passenger identity details or creating an order.

1. Use the selected displayed option's private `solutionId`.
2. Call `verify_solution` via `POST /openapi/v3/flight/solutions/{solutionId}/verification` with body:
   `{"solutionId":"...","passengerCount":{"adult":1,"child":0,"infant":0}}`.
3. Always use `passengerCount: { adult, child, infant }`; explicitly pass `child: 0` and `infant: 0` when the user did not specify them.
4. Do not use `passengers` in verification requests. `passengers` belongs to shopping/create-order style payloads, not verification.
5. Compare returned route, times, cabin, and price against the selected displayed option, not the original raw array index.
6. If the verified itinerary or price changed materially, ask the user to accept the new option and price before proceeding.
7. Store the returned `orderKey` as the only key to use for original order creation.
8. Collect passenger and contact details only after verification succeeds and the user confirms they want to book.

If verification fails, return to search/pricing. If a later order creation retry is needed, verify again instead of reusing a stale `orderKey`.

## Passenger Collection

Collect only fields required by the chosen fare and create-order schema:

- Passenger: surname, given names, gender, birthday, passenger type, nationality
- Document: travel document type, number, and expiry date when applicable
- Contact: region/country code and phone; email when available
- Optional frequent flyer: airline and card number

Do not collect identity details during search-only conversations.

For international flights, collect passenger and contact details with this template only after verification succeeds and the user confirms they want to book:

```text
国籍：
证件类型：
姓：
名：
性别：
出生日期：
证件号码：
证件有效期：
乘客电话（可选）：
乘客邮箱（可选）：
常用旅客卡（可选）：

联系人姓名：
联系人邮箱：
联系人手机：
```

Field mapping:

- 国籍 -> passenger `nationality`
- 证件类型 -> passenger `travelDocument`
- 姓 -> passenger `surname`
- 名 -> passenger `givenNames`
- 性别 -> passenger `gender`
- 出生日期 -> passenger `birthday`
- 证件号码 -> passenger `travelDocumentNumber`
- 证件有效期 -> passenger `travelDocumentExpireDate`
- 乘客电话（可选） -> passenger `region` + `phone` when provided
- 乘客邮箱（可选） -> passenger `email` when provided
- 常用旅客卡（可选） -> passenger `airline` + `cardNo` when provided
- 联系人姓名 -> `contactName`
- 联系人邮箱 -> `contactEmail`
- 联系人手机 -> `contactRegion` + `contactPhone`

## Create Original Order

Create order is a write operation. Before calling it, summarize the exact business action and wait for explicit user confirmation.

Confirmation must include:

- Flight route/date/time and passenger count
- Total price/currency if returned
- Contact name/phone, and email when required by the collection template or provided
- Statement that the order will be created

After explicit confirmation:

1. Build `externalOrderID` if the user has not supplied one, using a deterministic prefix plus timestamp.
2. Call `create_order` with the latest verified `orderKey`, `passengers`, `passengerCount`, contact fields, `externalOrderID`, and `currency`.
3. Ensure `passengerCount` matches the passenger array; omitting it can produce "Passanger count error" (`1300038`).
4. Summarize order status and payment deadline if returned.
5. Keep `orderID` internal but store it for payment and lookup.

## Order Lookup

Use `get_order(order_id)` when an internal order ID is known.

Use `get_order_by_external_id(external_order_id)` when resuming from a buyer-side idempotency key.

Use `list_orders` only as an optional fallback because generated OpenAPI marks it as not currently mounted.

Order lookup is read-only. Do not expose ticket numbers, PNR, internal passenger IDs, or internal segment IDs in ordinary user replies.

## Balance Lookup

Use `balance` only when the user explicitly asks about account balance, account funds, credit, or balance diagnostics. It is read-only and does not require write-operation confirmation. Interpret only fields returned by the API; do not invent currency, available balance, credit limit, or frozen amount fields.

## Error Handling

- If the envelope `code` is not `0`, summarize `message` or `realMessage` without dumping raw JSON.
- If order creation fails after verification, do not reuse stale `orderKey`; verify again before retrying.
- If required passenger fields are missing, ask only for the missing fields needed to build the documented request.
