# Simplifly Flight OpenAPI Map

Use this reference for endpoint selection, direct-HTTP authentication, request fields, response fields, and mounted/optional capability status. Workflow order lives in the workflow references; user-facing formatting and redaction live in `output-rules.md`.

## Direct HTTP Runtime

Agents call Simplifly Flight OpenAPI directly. This is not a public MCP capability package.

Required `.simplifly.env` entries:

- `SIMPLIFLY_BASE_URL`
- `SIMPLIFLY_AUTH_TOKEN`
- Optional `SIMPLIFLY_ACCEPT_LANGUAGE`, default `zh-Hans`
- Optional `SIMPLIFLY_SF_MODE`, default `buyer`; allowed values are `buyer` or `seller`

Load configuration by searching from the current working directory upward for the nearest `.simplifly.env`, then parse it as a standard dotenv file. Do not hardcode an absolute `.simplifly.env` path. If no `.simplifly.env` is found, stop before calling the API and tell the user the local Simplifly config file is missing without exposing searched paths or sensitive details.

`.simplifly.env` is external private configuration and must never be created, copied, moved, modified, packaged, or emitted by this skill. If the nearest `.simplifly.env` is inside a `skills/` directory, treat it as invalid placement, do not use it, and ask the user to keep the file outside the skill package.

Build URLs as `${SIMPLIFLY_BASE_URL}${endpoint_path}`. `SIMPLIFLY_BASE_URL` must be the gateway root and must not include endpoint paths. Do not hardcode environment-specific gateways in this skill.

Every request must include:

- `Accept: application/json`
- `Authorization: Bearer ${SIMPLIFLY_AUTH_TOKEN}`
- `Accept-Language`: `SIMPLIFLY_ACCEPT_LANGUAGE` or `zh-Hans`
- `X-SF-Mode`: `SIMPLIFLY_SF_MODE` or `buyer`

Requests with a JSON body must also include `Content-Type: application/json`. GET and other no-body requests do not need `Content-Type`.

Token-only authentication is required. Do not use `SIMPLIFLY_OPENAPI_CODE`, `SIMPLIFLY_OPENAPI_SECRET`, `code`, `timestamp`, `signature`, SHA1 signing, or mixed token/signature authentication. Do not implement `/org/login`; login tokens must come from `.simplifly.env`. Do not add `X-Org-Id`.

The standard response envelope is:

- `code`: success is normally `0`
- `message`: public status message
- `realMessage`: backend detail when present
- `data`: endpoint payload

If `code != 0`, summarize `message` or `realMessage` safely. Do not dump raw headers, tokens, secrets, or full response envelopes to normal users.

## Mounted Core Endpoints

| Group | Method | Path | Operation | Data returned |
|---|---|---|---|---|
| Search | POST | `/openapi/v3/flight/shopping` | `shopping` | `FlightResponseOpenAPIShoppingResp` |
| Search | POST | `/openapi/v3/flight/pricing` | `pricing` | array of `FlightResponseOpenAPIPricingResp` |
| Search | POST | `/openapi/v3/flight/solutions/{solutionId}/verification` | `verify_solution` | `FlightResponseOpenAPIVerificationResp` |
| Search | POST | `/openapi/v3/flight/baggage-transit` | `baggage_transit` | `FlightResponseOpenAPIBaggageTransitResp` |
| Order | POST | `/openapi/v3/flight/orders` | `create_order` | `FlightResponseOpenAPIOrderResp` |
| Order | GET | `/openapi/v3/flight/orders/{orderID}` | `get_order` | `FlightResponseOpenAPIOrderResp` |
| Order | DELETE | `/openapi/v3/flight/orders/{orderID}` | `cancel_order` | `FlightResponseOpenAPIOrderResp` |
| Order | GET | `/openapi/v3/flight/external/{externalOrderID}` | `get_order_by_external_id` | `FlightResponseOpenAPIOrderResp` |
| Payment | POST | `/openapi/v3/flight/orders/{orderID}/payment` | `pay_order` | `FlightResponseOpenAPIOrderResp` |
| Change | POST | `/openapi/v3/flight/orders/{orderID}/change/search` | `change_search` | `FlightResponseOpenAPIChangeSearchResp` |
| Change | POST | `/openapi/v3/flight/orders/{orderID}/change` | `create_change_order` | `FlightResponseOpenAPIOrderResp` |
| Refund | POST | `/openapi/v3/flight/orders/{orderID}/refund` | `create_refund_order` | `FlightResponseOpenAPIOrderResp` |
| Refund | POST | `/openapi/v3/flight/orders/{orderID}/confirmation` | `confirm_refund_order` | `FlightResponseOpenAPIOrderResp` |
| Account | GET | `/openapi/v3/flight/balance` | `balance` | object |

## Optional / Unmounted Endpoints

These appeared in generated OpenAPI with `x-backend-router-registered: false`. Try them only when useful, and degrade gracefully on route-not-found or 404.

| Group | Method | Path | Operation |
|---|---|---|---|
| Search | POST | `/openapi/v3/flight/fare-rules` | `fare_rules` |
| Order | GET | `/openapi/v3/flight/orders` | `list_orders` |
| Order | POST | `/openapi/v3/flight/ticket-status` | `ticket_status` |
| Order | POST | `/openapi/v3/flight/pnr-parse` | `parse_pnr` |
| Refund | POST | `/openapi/v3/flight/orders/{orderID}/refund-money-search` | `refund_money_search` |
| Refund | POST | `/openapi/v3/flight/orders/refund-change-availability` | `refund_change_availability` |

