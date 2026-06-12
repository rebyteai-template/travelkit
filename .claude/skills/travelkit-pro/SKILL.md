---
name: travelkit-pro
description: >-
  Use this skill for TravelKit Pro direct-HTTP flight workflows backed by
  Simplifly OpenAPI: flight search, known-flight pricing, solution verification,
  order creation, payment, order lookup, cancellation, refund, change, baggage
  transit, fare rules, ticket status, PNR parsing, and flight account balance
  lookup.
---

# TravelKit Pro Flight OpenAPI Skill

Use Simplified Chinese in normal user-facing replies unless the user asks for another language.

This skill uses Simplifly Flight OpenAPI over direct HTTP for internal cloud agents.

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

- Read Simplifly configuration from an existing external `.simplifly.env` dotenv file first, then fall back to platform-injected process environment variables when no `.simplifly.env` exists. Supported variables are `SIMPLIFLY_BASE_URL`, `SIMPLIFLY_AUTH_TOKEN`, optional `SIMPLIFLY_ACCEPT_LANGUAGE`, and optional `SIMPLIFLY_SF_MODE`.
- `.simplifly.env` is private local configuration and is not part of the skill. Locate the file dynamically; do not hardcode an absolute `.simplifly.env` path. Never create, copy, move, modify, package, or emit `.simplifly.env`.
- If `.simplifly.env` exists but is missing required entries, stop API calls and report missing Simplifly configuration; do not silently fall back to process environment variables. If no `.simplifly.env` exists and required process environment variables are missing, report missing Simplifly configuration without asking the user to paste tokens in chat.
- Token-only authentication is the only supported mode. Do not use `SIMPLIFLY_OPENAPI_CODE`, `SIMPLIFLY_OPENAPI_SECRET`, `code`, `timestamp`, `signature`, SHA1 signing, or mixed token/signature authentication.
- Do not implement `/org/login`; the token must come from `.simplifly.env` or platform-injected `SIMPLIFLY_AUTH_TOKEN`.
- Do not add `X-Org-Id`; the current system has not enabled that header.
- Never reveal credentials, JWT tokens, bearer tokens, raw headers, secret-loading paths, or raw auth errors to normal users.
- Keep internal identifiers private unless the user is explicitly doing developer diagnostics: `solutionId`, `orderKey`, `orderID`, `passengerIds`, `segmentIds`, PNR, ticket numbers, JWT tokens, and API secrets.
- Normal user-visible replies must not expose PNR or ticket numbers, even if the API returns them.

## Workflow Rules

- For all agent-handled flight shopping/search requests, write a temporary JSON request file and run the bundled resource `scripts/flight_search.py` from the skill directory: `python3 scripts/flight_search.py --request-file <json>`. The simple CLI form (`--origin` / `--destination` / `--date`) is only for manual local smoke tests and is not an agent workflow entrypoint. Do not call the `shopping` endpoint directly unless the script cannot express the task or developer diagnostics require raw API behavior.
- Treat `scripts/flight_search.py` stdout as agent-internal raw API input, not user-facing content. For ordinary search result summarization, pass that raw JSON through `scripts/flight_search_compact.py --input <raw-json>` before composing the reply, unless developer diagnostics require inspecting the raw envelope directly.
- Treat `scripts/flight_search_compact.py` stdout as agent-internal compact input. Use its display fields to render the user-facing table according to `output-rules.md`; never paste the compact JSON directly to ordinary users.
- When presenting search options, retain the compact `displayMapping` from the final user-visible option number to the private `solutionId`. For ordinary script-based shopping results, verify the selected option with `scripts/flight_verify_selected.py --compact-file <compact-json> --option <number>` so search display and verification stay on the same direct-HTTP channel. Use verification output as the source of the latest booking `orderKey`.
- The local search/verify scripts apply to ordinary shopping/search option verification. Existing order detail lookup, payment, cancellation, refund, change, itinerary download, known-flight pricing, and order creation continue to use their existing workflow references and API rules.
- Search or price first; verify the selected `solutionId` immediately before collecting passenger identity details or creating an order.
- Use the latest verified `orderKey` for original order creation.
- Collect passenger document and phone details, plus email when available, only after verification succeeds and the user confirms they want to proceed.
- Before write operations, summarize the exact business action and wait for explicit user confirmation. Write operations are create order, pay order, cancel order, create refund order, confirm refund order, and create change order.
- Account balance lookup is a read-only diagnostic/account operation. Call it only when the user explicitly asks about balance, account funds, credit, or balance diagnostics.
- Treat optional or unmounted endpoints as degraded capabilities. If route-not-found or 404 is returned, fall back to mounted endpoints when possible or tell the user the API did not return that capability.

## Output Rules

- Summarize only API-returned commercial facts. Do not invent fare, tax, baggage, refund/change policy, ticketing, deadline, or status data.
- If the user states flight display preferences, follow those preferences. If the user does not state preferences, use the default baggage-qualified recommendation policy in `flight-search.md`: direct flights by early/midday/evening/late-night groups, limited low-duration transfers, and one cheaper no-baggage reminder. Recommendation counts are maximums; show only the qualifying options that exist.
- Before sending an ordinary or complex search reply with no explicit user display preference, self-check that the reply contains all four visible time sections `早 06:00-12:00`, `中 12:00-18:00`, `晚 18:00-24:00`, and `凌晨 24:00-06:00`, plus `低价提醒` and `下一步`. If any required section is missing, rewrite the reply before sending it. Do not merge default recommendations into one ungrouped table unless the user explicitly asks for another display order or filter.
- For search, script stdout may contain raw `data` / `solutions`; summarize compact options and keep raw API data out of user-facing generation.
- When the same itinerary is returned with multiple fare options, display the lowest sellable fare that satisfies the active user preference or default recommendation policy unless the user explicitly asks to compare fare products or rules.
- Convert internal status data into user-safe wording. Keep raw JSON out of ordinary user replies unless the user asks for developer diagnostics.
