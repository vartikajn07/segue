import { SoundTouchNode } from "@soundtouchjs/audio-worklet";
import processorUrl from "@soundtouchjs/audio-worklet/processor?url";
import { decideTransition } from "../../decision-engine/src/index.ts";

const PHRASE_BEATS = 32;
const SCHEDULE_LEAD_SECONDS = 1;
// A 1% native-rate adjustment is about 0.17 semitones: inaudible for this harness,
// but it avoids putting near-matched tracks through a live WSOLA processor at all.
const PITCH_CORRECTION_THRESHOLD = 0.01;
// Feed a live SoundTouch worklet silently before its first audible beat to avoid startup underruns.
const WORKLET_PREROLL_SECONDS = 0.35;

const els = {
  fileA: document.querySelector("#fileA"),
  fileB: document.querySelector("#fileB"),
  analyze: document.querySelector("#analyzeBtn"),
  play: document.querySelector("#playBtn"),
  schedule: document.querySelector("#scheduleBtn"),
  stop: document.querySelector("#stopBtn"),
  status: document.querySelector("#status"),
  plan: document.querySelector("#plan"),
  diagnostics: document.querySelector("#diagnostics"),
};

const audioContext = new AudioContext();
let processorRegistered = false;
let currentDeck = null;
const activeDecks = new Set();
const tracks = { A: null, B: null };
const diagnostics = { mode: "idle", totalUnderruns: 0 };

function needsPitchCorrection(playbackRate) {
  // Decimal rates such as 0.99 cannot be represented exactly in binary floating point.
  return Math.abs(playbackRate - 1) - PITCH_CORRECTION_THRESHOLD > 0.000001;
}

function status(message) {
  els.status.textContent = message;
  console.log(`[Phase 3] ${message}`);
}
function setPlan(value) {
  els.plan.textContent = value;
}

function updateDiagnostics() {
  const heap = performance.memory
    ? `JS heap: ${(performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(0)} MB / ${(performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(0)} MB`
    : "JS heap: unavailable in this browser";
  els.diagnostics.textContent = [
    `Mode: ${diagnostics.mode}`,
    `Decks alive: ${activeDecks.size} | playback buffers retained: ${[tracks.A, tracks.B].filter((track) => track?.buffer).length}`,
    `SoundTouch underruns: ${diagnostics.totalUnderruns}`,
    heap,
  ].join("\n");
}

function memorySnapshot(stage) {
  const heap = performance.memory?.usedJSHeapSize;
  console.info("[Phase 3] memory snapshot", { stage, jsHeapMB: heap ? Number((heap / 1024 / 1024).toFixed(1)) : "unavailable" });
  updateDiagnostics();
}

function releasePlaybackBuffer(track) {
  // Stop keeps the two selected buffers so the harness can be replayed; normal handoff releases only the outgoing deck.
  if (!currentDeck || currentDeck.track === track || !track?.buffer) return;
  track.buffer = null;
  if (tracks.A === track) tracks.A = null;
  if (tracks.B === track) tracks.B = null;
  console.info("[Phase 3] released playback buffer", track.fileName);
  updateDiagnostics();
}

function downmixToMono(buffer) {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) mono[index] += samples[index] / buffer.numberOfChannels;
  }
  return mono;
}

async function decodeAnalysisSignal(file) {
  const analysisContext = new AudioContext({ sampleRate: 44100 });
  try {
    const buffer = await analysisContext.decodeAudioData(await file.arrayBuffer());
    return downmixToMono(buffer);
  } finally {
    await analysisContext.close();
  }
}

function analyzeInDisposableWorker(id, mono) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./analysis-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      worker.terminate(); // Releases Essentia/WASM memory before playback begins.
      if (data.ok) resolve(data);
      else reject(new Error(data.error));
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ id, monoBuffer: mono.buffer }, [mono.buffer]);
  });
}

async function analyzeFile(file, deckId) {
  status(`Preparing ${file.name} for worker analysis…`);
  diagnostics.mode = `analyzing Deck ${deckId}`;
  memorySnapshot(`before Deck ${deckId} analysis`);
  const mono = await decodeAnalysisSignal(file);
  const analysis = await analyzeInDisposableWorker(deckId, mono);
  memorySnapshot(`after Deck ${deckId} worker terminated`);

  status(`Decoding ${file.name} for playback…`);
  const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
  const track = { id: deckId, fileName: file.name, buffer, duration: buffer.duration, ...analysis };
  console.table({ deck: deckId, file: file.name, ...track.metadata, beatCount: track.beatTicks.length, ...track.rawAnalysis });
  return track;
}

async function ensureProcessorRegistered() {
  if (processorRegistered) return;
  await SoundTouchNode.register(audioContext, processorUrl);
  processorRegistered = true;
}

