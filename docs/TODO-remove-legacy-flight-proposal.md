# Cleanup: remove the legacy `flight.proposal` renderer and protocol adapter

## Why this is separate

`flight.recommendations` is now the authoritative normal recommendation result. TravelKit still keeps the older `flight-proposal/v1` parser and `FlightProposalTable` so saved conversations containing legacy tool results remain readable. Removing them in the comparison-table change would mix a history-compatibility migration with the new renderer and make regressions harder to isolate.

## Scope

- Inventory production and saved-history occurrences of `flight.proposal`.
- Decide and document the history compatibility window or migration strategy.
- Remove `parseProposal`, `FlightProposal` view models, `ChatBubble.proposal`, and the proposal precedence branch from `src/frames.ts`.
- Remove `FlightProposalTable.tsx`, its `ChatPanel` branch, proposal CSS, and proposal-specific tests.
- Update README/architecture docs that still describe the legacy proposal path.
- Keep or deprecate the FlyAI `proposal` CLI command as a separate decision: it may still serve explicit legacy workflows outside TravelKit and is not automatically deleted with the TravelKit renderer.

## Preconditions

- New sessions no longer emit `flight.proposal` as their normal final result.
- A representative saved-history audit shows either no required legacy frames or an approved migration/fallback.
- `flight.recommendations` covers Copy, verification state, mixed cabins, one-way, round-trip, joint/open-jaw, and multi-city output.

## Acceptance criteria

- No runtime references to `flight.proposal` or `FlightProposalTable` remain in TravelKit.
- Saved conversations behave according to the approved compatibility decision rather than silently losing their final result.
- Recommendation, frame precedence, typecheck, build, and browser tests remain green.
