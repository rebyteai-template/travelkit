# Booking a recommended plan

> **Status (2026-07-27): implemented on both sides; pending E2E in dev.**
>
> - **Skill** (`simplifly-flyai-skill`): `recommend-book --session <dir> --plan <planId>` re-verifies
>   every ticket group of a recommended plan and emits `flight-plan-booking/v1` /
>   `flight.plan-booking` (`status: ready | changed | failed`, per-group diff vs the quoted facts,
>   fresh totals, `orderCount` / `splitOrder`). Fresh orderKeys never reach stdout: each group is
>   written into the session's `mapping.json` as a verified `OptionEntry` (append-only option
>   numbers, tag `book:<planId>`), so **`order-create --session <dir> --option <n>` works with all
>   its existing gates unchanged** (5-minute freshness, orderKey binding, transit gate, local
>   validation, `--confirm`). Prerequisites that landed with it: `recommend` now persists
>   `recommendation-continuation.json` unconditionally (it is the only durable planId → solutionId
>   mapping), and `publicRecommendationPlan` emits a real `canBook` (every emitted plan verified
>   with a single orderKey per group). Not gated on the continuation token or its expiry.
> - **TravelKit**: 预订这个方案 on the latest table (gated `capabilities.canBook`) sends one
>   intent turn; **passenger collection is conversational** (product decision 2026-07-28 after
>   dev E2E: operators hold passenger data as WeChat text or spreadsheets, so the agent asks and
>   fixes fields over chat — the earlier `PassengerForm` step was deleted). The prompt orders the
>   agent: collect first, then recommend-book, never order unconfirmed — so the 5-minute window
>   still opens only after passengers are ready. The parsed envelope (`src/frames.ts`
>   `parsePlanBooking`, fail-closed cross-checks) materializes `PlanBookingFlow`: `ConfirmGate`
>   with per-order rows, price diff and split-order notice, or the stale-page card. Confirm sends
>   `buildPlanOrderConfirmPrompt` — acknowledgements only, no PII rides that turn. A failed
>   re-verification banners the whole table (`recommendations-stale`) and withdraws booking
>   entries. Flow state: `planBookingFlowAtom` = `{ planId }`, deliberately SURVIVES ordinary
>   user turns (they are the collection); cleared on cancel/confirm/plan-vanish/session switch.
>   Button-built protocol prompts render as operator-action chips (`recognizeOperatorAction`),
>   not fake user speech.
> - **Decisions on the previously open items** — (1) split-order UX: the count is disclosed in the
>   confirm gate and acknowledged in the order prompt; partial failure is reported per order by the
>   agent, no automatic rollback (cancel is a separate user-confirmed write). (2) A failed
>   re-verification only marks the page stale and offers 重新报价 / 重试验价 buttons per the
>   envelope's capabilities — recommend never re-runs automatically. (3) No change threshold:
>   every `changed` result requires the second confirmation; any future threshold belongs in the
>   skill.
> - **Still genuinely open**: dev E2E (needs the skill change pushed to `main` — Rebyte installs
>   from there); structured order-result parsing stays a later milestone (agent prose reports
>   PNRs today, matching the legacy flow).

## Why this is a plan and not a task

`flight.recommendations` is the authoritative result and every plan it carries is already
verified, but nothing can be booked from one. The gap is on both sides, and the skill side is
the critical path.

**TravelKit.** `RecommendationTable` offers exactly two actions — Copy and 重新验价. There is no
book action, and `plan.capabilities.canBook` is parsed and validated in `src/frames.ts` with no
reader anywhere in `src/`. The order machinery that does exist — `WriteFlow`, `PassengerForm`,
`ConfirmGate`, `booking.ts` — is typed end to end on `FareVerification`
(`isBookableFare`, `passengersFromFare`, `journeyFacts`, `amountLine`, `buildOrderPrompt`), and
`derive()` clears `fare` whenever a recommendation exists, so that surface never renders on a
recommendation turn.

**Skill.** `order-create` books by **orderKey**, not by solutionId, and orderKey comes only from
`verify`. The recommendation pipeline verifies internally but keeps no orderKey — `orderKey`
does not appear in `scripts/lib/recommendation.ts` at all — and `publicRecommendationPlan`
emits neither solutionId nor orderKey. `order-create --session --option` addresses a *search*
session's option mapping; there is no plan-addressed booking path.

