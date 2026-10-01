# segue — Phase 3 integration harness

This is an intentionally isolated browser harness. It does not alter the Phase 0 crossfade POC, the Phase 1 analysis POC, or the Phase 2 decision engine.

## What it proves

1. Two local files can be analyzed with Essentia.
2. Their normalized analysis data drives `decideTransition` directly.
3. The resulting plan schedules either a SoundTouch crossfade or a hard cut on an outgoing 32-beat phrase boundary.

For stability, tempo changes of 1% or less use the browser's native playback rate rather than a pitch-correction worklet. Larger changes use SoundTouch with FIFO buffering and a 350 ms silent pre-roll. DevTools reports any SoundTouch underruns.

Analysis runs in a one-shot Worker per track. The Worker terminates as soon as it returns metadata, releasing Essentia's WASM heap before playback. The harness retains only the two selected playback buffers.

For safety, the decision engine hard-cuts rather than auto-crossfades when either track's normalized analysis confidence is below `0.35`.

The harness assumes 4/4 and treats the first detected incoming beat as its entry point. It schedules one transition only. These are deliberate Phase 3 constraints, not v1 behavior.

## Run

```sh
npm install
npm run dev
```

Open the local URL shown by Vite. Load two local audio files, analyze them, play Deck A, and schedule the transition. Keep DevTools open for the complete analysis, decision, and scheduling log.

## Observe

- The plan shown in the page must use detected, not manually entered, BPM/key/energy values.
- A crossfade must start at the logged outgoing phrase boundary.
- A hard cut must not instantiate SoundTouch or apply a tempo adjustment.
- Repeat runs must not leave overlapping audio playing.
