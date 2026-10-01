import { harmonicCompatibility } from "./camelot.js";
import type { DecisionOptions, TrackMetadata, TransitionPlan } from "./types.js";

const DEFAULT_OPTIONS: Required<DecisionOptions> = {
  maxStretchPercent: 8,
  minimumCrossfadeScore: 0.55,
  minimumAnalysisConfidence: 0.35,
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function assertTrack(track: TrackMetadata): void {
  if (!Number.isFinite(track.bpm) || track.bpm <= 0) throw new Error(`${track.id}: bpm must be positive`);
  if (!Number.isFinite(track.energy) || track.energy < 0 || track.energy > 1) {
    throw new Error(`${track.id}: energy must be between 0 and 1`);
  }
}

/** Returns a deterministic, renderer-safe plan. It performs no I/O or audio work. */
export function decideTransition(
  outgoing: TrackMetadata,
  incoming: TrackMetadata,
  options: DecisionOptions = {},
): TransitionPlan {
  assertTrack(outgoing);
  assertTrack(incoming);
  const config = { ...DEFAULT_OPTIONS, ...options };
  const rate = outgoing.bpm / incoming.bpm;
  const stretchPercent = Math.abs(1 - rate) * 100;
  const bpmScore = clamp(1 - stretchPercent / config.maxStretchPercent);
  const harmonic = harmonicCompatibility(outgoing.key, incoming.key);
  const energyDelta = Math.abs(outgoing.energy - incoming.energy);
  const energyScore = 1 - energyDelta;
  const confidence = Math.min(outgoing.analysisConfidence ?? 1, incoming.analysisConfidence ?? 1);
  const total = 0.35 * bpmScore + 0.3 * harmonic + 0.2 * energyScore + 0.15 * confidence;
  const canStretch = stretchPercent <= config.maxStretchPercent;
  const confidenceSafe = confidence >= config.minimumAnalysisConfidence;
  const kind = canStretch && confidenceSafe && total >= config.minimumCrossfadeScore ? "crossfade" : "hard-cut";

  const reasons: string[] = [];
  if (!canStretch) reasons.push(`tempo change ${rounded(stretchPercent)}% exceeds ${config.maxStretchPercent}% limit`);
  if (harmonic >= 0.9) reasons.push("Camelot-compatible key change");
  else if (harmonic >= 0.82) reasons.push("adjacent Camelot wheel move");
  else reasons.push("weak harmonic fit");
  if (confidence < 0.65) reasons.push("analysis confidence is low; using conservative transition settings");
  if (!confidenceSafe) reasons.push(`analysis confidence ${rounded(confidence)} is below ${config.minimumAnalysisConfidence} auto-crossfade limit`);
  if (kind === "hard-cut") reasons.push("hard cut selected to avoid an unsafe blend");

  // Larger energy changes need a shorter overlap; harmonious, similar-energy tracks can breathe longer.
  const overlapSeconds = kind === "hard-cut" ? 0 : energyDelta > 0.55 ? 4 : energyDelta > 0.3 ? 8 : harmonic >= 0.82 ? 16 : 12;
  return {
    kind,
    incomingPlaybackRate: kind === "crossfade" ? rounded(rate) : 1,
    overlapSeconds,
    phraseAlignment: { beatsPerPhrase: 32, enabled: kind === "crossfade" },
    scores: { total: rounded(total), bpm: rounded(bpmScore), harmonic, energy: rounded(energyScore), confidence: rounded(confidence) },
    reasons,
  };
}
