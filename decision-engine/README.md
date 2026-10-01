# segue — Phase 2 decision engine

This folder is deliberately independent of Electron, Angular, audio decoding, and the existing Phase 0/1 proof-of-concepts. Its only job is to convert two tracks' cached analysis metadata into a deterministic transition plan.

## What it decides

- `crossfade` or `hard-cut`
- Incoming deck playback rate, constrained to an 8% tempo shift by default
- A 4, 8, 12, or 16-second overlap
- Whether to snap the transition to a 32-beat (8-bar, 4/4) phrase boundary

Key compatibility is evaluated on the Camelot wheel. In particular, `A minor` (8A) and `C major` (8B) are intentionally treated as compatible.

## Run

Install the dev dependencies, then run:

```sh
npm test
npm run typecheck
```

## Phase 3 handoff

Pass `decideTransition(outgoingTrack, incomingTrack)` the normalized output of Phase 1. Phase 3 should use its `incomingPlaybackRate`, `overlapSeconds`, and `phraseAlignment` fields when scheduling the two existing Web Audio deck chains.
