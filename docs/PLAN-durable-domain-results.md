# Durable Domain Results Plan

## Objective

Make customer-facing structured results independent from Rebyte and Claude Code transport details.

For every valid `flight.recommendations/v1` produced by the Skill, TravelKit must render exactly one `FlightRecommendationsView` after live streaming, reconnect, terminal drain, page refresh, and historical replay. Changes to activity UI, Markdown rendering, tool visibility, or message ordering must not affect that invariant.

## Current failure boundary

`src/frames.ts` currently performs three unrelated jobs in one projection pass:

1. Decode executor transport such as direct `Bash`, complete `TaskOutput`, and truncated `TaskOutput → Read`.
2. Validate business contracts such as `flight.recommendations/v1`.
3. Assemble chat bubbles, strip Markdown tables, and choose React views.

The table exists only when this pass happens to assign and retain `pendingRecommendations`. A change to tool filtering, frame ordering, or message assembly can therefore remove the table without producing an explicit error.

## Non-negotiable invariants

1. `flight.recommendations/v1` is the only authoritative final recommendation.
2. Raw `Bash`, `TaskOutput`, and `Read` events never reach the UI as business inputs.
3. A valid domain result is normalized once at the TravelKit worker/server boundary.
4. New normalized results are persisted in the same durable frame that caused recognition, so SSE and reload observe the same object.
5. Historical raw frames are normalized by the same pure function on `GET /content`; the browser has no legacy transport parser.
6. Domain state is monotonic within a prompt. Later text, activity, search, verify, or replay events cannot erase a valid recommendation.
7. A successful recommend execution with no normalized recommendation is an explicit invariant failure, not a silent Markdown fallback.
8. Arbitrary `Read` output cannot publish domain data. A `Read` is trusted only when its exact `file_path` was announced by a successful, completed `TaskOutput`.

## Target architecture

```text
Relay / delegated prompt events
        |
        v
normalizeDomainFrames(raw frames)
  - correlate tool_use and tool_result
  - unwrap direct Bash / TaskOutput / trusted output-file Read
  - parse and validate versioned business contracts
        |
        v
stored frame.data.__domain_results[]
        |
        +---- SSE live frame
        |
        +---- GET /content reload
                        |
                        v
projectPromptDomainState()
  - deterministic precedence
  - conflict detection
  - no transport knowledge
                        |
                        v
assembleChat()
  - prose
  - activity
  - exactly one structured result view
```

## Canonical frame contract

Add an internal, versioned field to the existing durable frame:

```ts
interface NormalizedDomainResult {
  adapterVersion: 1
  resultType:
    | 'flight.search'
    | 'flight.verify'
    | 'flight.proposal'
    | 'flight.recommendations'
  schemaVersion: string
  payload: unknown
  source: {
    toolUseId: string
    toolName: string
  }
}

interface StoredFrameData {
  // Existing assistant/user frame fields remain unchanged.
  __domain_results?: NormalizedDomainResult[]
}
```

The payload is added only after runtime contract validation. Credentials, commands, environment variables, and file paths are never copied into `__domain_results`.

Using the existing source frame avoids a second sequence allocator and preserves the current `(prompt_id, source_sub_prompt_id, source_event_index)` replay idempotency.

## Implementation phases

### Phase 1: Extract pure transport normalization

Create `server/domain-results.ts`.

Move all executor-specific parsing out of `src/frames.ts`:

- direct JSON stdout;
- shell bookkeeping after JSON;
- complete `TaskOutput`;
- truncated `TaskOutput` full-output path;
- exact subsequent `Read`;
- Claude Code numbered `Read` lines;
- tool error and non-zero exit handling.

Expose:

```ts
function normalizeDomainFrames(
  frames: Array<{ seq: number; data: unknown }>,
): Array<{ seq: number; results: NormalizedDomainResult[] }>
```

The function scans the full ordered frame list and returns results attached to their publishing frame. It is pure, deterministic, and idempotent.

Move business contract parsers into shared modules:

- `shared/flight-search-contract.ts`
- `shared/flight-verify-contract.ts`
- `shared/flight-proposal-contract.ts`
- `shared/flight-recommendations-contract.ts`

Both worker/server normalization and TypeScript UI types import these modules. The UI does not independently reinterpret unknown payloads.

### Phase 2: Persist normalization at ingestion

Change `TaskDO.emitToolResult()` in `worker/task-do.ts`:

1. Build the candidate raw `tool_result` frame.
2. Load the prompt's prior stored frames with `framesSince(promptId, 0)`.
3. Run `normalizeDomainFrames([...priorFrames, candidateFrame])`.
4. Attach only results published by the candidate frame as `data.__domain_results`.
5. Persist and stream that single enriched frame through the existing `emit()` path.

This covers both manager events and frames replayed by `replaySubPrompt()` without adding a separate database sequence or result table.

The expected prompt size is small enough for an initial full scan. Add timing instrumentation; optimize to incremental state only if production traces show this scan is material.

### Phase 3: Normalize historical content at the server boundary

