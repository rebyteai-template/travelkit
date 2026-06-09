# Flight Post-Sale Workflows

Use this reference for cancellation, refund, and change operations. Endpoint fields live in `api-map.md`; user-facing formatting and redaction live in `output-rules.md`.

These are business-sensitive flows. `cancel_order`, `create_refund_order`, `confirm_refund_order`, and `create_change_order` are write operations and require explicit user confirmation before the API call.

## Shared Rules

- Start from `get_order(order_id)` whenever possible.
- Use returned `passengers[].id` and `journeys[].segments[].id` internally for refund/change.
- Never show PNR or ticket numbers in ordinary user-facing replies.
- Ask the user which passengers and segments to affect using names, dates, routes, and flight numbers, not raw IDs.
- Preserve user wording in `reasonDetail` when helpful.
- If supporting documents are needed for schedule change, illness, death, or other special handling, collect `fileList` URLs before the write request.
- Use `output-rules.md` for fare rule tables, flight time presentation, and redaction.

## Cancellation

Cancellation is for an existing order, commonly before final ticketing or when cancellation is permitted.

1. Query order detail.
2. Check returned status, `isVoidPermitted`, and `lastVoidTime` if present.
3. Confirm the cancellation action with the user, including the affected route/order context and any returned deadline.
4. After explicit confirmation, call `cancel_order(order_id)`.
5. Query or summarize returned order status in user-safe wording.

## Refund Availability and Amount

Optional APIs may not be mounted:

- `refund_change_availability`
- `refund_money_search`

Use them when available. If they fail due to route-not-found or 404, fall back to order detail and fare rules if returned, and state that the API did not return a refund quote.

## Create Refund Order

1. Query order detail.
2. Identify passengers and segments to refund.
3. Optionally call `refund_money_search` with `passengerIds`, `segmentIds`, `reason`, and `reasonDetail`.
4. Show any returned refund amount, refund fee, service fee, and currency.
5. Confirm the refund request with the user.
6. Build the create-refund body with `passengerIds`, `segmentIds`, and `reasonType`.
7. `reasonType` must be `voluntary` or `involuntary`. Do not use `reason` in create-refund requests. Put user-facing explanation text in `reasonDetail` when provided.
8. After explicit confirmation, call `create_refund_order(order_id, body)`.
9. Summarize returned refund order status.

## Confirm Refund Order

Use when the refund flow requires a second confirmation after review.

1. Query the refund order detail if available.
2. Confirm the exact refund confirmation action with the user.
3. After explicit confirmation, call `confirm_refund_order(order_id)`.
4. Summarize returned status.

## Change Search

1. Query the original order.
2. Identify passenger(s), original segment, preferred new date, and cabin.
3. Call `change_search(order_id, body)`.
4. Present user-safe change options using `output-rules.md`: route, departure, arrival, duration, cabin, price difference, and service fee when returned.
5. Keep `solutionId` internal.
6. Filter out any change-search option whose `solutionId` is missing, `null`, or an empty string. Only options with a non-empty string `solutionId` may be shown as selectable change options.
7. Invalid options may be summarized as diagnostics, but the user must not be allowed to select them for change creation.

## Create Change Order

1. User selects a valid change option from change search.
2. Build `solutionIds` from the selected internal option. `solutionIds` must be a non-empty array, and every value must be a non-empty string.
3. Do not call `create_change_order` when there is no valid `solutionId`; tell the user that no change order was created because the API did not return a valid change option ID.
4. Build `passengerIds` from selected passengers.
5. Build the body with documented fields only: `solutionIds`, `passengerIds`, `reason`, optional `oldJourneyIndex`, `fileList`, `reasonDetail`, and contact fields when available.
6. Do not invent alternate field names or retry with speculative payload shapes.
7. Confirm the change request, including any price difference, service fee, affected passengers, and new itinerary.
8. After explicit confirmation, call `create_change_order(order_id, body)` once with the confirmed payload.
9. If the API returns `Parameters error`, missing business fields, or repeated parameter validation failures after a documented payload, stop retrying speculative variants. Explain that the API did not accept the documented change-order payload, keep internal IDs hidden, and offer a safe fallback when available.
10. Summarize returned change order status if successful.

## Change Failure Fallback

When change search can find options but create change order is not accepted by the API, do not present the result as a completed change. Summarize:

- The selected original order and new itinerary in user-safe terms.
- The returned business error message, such as `Parameters error`.
- That no change order was created.
- Fallback choices available from read data: try another change option, request backend/API support, or refund/cancel and create a new booking after explicit confirmation.

Only recommend refund/cancel plus new booking when the API returned refund or cancel permissibility, refund quote, or other evidence that the fallback is available. Do not execute refund, cancel, or new booking without separate write-operation confirmations.

## Fare Rules

`fare_rules` is optional because it is marked as not mounted. Prefer fare rules returned by shopping, pricing, verification, or order detail. Call the standalone fare-rules endpoint only when needed and degrade gracefully if unavailable.