What the recommendation session does hold is enough to rebuild one:
`recommendation-continuation.json` (written by `recommend` itself, `flight.ts:2401`) persists
`candidatePlans` / `verifiedPlans`, and each ticket carries `candidate.solutionId`.

## The constraint everything else follows from

`VERIFICATION_FRESHNESS_MS` is 5 minutes, and `order-create` re-checks it at submit:

```ts
if (verificationAgeMs > VERIFICATION_FRESHNESS_MS)
  fail("verify_required", `... outside the 5-minute freshness window.`)
```

The real workflow is: operator copies the quote → sends it to the customer → the customer
answers minutes or hours later. **The verification behind a recommended plan is always stale by
the time anyone wants to book it.** Reusing it is not an option, so re-verification is a step in
the flow rather than an error path.

## Flow

```
[预订这个方案] on one plan
        |
        v
collect passengers first          ← the freshness window has not started yet
        |
        v
re-verify that plan's ticket groups by planId (fresh orderKey per group)
        |
        +-- all groups pass, nothing changed  -> confirm -> order
        |
        +-- all groups pass, something changed -> show the diff -> explicit
        |                                          confirmation -> order
        |
        +-- any group fails or expired         -> the plan is unbookable; the whole
                                                  recommendation page is stale, re-quote
```

**Passengers before re-verification.** Today the order flow runs verify → fare card → 继续预订 →
passenger form → confirm → order, so several passengers' passport details get typed *inside* the
5-minute window. Inverting it leaves the window covering only "read the diff, click confirm".

**A changed re-verification is confirmed, never auto-applied and never bounced.** Price, cabin or
baggage moving is the common case, not an edge case; the operator has already quoted a number to
the customer, so a write proceeds only after an explicit second confirmation. The verify path
already models the diff (`comparison.changedFields` → `changeNotice` in `src/frames.ts`); the same
shape carries here.

**All ticket groups or none.** A plan spanning several ticket groups verifies several solutions.
Half a round trip is not bookable, so any group failing fails the plan — the same rule the
recommendation pipeline already applies (`if (failed) continue`).

**One plan can be several orders.** Each ticket group books separately, so a multi-group plan is
N `order-create` calls and N PNRs. The skill refuses to hide this:

```
combined_order_not_supported — "This verified option is a multi-solution combination;
create separate orders after explicit split-order confirmation."
```

The confirmation surface must say so before the first order goes out, because order 1 succeeding
and order 2 failing leaves a customer holding half an itinerary.

**A failed plan invalidates the page, not just the plan.** All ten plans were verified in the same
moment and share one validity window. Sending the operator back to pick another from the same
table offers nine plans that will fail the same way. The failure path marks the table stale and
re-quotes. The wording matters too: the customer approved a specific plan at a specific price, so
this is 该方案已不可售，需要重新给客户报价 — not 请重新选择.

## Work split

**Skill (critical path — TravelKit cannot do this).** A plan-addressed booking command, e.g.
`recommend-book --session <dir> --plan <planId>`: resolve the plan's ticket groups from the
persisted session, re-verify each one, and return a versioned result carrying per-group fresh
verification, the resulting orderKeys, and the diff against what the plan originally showed.
Note it must not be gated on the *continuation* token's expiry — that clock is about paging.

**TravelKit.** A book action on the plan, the passenger step ahead of re-verification, a confirm
surface rendering the diff and the split-order notice, and per-group `order-create`. `PassengerForm`
and `ConfirmGate` are reusable as-is; what changes is the type feeding them.

## Do not delete on the way here

The legacy `search → verify → order` path currently renders in almost no session (local D1: 26
prompts with `flight-recommendations/v1`, 0 with `flight-verify/v1`). It still must not be removed
as dead code: it is the only order machinery in the repo, and this plan reuses its passenger and
confirmation steps. Cleaning the data pipeline is safe; cleaning the order machinery is not, until
the surfaces above exist.

## Still open

- Split-order UX for multi-group plans: what the operator sees, and what happens after a partial
  failure.
- Whether a failed re-verification re-runs `recommend` automatically or only marks the table stale.
- Whether any change threshold may skip the second confirmation. If one is ever introduced it
  belongs in the skill — it is a business judgement, not a contract check.