async function createDeck(
  track,
  {
    startAt,
    sourceOffset = 0,
    gain = 1,
    playbackRate = 1,
    pitchCorrect = false,
  },
) {
  const gainNode = audioContext.createGain();
  gainNode.gain.setValueAtTime(gain, startAt);
  gainNode.connect(audioContext.destination);

  const source = audioContext.createBufferSource();
  source.buffer = track.buffer;
  source.playbackRate.setValueAtTime(playbackRate, startAt);

  let stretchNode = null;
  if (pitchCorrect) {
    await ensureProcessorRegistered();
    // FIFO buffering is more resilient to a streaming source than the library's circular default.
    stretchNode = new SoundTouchNode({
      context: audioContext,
      sampleBufferType: "fifo",
    });
    stretchNode.playbackRate.value = playbackRate;
    stretchNode.pitch.value = 1;
    let lastUnderrunCount = 0;
    stretchNode.addEventListener("metrics", (event) => {
      const metrics = event.detail;
      if (metrics.underrunCount > lastUnderrunCount) {
        console.warn("[Phase 3] SoundTouch underrun", metrics);
        status(
          `SoundTouch underrun detected (${metrics.underrunCount}/${metrics.blockCount} blocks). See DevTools.`,
        );
        lastUnderrunCount = metrics.underrunCount;
        diagnostics.totalUnderruns = Math.max(diagnostics.totalUnderruns, metrics.underrunCount);
        updateDiagnostics();
      }
    });
    source.connect(stretchNode);
    stretchNode.connect(gainNode);
  } else {
    source.connect(gainNode);
  }
  source.start(startAt, sourceOffset);
  const deck = {
    track,
    source,
    gainNode,
    stretchNode,
    startAt,
    sourceOffset,
    playbackRate,
    pitchCorrect,
  };
  activeDecks.add(deck);
  source.addEventListener("ended", () => {
    activeDecks.delete(deck);
    releasePlaybackBuffer(deck.track);
    updateDiagnostics();
  }, { once: true });
  updateDiagnostics();
  return deck;
}

function phraseBoundaryAfter(deck, minimumTime) {
  const { beatTicks } = deck.track;
  for (let index = 0; index < beatTicks.length; index += PHRASE_BEATS) {
    const boundaryTime =
      deck.startAt + (beatTicks[index] - deck.sourceOffset) / deck.playbackRate;
    if (boundaryTime >= minimumTime)
      return { index, sourceTime: beatTicks[index], contextTime: boundaryTime };
  }
  return null;
}

function automateEqualPower(outgoingGain, incomingGain, startAt, duration) {
  const points = 64;
  const fadeOut = new Float32Array(points);
  const fadeIn = new Float32Array(points);
  for (let index = 0; index < points; index += 1) {
    const position = index / (points - 1);
    fadeOut[index] = Math.cos((position * Math.PI) / 2);
    fadeIn[index] = Math.sin((position * Math.PI) / 2);
  }
  outgoingGain.gain.cancelScheduledValues(startAt);
  incomingGain.gain.cancelScheduledValues(startAt);
  outgoingGain.gain.setValueAtTime(1, startAt);
  incomingGain.gain.setValueAtTime(0, startAt);
  outgoingGain.gain.setValueCurveAtTime(fadeOut, startAt, duration);
  incomingGain.gain.setValueCurveAtTime(fadeIn, startAt, duration);
}

function renderPlan(plan, boundary, execution) {
  setPlan(
    [
      `Decision: ${plan.kind} | overlap: ${plan.overlapSeconds}s | incoming rate: ${plan.incomingPlaybackRate}`,
      `Phrase boundary: beat ${boundary.index + 1} at source ${boundary.sourceTime.toFixed(3)}s / AudioContext ${boundary.contextTime.toFixed(3)}s`,
      `Playback: ${execution.pitchCorrect ? `SoundTouch FIFO + ${execution.preroll.toFixed(2)}s silent pre-roll` : "native rate only (pitch correction bypassed)"}`,
      `Scores: ${JSON.stringify(plan.scores)}`,
      `Reasons: ${plan.reasons.join("; ")}`,
    ].join("\n"),
  );
}

function stopAll() {
  for (const deck of activeDecks) {
    try {
      deck.source.stop();
    } catch {
      /* already stopped */
    }
  }
  activeDecks.clear();
  currentDeck = null;
  diagnostics.mode = "stopped";
  els.schedule.disabled = true;
  els.stop.disabled = true;
  status("Stopped.");
  updateDiagnostics();
}

function updateAnalyzeButton() {
  els.analyze.disabled = !(els.fileA.files[0] && els.fileB.files[0]);
}
els.fileA.addEventListener("change", updateAnalyzeButton);
els.fileB.addEventListener("change", updateAnalyzeButton);

