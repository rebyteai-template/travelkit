---
name: travelkit-pro
description: Use this skill for TravelKit Pro direct-HTTP flight workflows backed by Simplifly OpenAPI: flight search, known-flight pricing, solution verification, order creation, payment, order lookup, cancellation, refund, change, baggage transit, fare rules, ticket status, PNR parsing, and flight account balance lookup. This skill excludes train APIs.
---

# TravelKit Pro Flight OpenAPI Skill

Use Simplified Chinese in normal user-facing replies unless the user asks for another language.

This skill uses Simplifly Flight OpenAPI over direct HTTP for internal cloud agents. Do not use TravelKit MCP tools unless the user explicitly asks to switch integration style. Do not call or implement train APIs.

## Reference Routing

Load only the smallest reference needed for the current user intent.

| User intent | Read |
|---|---|
| API/auth/endpoint/field details | [api-map](references/api-map.md) |
| Natural-language requirement parsing | [intent-analysis](references/intent-analysis.md) |
| Search, compare, known-flight pricing | [flight-search](references/flight-search.md) |
| Verify, create order, order lookup | [flight-booking](references/flight-booking.md) |
| Pay order | [flight-pay](references/flight-pay.md) |
| Cancel, refund, change | [post-sale](references/post-sale.md) |
| User-facing formatting or redaction | [output-rules](references/output-rules.md) |

## Core Boundaries

- Read Simplifly configuration only from an existing external `.simplifly.env` dotenv file: `SIMPLIFLY_BASE_URL`, `SIMPLIFLY_AUTH_TOKEN`, optional `SIMPLIFLY_ACCEPT_LANGUAGE`, and optional `SIMPLIFLY_SF_MODE`. `.simplifly.env` is private local configuration and is not part of the skill. Locate the file dynamically; do not hardcode an absolute `.simplifly.env` path.
- Never create, copy, move, modify, package, or emit `.simplifly.env`. If it is missing, stop API calls and ask the user to provide the local config file; do not create a sample, placeholder, or empty `.simplifly.env`.
- Token-only authentication is the only supported mode. Do not use `SIMPLIFLY_OPENAPI_CODE`, `SIMPLIFLY_OPENAPI_SECRET`, `code`, `timestamp`, `signature`, SHA1 signing, or mixed token/signature authentication.
- Do not implement `/org/login`; the token must come from `.simplifly.env`.
- Do not add `X-Org-Id`; the current system has not enabled that header.
- Never reveal credentials, JWT tokens, bearer tokens, raw headers, secret-loading paths, or raw auth errors to normal users.
- Keep internal identifiers private unless the user is explicitly doing developer diagnostics: `solutionId`, `orderKey`, `orderID`, `passengerIds`, `segmentIds`, PNR, ticket numbers, JWT tokens, and API secrets.
- Normal user-visible replies must not expose PNR or ticket numbers, even if the API returns them.

## Workflow Rules

- Search or price first; verify the selected `solutionId` immediately before collecting passenger identity details or creating an order.
- Use the latest verified `orderKey` for original order creation.
- Collect passenger document and phone details, plus email when available, only after verification succeeds and the user confirms they want to proceed.
- Before write operations, summarize the exact business action and wait for explicit user confirmation. Write operations are create order, pay order, cancel order, create refund order, confirm refund order, and create change order.
- Account balance lookup is a read-only diagnostic/account operation. Call it only when the user explicitly asks about balance, account funds, credit, or balance diagnostics.
- Treat optional or unmounted endpoints as degraded capabilities. If route-not-found or 404 is returned, fall back to mounted endpoints when possible or tell the user the API did not return that capability.

## Output Rules

- Summarize only API-returned commercial facts. Do not invent fare, tax, baggage, refund/change policy, ticketing, deadline, or status data.
- Default flight search recommendations prioritize the lowest displayed total price unless the user states a stronger preference.
- For ordinary search, request a bounded result set, summarize compact options, and keep raw `data` / `solutions` out of user-facing generation.
- When the same itinerary is returned with multiple fare options, display the lowest sellable fare for that itinerary unless the user explicitly asks to compare fare products or rules.
- Convert internal status data into user-safe wording. Keep raw JSON out of ordinary user replies unless the user asks for developer diagnostics.