## Explicitly Excluded

- All `Train/V3` and `Train/V4` endpoints.
- Any local login/token-refresh implementation inside the skill.

## Key Requests

### Shopping

`FlightRequestShoppingReq` fields:

- `journeys`: array of `{ origin, destination, departureDate }`
- `cabinClass`: full cabin string. Default to `economy`; map "economy cabin" / "经济舱" to `economy`. Do not send fare bucket or cabin-code shortcuts such as `Y`, `E`, `L`, or `P`.
- `passengers`: `{ adult, child, infant }`
- Optional filters: `excludeAirlines`, `includeAirlines`, `alliances`, `mustHaveBag`, `maxPrice`, `maxDuration`, `maxSegments`, `maxResultCount`
- Optional requirements: `freeBaggage`, `changeable`, `refundable`, `noCodeShare`, `noOverNight`, `noVirtualInterline`, `noMultiAirport`, `onlyCorporateFares`

Default request behavior:

- Ordinary one-way search: include `maxResultCount: 50`.
- Nonstop/direct request: include `maxSegments: 1`.
- Price, airline, baggage, or duration preferences: send matching request filters before local ranking.

### Known-Flight Pricing

`FlightRequestFlightPricingReq` fields:

- Required: `segments`
- `segments[]`: `{ departure, arrival, departureDate, cabinClass, flightNo, journeyIndex }`
- `passengers`: `{ adult, child, infant }`
- Optional: `mustHaveBag`, `maxPrice`, `accountCode`, `itineraryRequired`, `maxWaitTime`

Use the same full-name `cabinClass` rule as shopping.

### Verification

`POST /openapi/v3/flight/solutions/{solutionId}/verification`

Body fields:

- `solutionId`: same selected solution ID
- `passengerCount`: `{ adult, child, infant }`

Always use `passengerCount`; do not use `passengers` in verification requests. Use returned `orderKey` for order creation.

### Create Original Order

`FlightRequestCreateFlightOriginOrderRequest` fields:

- Required by schema: `orderKey`, `passengers`, `currency`
- Business-required: `passengerCount: { adult, child, infant }` matching the passenger array; otherwise the API returns "Passanger count error" (`1300038`)
- Contact: `contactName`, `contactRegion`, `contactPhone`; include optional `contactEmail` when available
- `externalOrderID`: buyer-side idempotency key
- Optional: `requireReview`, `manualRemark`
- `passengers[]`: `surname`, `givenNames`, `gender`, `birthday`, `travelDocument`, `travelDocumentNumber`, `travelDocumentExpireDate`, `type`, `nationality`, `region`, `phone`, optional `email`, `cardNo`, `airline`

### Payment

`POST /openapi/v3/flight/orders/{orderID}/payment`

Generated OpenAPI defines this endpoint without a request body. Call with no body unless newer production docs require one.

### Change Search

`FlightHandleropenAPIChangeSearchReq` fields:

- `segmentId`, `cabinClass`, `departureDate`
- `passengers`, `ticketInfo`
- `journeys[]`: original or replacement journey shape
- Optional shopping filters mirror shopping request fields

Returned `solutions[].solutionId` is required for create-change. Missing, `null`, or empty string `solutionId` means that option cannot be used to create a change order.

### Create Change Order

`FlightRequestCreateFlightChangeOrderRequest` fields:

- Required by schema: `reason`
- Business-required: `solutionIds`, `passengerIds`
- Optional: `oldJourneyIndex`, `fileList`, `reasonDetail`, contact fields

Build `solutionIds` only from non-empty `solutions[].solutionId` values returned by change search. Do not substitute `searchKey`, `orderKey`, segment IDs, or any other field.

### Refund

`FlightRequestCreateFlightRefundOrderRequest` fields:

- Required by schema: `passengerIds`, `segmentIds`, `reasonType`
- `reasonType`: `voluntary` or `involuntary`
- Optional: `fileList`, `reasonDetail`, contact fields

Generated OpenAPI may still show `reason` for refund creation, but the actual refund-create API uses `reasonType`. Do not use `reason` in create-refund requests.

`FlightHandleropenAPIRefundMoneySearchReq` fields:

- `passengerIds`, `segmentIds`, `reason`, `reasonDetail`

### Balance

`GET /openapi/v3/flight/balance` has no request body. Interpret only fields returned by the API; do not invent currency, available balance, credit limit, or frozen amount fields when absent. Use only for explicit balance/account/credit diagnostics requests.

## Key Responses

Shopping, pricing, verification, and change search return solution objects:

- `solutionId`: internal; use for verification/change creation only
- `orderKey`: internal; use for original order creation only
- `priceDetail`: public-safe after summarization
- `journeys`: public-safe after summarization
- `fareRules`: public-safe after summarization when present
- `requiredPassengerInfos`: collect only after verification and user intent to book

Order responses return:

- `id`: `orderID`, internal unless developer diagnostics
- `status`, `orderType`, `externalOrderId`, contact fields
- `journeys[].segments[].id`: internal segment IDs for refund/change
- `passengers[].id`: internal passenger IDs for refund/change
- `passengers[].tickets[]`: contains ticket numbers and PNR; do not show to ordinary users
- `priceDetail.priceTotal`, `priceDetail.transactionFee`, `priceDetail.priceList`
