import assert from "node:assert/strict";
import test from "node:test";
import {
  decideTransition,
  harmonicCompatibility,
  toCamelot,
} from "../src/index.js";

const outgoing = {
  id: "outgoing",
  bpm: 124,
  key: "A minor",
  energy: 0.7,
  analysisConfidence: 0.9,
};

test("maps musical keys to Camelot codes", () => {
  assert.equal(toCamelot("C major"), "8B");
  assert.equal(toCamelot("A minor"), "8A");
  assert.equal(toCamelot("not a key"), null);
});

test("treats relative major/minor as compatible", () => {
  assert.equal(harmonicCompatibility("A minor", "C major"), 0.9);
  assert.equal(harmonicCompatibility("A minor", "E minor"), 0.82);
});

test("creates a phrase-aligned crossfade for compatible tracks", () => {
  const plan = decideTransition(outgoing, {
    id: "incoming",
    bpm: 126,
    key: "C major",
    energy: 0.68,
    analysisConfidence: 0.9,
  });
  assert.equal(plan.kind, "crossfade");
  assert.equal(plan.incomingPlaybackRate, 0.984);
  assert.equal(plan.overlapSeconds, 16);
  assert.deepEqual(plan.phraseAlignment, { beatsPerPhrase: 32, enabled: true });
});

test("uses a hard cut when beatmatching would exceed the stretch limit", () => {
  const plan = decideTransition(outgoing, {
    id: "incoming",
    bpm: 105,
    key: "C major",
    energy: 0.7,
  });
  assert.equal(plan.kind, "hard-cut");
  assert.equal(plan.incomingPlaybackRate, 1);
  assert.equal(plan.overlapSeconds, 0);
  assert.match(plan.reasons.join(" "), /exceeds/);
});

test("shortens a safe blend when energy changes sharply", () => {
  const plan = decideTransition(outgoing, {
    id: "incoming",
    bpm: 124,
    key: "A minor",
    energy: 0.1,
  });
  assert.equal(plan.kind, "crossfade");
  assert.equal(plan.overlapSeconds, 4);
});

test("uses a hard cut when analysis confidence is too low to trust the beat grid", () => {
  const plan = decideTransition(outgoing, {
    id: "incoming",
    bpm: 124,
    key: "A minor",
    energy: 0.7,
    analysisConfidence: 0.2,
  });
  assert.equal(plan.kind, "hard-cut");
  assert.equal(plan.overlapSeconds, 0);
  assert.match(plan.reasons.join(" "), /auto-crossfade limit/);
});
