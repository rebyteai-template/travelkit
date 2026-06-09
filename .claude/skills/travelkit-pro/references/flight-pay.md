# Flight Payment

Use this reference for paying an existing Simplifly flight order. Order creation and lookup live in `flight-booking.md`; endpoint details live in `api-map.md`; user-facing redaction lives in `output-rules.md`.

## Payment Preconditions

- Payment is a write operation and requires explicit user confirmation.
- Use order detail when available before payment so the confirmation can include current status, amount, currency, and deadline if returned.
- Keep `orderID` internal in ordinary user replies unless the user is explicitly doing developer diagnostics.
- Do not expose ticket numbers or PNR before or after payment.

## Payment Workflow

The generated OpenAPI defines `POST /openapi/v3/flight/orders/{orderID}/payment` without a request body.

1. Query or use the latest known order detail.
2. Confirm which order will be paid, total amount/currency if returned, and that the user explicitly wants to pay now.
3. After explicit confirmation, call `pay_order(order_id)` with no body unless newer production docs require one.
4. Call `get_order(order_id)` after payment to confirm status.
5. Summarize payment/order status in user-safe wording.

## Payment Failure Handling

- If payment fails, query order detail before telling the user whether the order remains unpaid, pending, expired, cancelled, or changed.
- If the API response lacks payment status, deadline, or ticketing data, say it was not returned.
- Do not retry payment automatically after an ambiguous response without asking for explicit confirmation again.