Change `GET /tasks/:id/content` in `server/routes.ts`:

1. Load stored frames.
2. Run `normalizeDomainFrames(frames)`.
3. For legacy frames without `__domain_results`, attach the computed normalized results in the response.
4. Preserve persisted `__domain_results` as canonical and verify that recomputation agrees in development/test builds.

This gives saved conversations the same stable API contract without making the browser retain a legacy transport parser or requiring a destructive D1 rewrite.

### Phase 4: Split domain projection from chat assembly

Create `src/domain-state.ts`:

```ts
function projectPromptDomainState(
  results: NormalizedDomainResult[],
): PromptDomainState
```

Rules:

- `flight.recommendations` is authoritative for the prompt.
- Identical replayed results deduplicate by stable payload signature.
- Multiple different plan-bearing recommendations fail closed.
- Search and verify remain evidence when a recommendation exists.
- Later prose, tool events, and activity events cannot clear recommendation state.

Refactor `src/frames.ts` so it:

1. collects `__domain_results`;
2. calls `projectPromptDomainState`;
3. assembles prose, activity, questions, and one domain view at the prompt tail.

Delete all `Bash`, `TaskOutput`, `Read`, stdout, and numbered-line parsing from the client bundle.

Markdown table stripping is based only on the presence of an authoritative structured domain result. It is no longer evidence that a result exists.

### Phase 5: Make missing normalization visible

The normalizer also emits a non-sensitive diagnostic when it observes:

- a successful `flight.ts recommend` execution;
- no valid `flight.recommendations` after the prompt reaches terminal.

The customer UI shows a compact structured-result error with retry capability. It does not silently accept the Agent's Markdown table as the final recommendation.

Log fields are limited to:

- prompt ID;
- adapter version;
- source tool name;
- schema/result type when discoverable;
- failure category.

Do not log raw stdout, file paths, command text, tokens, or request payloads.

## Regression suite

### Sanitized real-trace corpus

Add `server/fixtures/domain-results/` with minimized, credential-free traces representing:

1. direct Bash JSON;
2. complete foreground result;
3. complete `TaskOutput`;
4. truncated `TaskOutput → exact Read`;
5. unrelated Read containing schema text;
6. failed/non-zero TaskOutput;
7. duplicated delegated replay;
8. final text before and after the domain result;
9. reconnect and terminal-tail replay;
10. two different plan-bearing recommendations.

Include the two real production-shaped cases that exposed the current defects:

- 10-plan Shanghai–Chengdu result returned by complete `TaskOutput`;
- 10-plan Taipei–Rome result returned by truncated `TaskOutput → Read`.

Fixtures must remove tokens, sandbox paths, user identifiers, and unrelated prose.

### Required invariant tests

For every valid recommendation trace:

```ts
assert.equal(view.recommendations?.plans.length, expectedPlanCount)
assert.equal(view.chat.filter((b) => b.recommendations).length, 1)
assert.equal(renderedHtml.match(/<table class="recommend-table">/g)?.length, 1)
assert.equal(visibleMarkdownTableCount, 0)
```

Run the same trace through:

- live frame accumulation one frame at a time;
- complete `/content` reload;
- duplicated replay;
- unrelated activity/tool frames inserted between every original frame.

The final structured result must be identical in all runs.

### Ownership tests

- `server/domain-results.test.ts` owns transport normalization.
- Contract modules own runtime validation.
- `server/domain-state.test.ts` owns precedence, dedupe, and conflict behavior.
- `server/frames.test.ts` owns chat ordering only.
- `server/flight-recommendations.test.ts` owns rendered table semantics.

No chat/activity test may construct raw `TaskOutput` or `Read` events after this migration.

## Rollout sequence

1. Add pure normalizer, shared contract modules, and real-trace tests without changing production behavior.
2. Enrich newly persisted tool-result frames with `__domain_results`.
3. Add `/content` legacy normalization.
4. Switch `projectPromptDomainState` to normalized results.
5. Remove client transport parsing.
6. Add invariant diagnostic and explicit structured-result error.
7. Run focused tests, full tests, typecheck, production build, and Playwright CLI against:
   - a fresh short result;
   - a fresh oversized result;
   - both saved historical conversations.

## Acceptance criteria

- A valid recommendation always produces exactly one structured table.
- Refreshing or reconnecting produces the same table without rerunning the Skill.
- Activity UI and message-list changes cannot affect domain extraction tests.
- Oversized stdout does not require a new UI parser branch.
- Arbitrary Read/tool documentation cannot become a business result.
- No raw executor transport parsing remains in `src/`.
- Missing normalization is explicit and diagnosable.
- The sanitized real-trace corpus runs in CI.

## Deliberate exclusions

- Do not change cctools or the Rebyte public event schema for this fix.
- Do not copy FlyAI Skill recommendation logic into TravelKit.
- Do not infer recommendation facts from Agent Markdown.
- Do not add a second domain-results database table unless profiling proves enriching the source frame is insufficient.
