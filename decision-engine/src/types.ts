export type CamelotKey = `${number}${"A" | "B"}`;

/** Cached analysis data needed to make a transition decision. */
export interface TrackMetadata {
  id: string;
  bpm: number;
  /** Musical key, such as `C major` or `F# minor`. */
  key: string;
  /** Normalized 0–1 energy score. Phase 1 can initially derive this from loudness/danceability. */
  energy: number;
  /** Optional analysis confidence from 0–1. Low-confidence tracks get conservative plans. */
  analysisConfidence?: number;
}

export type TransitionKind = "crossfade" | "hard-cut";

export interface TransitionPlan {
  kind: TransitionKind;
  /** Target playback rate for the incoming deck. 1 means no tempo adjustment. */
  incomingPlaybackRate: number;
  overlapSeconds: number;
  /** The crossfade must begin on a 32-beat (8-bar, 4/4) phrase boundary. */
  phraseAlignment: {
    beatsPerPhrase: 32;
    enabled: boolean;
  };
  scores: {
    total: number;
    bpm: number;
    harmonic: number;
    energy: number;
    confidence: number;
  };
  reasons: string[];
}

export interface DecisionOptions {
  /** Largest permitted tempo change for a crossfade. Defaults to 8%. */
  maxStretchPercent?: number;
  /** Below this, the engine chooses the safer hard cut. Defaults to 0.55. */
  minimumCrossfadeScore?: number;
  /** Below this, automated beat-grid scheduling is too uncertain for a blend. Defaults to 0.35. */
  minimumAnalysisConfidence?: number;
}
