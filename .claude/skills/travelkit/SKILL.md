---
name: travelkit
description: Use this skill for TravelKit direct-HTTP flight workflows backed by Simplifly OpenAPI: flight search, known-flight pricing, real-time solution verification, original order creation, payment, order lookup, cancellation, refund, change, baggage transit, fare rules, ticket status, PNR parsing, and flight account balance lookup. This skill excludes train APIs.
---

# TravelKit Flight OpenAPI Skill

Use Simplified Chinese in normal user-facing replies unless the user asks for another language.

This skill uses Simplifly Flight OpenAPI over direct HTTP. Do not use TravelKit MCP tools for this skill unless the user explicitly asks to switch integration style.

## Load Order

- For direct-HTTP agent runtime instructions, read [agent-direct-http](references/agent-direct-http.md).
- For endpoint names, request/response fields, and router availability, read [api-map](references/api-map.md).
- For natural-language flight requirement normalization before API calls, read [requirement-analysis](references/requirement-analysis.md).
- For shopping, pricing, verification, order creation, payment, and order lookup, read [flight-workflows](references/flight-workflows.md).
- For cancellation, refund, and change flows, read [post-sale](references/post-sale.md).

## Credentials

In this sandbox the credential is at `/code/.simplifly.env` and is not pre-exported; load it first in the same bash command with `set -a; source /code/.simplifly.env; set +a`, after which the variables below are set.

Read credentials only from environment variables or platform-managed secret storage:

- `SIMPLIFLY_BASE_URL`
- `SIMPLIFLY_AUTH_TOKEN`
- Optional `SIMPLIFLY_ACCEPT_LANGUAGE`, default `zh-Hans`
- Optional `SIMPLIFLY_SF_MODE`, default `buyer`; allowed values are `buyer` or `seller`

Cloud runtimes must inject the current user's `SIMPLIFLY_AUTH_TOKEN` after OAuth login completes. This skill does not fetch, store, refresh, or print user tokens.

Every HTTP request must include:

- URL: `SIMPLIFLY_BASE_URL` plus the endpoint path, for example `/openapi/v3/flight/shopping`
- `Content-Type`: `application/json`
- `Accept`: `application/json`
- `Authorization`: `Bearer ${SIMPLIFLY_AUTH_TOKEN}`
- `Accept-Language`: `SIMPLIFLY_ACCEPT_LANGUAGE` or `zh-Hans`
- `X-SF-Mode`: `SIMPLIFLY_SF_MODE` or `buyer`

Token-only authentication is the only supported request authentication mode. Do not use `SIMPLIFLY_OPENAPI_CODE`, `SIMPLIFLY_OPENAPI_SECRET`, `code`, `timestamp`, `signature`, SHA1 signing, or mixed token/signature authentication.

Never reveal credentials, JWT tokens, raw headers, or secret-loading paths to normal users.
Do not implement `/org/login` inside this skill; login tokens must come from environment variables or platform-managed secret storage.
Do not add `X-Org-Id`; the current system has not enabled it.

`SIMPLIFLY_BASE_URL` must come from the runtime, secret store, or deployment configuration. Do not hardcode environment-specific gateways in this skill. Set it to the gateway root only; do not include endpoint paths.

## Core Rules

- Search or price first; verify the selected `solutionId` immediately before collecting passenger identity details or creating an order.
- Use the latest verified `orderKey` for original order creation.
- Collect passenger document and phone details, plus email when available, only after verification succeeds and the user confirms they want to proceed.
- Before write operations, summarize the exact business action and wait for explicit user confirmation. Write operations are create order, pay order, cancel order, create refund order, confirm refund order, and create change order.
- Keep internal identifiers private unless the user is a developer asking for integration details: `solutionId`, `orderKey`, `orderID`, `passengerIds`, `segmentIds`, PNR, ticket numbers, JWT tokens, and API secrets.
- Normal user-visible replies must not expose PNR or ticket numbers, even if the API returns them.
- Account balance lookup is a read-only diagnostic/account operation. Call `GET /openapi/v3/flight/balance` only when the user explicitly asks about balance, account funds, credit, or balance diagnostics.
- Do not use train endpoints from the same OpenAPI document.
- Treat endpoints marked `x-backend-router-registered: false` as optional. If they fail or return route-not-found, fall back to mounted endpoints or tell the user the API did not return that capability.

## Output Rules

- Summarize prices from returned `priceDetail.priceList` or `priceDetail.priceTotal` when present; do not invent missing fare, tax, baggage, refund, or change policy data.
- Default flight search recommendations must prioritize the lowest displayed total price when the user has not stated a stronger preference.
- For ordinary flight search, request a bounded result set and summarize only compact options: default `maxResultCount: 50`, display Top 5, and never pass the full raw `data` / `solutions` payload into user-facing generation.
- When the same itinerary is returned with multiple fare options, display the lowest sellable fare for that itinerary. Do not let raw `solutions` order, array indexes, grouping, or deduplication cause a higher fare to be shown.
- Only show multiple prices for the same itinerary when the user explicitly asks to compare different fare products or rules.
- Do not show full fare rules, full baggage rules, or refund/change rules in first search results; show those only after the user selects a concrete option or asks for detailed rules.
- If an API response lacks baggage, refund, change, ticketing, deadline, or status data, say it was not returned.
- Convert internal status data into user-safe wording. Keep raw JSON out of ordinary user replies unless the user asks for developer diagnostics.