els.analyze.addEventListener("click", async () => {
  els.analyze.disabled = true;
  try {
    stopAll();
    tracks.A = await analyzeFile(els.fileA.files[0], "A");
    tracks.B = await analyzeFile(els.fileB.files[0], "B");
    const { A: a, B: b } = tracks;
    els.play.disabled = false;
    setPlan(
      `Analysis complete.\nA: ${JSON.stringify(a.metadata)}\nB: ${JSON.stringify(b.metadata)}`,
    );
    diagnostics.mode = "ready";
    status("Analysis complete. Start Deck A, then schedule one transition.");
    memorySnapshot("analysis complete");
  } catch (error) {
    console.error(error);
    status(`Analysis failed: ${error.message}`);
  } finally {
    updateAnalyzeButton();
  }
});

els.play.addEventListener("click", async () => {
  await audioContext.resume();
  stopAll();
  const startAt = audioContext.currentTime + 0.05;
  const deckA = await createDeck(tracks.A, { startAt });
  deckA.source.addEventListener(
    "ended",
    () => {
      if (currentDeck === deckA) stopAll();
    },
    { once: true },
  );
  currentDeck = deckA;
  diagnostics.mode = "Deck A playing";
  els.schedule.disabled = false;
  els.stop.disabled = false;
  status(`Deck A started at AudioContext ${startAt.toFixed(3)}s.`);
  updateDiagnostics();
});

els.schedule.addEventListener("click", async () => {
  if (!currentDeck || !tracks.B) return;
  const plan = decideTransition(currentDeck.track.metadata, tracks.B.metadata);
  const pitchCorrect =
    plan.kind === "crossfade" &&
    needsPitchCorrection(plan.incomingPlaybackRate);
  diagnostics.totalUnderruns = 0;
  const preroll = pitchCorrect ? WORKLET_PREROLL_SECONDS : 0;
  // Worklet registration can take longer than the scheduling lead; do it before choosing a boundary.
  if (pitchCorrect) await ensureProcessorRegistered();
  const boundary = phraseBoundaryAfter(
    currentDeck,
    audioContext.currentTime + SCHEDULE_LEAD_SECONDS,
  );
  if (!boundary) {
    status(
      "No remaining 32-beat phrase boundary in Deck A; restart with a longer track.",
    );
    return;
  }
  renderPlan(plan, boundary, { pitchCorrect, preroll });
  console.group("[Phase 3] transition plan");
  console.log({
    plan,
    boundary,
    pitchCorrect,
    preroll,
    contextNow: audioContext.currentTime,
  });
  console.groupEnd();
  els.schedule.disabled = true;

  if (plan.kind === "hard-cut") {
    const incoming = await createDeck(tracks.B, {
      startAt: boundary.contextTime,
    });
    const outgoing = currentDeck;
    outgoing.source.stop(boundary.contextTime + 0.015);
    incoming.source.addEventListener(
      "ended",
      () => {
        if (currentDeck === incoming) stopAll();
      },
      { once: true },
    );
    currentDeck = incoming;
    diagnostics.mode = "Deck B playing after hard cut";
    status(`Hard cut scheduled at ${boundary.contextTime.toFixed(3)}s.`);
    updateDiagnostics();
    return;
  }

  const sourceAdvanceBeforeFade = preroll * plan.incomingPlaybackRate;
  const incomingBeatIndex = tracks.B.beatTicks.findIndex(
    (tick) => tick >= sourceAdvanceBeforeFade,
  );
  const incomingBeatTick =
    tracks.B.beatTicks[incomingBeatIndex >= 0 ? incomingBeatIndex : 0] ?? 0;
  const incomingOffset = Math.max(
    0,
    incomingBeatTick - sourceAdvanceBeforeFade,
  );
  const incoming = await createDeck(tracks.B, {
    startAt: boundary.contextTime - preroll,
    sourceOffset: incomingOffset,
    gain: 0,
    playbackRate: plan.incomingPlaybackRate,
    pitchCorrect,
  });
  automateEqualPower(
    currentDeck.gainNode,
    incoming.gainNode,
    boundary.contextTime,
    plan.overlapSeconds,
  );
  const outgoing = currentDeck;
  outgoing.source.stop(boundary.contextTime + plan.overlapSeconds + 0.05);
  incoming.source.addEventListener(
    "ended",
    () => {
      if (currentDeck === incoming) stopAll();
    },
    { once: true },
  );
  currentDeck = incoming;
  diagnostics.mode = "Crossfading A → B";
  status(
    `Crossfade scheduled at ${boundary.contextTime.toFixed(3)}s for ${plan.overlapSeconds}s. Incoming beat ${incomingBeatIndex + 1} aligns at the fade start; ${pitchCorrect ? "SoundTouch pre-roll enabled." : "pitch correction bypassed."}`,
  );
  updateDiagnostics();
});

els.stop.addEventListener("click", stopAll);
updateDiagnostics();
