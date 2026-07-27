# TODO: lightweight agent activity in the TravelKit chat stream

## Context

- Source case: cross-eval 0721, Case 8.
- Run: <https://app.rebyte.ai/run/36c608c9-4d63-4b66-9249-2092d1f3ed56>
- User request: “后天北京到圣地亚哥的航班。”
- Observed execution: the Agent detected that “圣地亚哥” was ambiguous, emitted a clarification action, waited for the user, then completed the flight recommendation after the user specified Chile.
- Product symptom: TravelKit removes almost all intermediate Agent activity. A normal recommendation can finish in about two minutes, but the user sees only a generic “正在处理…” state and cannot tell whether the request is being understood, delegated, searched, or verified.

This is a TravelKit product task. It is not a FlyAI recommendation-quality change.

## Current code facts

- `worker/task-do.ts` already stores normalized assistant `tool_use` and user `tool_result` frames.
- Delegated sub-prompt tool frames are replayed into the parent prompt by `TaskDO.replaySubPrompt()`.
- `src/frames.ts` currently turns assistant text and recognized domain `tool_result` payloads into chat bubbles and cards, but ignores ordinary `tool_use` frames.
- `src/components/ChatPanel.tsx` renders a single generic `正在处理…` bubble while a turn is running.
- TravelKit intentionally does not render model thinking, raw shell commands, arbitrary tool results, or the delegated sub-agent’s prose.
- The product does not depend on a structured `ask_user_question` form/resume protocol. Clarification must remain usable through the normal chat composer.

## Goal

Show a small, safe, truthful execution summary while a turn is running so that the user can understand what the system is doing without exposing raw traces.

The UI should answer only:

1. Has the request started?
2. Which product capability is being used?
3. Is the system clarifying, searching, verifying, or assembling the result?
4. Is it still running, complete, or blocked on the user?

## Non-goals

- Do not render chain-of-thought, reasoning text, hidden prompts, arbitrary sub-agent prose, shell commands, file paths, request bodies, stdout, diagnostics, credentials, or tokens.
- Do not rebuild the Rebyte run inspector inside TravelKit.
- Do not show every tool call as a separate chat message.
- Do not infer flight facts, progress percentages, remaining time, or success before a structured result exists.
- Do not reintroduce a special ask/answer form protocol.
- Do not change `flight.recommendations` ownership or let TravelKit rank/filter plans.

## Proposed interaction

### While running

Render one compact activity block at the tail of the assistant turn. Update that block in place as safe events arrive.

Example:

```text
正在处理
✓ 已交给航班助手
✓ 已读取 FlyAI Skill
• 正在搜索并验价航班
已用时 1分12秒
```

Rules:

- Show at most the latest three distinct milestones.
- Collapse duplicate events.
- Use elapsed time, not a fabricated percentage or ETA.
- Keep the existing generic running state when no whitelisted event has arrived.
- On completion, collapse the block to one muted line such as `已使用 FlyAI · 已完成搜索与验价`; the authoritative result card remains the primary content.
- On error, retain the last truthful milestone and show the existing error state separately.

### Clarification

When a tool name matches an approved clarification action such as `ask_user_question__ask_user_question`:

- Extract only the user-facing question and bounded option labels from the tool input.
- Render the question as a normal assistant chat bubble.
- Let the user answer through the existing composer.
- Do not render the tool name, raw JSON, internal action ID, or a custom interactive form.
- If a safe question cannot be extracted, show `需要补充信息，请查看运行详情` and retain the Rebyte run link.

This preserves Case 8’s clarification even though TravelKit does not support a structured ask/answer UI.

## Safe activity model

Add a pure view-model layer, for example:

```ts
type AgentActivityKind =
  | 'delegating'
  | 'skill'
  | 'searching'
  | 'verifying'
  | 'clarification'
  | 'complete'

interface AgentActivity {
  id: string
  kind: AgentActivityKind
  label: string
  state: 'done' | 'active' | 'blocked'
  seq: number
}
```

The mapper must be allowlist-based. Unknown tools produce no activity.

Initial mapping candidates:

| Evidence in stored frame | Safe label |
| --- | --- |
| Parent delegation/coding-agent action | 已交给航班助手 |
| A Skill read whose path/name proves `simplifly-flyai-skill` | 已读取 FlyAI Skill |
| `flight.ts recommend` execution | 正在搜索并验价航班 |
| `flight.ts pricing` | 正在查询指定航班价格 |
| `flight.ts verify` | 正在确认实时价格与可售性 |
| Approved clarification action | 需要补充信息 |
| Valid `flight.recommendations` result | 已完成搜索与验价 |

Do not display “已使用 FlyAI Skill” solely because the session was configured with a Skill reference. Require an observed frame that supports the statement.

## Implementation outline

1. Add a pure frame-to-activity mapper, preferably outside the large recommendation parser.
2. Extend `ChatBubble` or `DerivedView` with one turn-scoped activity summary.
3. Pair tool uses/results by tool ID where completion state matters.
4. Dedupe parent-stream and replayed sub-prompt copies deterministically.
5. Render one compact, accessible component inside the existing single-column chat stream.
6. Preserve activity on reload by deriving it from stored frames rather than React-only state.
7. Keep the Rebyte run link as the escape hatch for full internal inspection.

## Security requirements

- Never render tool arguments by default.
- Never render `.simplifly.env`, environment variables, authorization headers, tokens, file contents, raw request JSON, or raw command strings.
- Sanitize and bound clarification text before rendering.
- Unknown tools and unknown fields fail closed to no activity.
- Domain results continue through their existing strict versioned parsers.

## Deterministic coverage

Add pure tests for:

- unknown tool frames produce no activity;
- duplicate replayed tool calls produce one milestone;
- Skill read and `flight.ts recommend` map to the expected safe labels;
- raw command, path, request body and token-shaped values never appear in labels;
- clarification tool input becomes one ordinary assistant question;
- malformed clarification input fails closed;
- refresh/reload derives the same activity list;
- valid recommendation completion changes the active milestone to complete;
- no activity summary changes recommendation parsing or card precedence.

## Acceptance criteria

- A two-minute recommendation shows useful activity before the final result.
- Case 8’s ambiguity question is visible as a normal assistant message and can be answered in the standard composer.
- The UI never exposes raw trace details or credentials.
- Activity survives page reload and does not duplicate after sub-prompt replay.
- Final recommendation cards remain authoritative and visually primary.
- Keyboard, screen-reader and reduced-motion behavior meet the existing TravelKit accessibility rules.
- `pnpm test`, `pnpm typecheck` and `pnpm build` pass.

## Open decisions

1. Whether the completed activity line remains expanded by default or collapses automatically.
2. The exact allowlist of Rebyte tool names observed in production for delegation, Skill reads and flight CLI execution.
3. Whether a clarification action should suppress the generic `正在处理…` indicator while the task is blocked on the user.

