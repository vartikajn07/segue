import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";
import Essentia from "essentia.js/dist/essentia.js-core.es.js";

const fileInput = document.getElementById("fileInput");
const analyzeBtn = document.getElementById("analyzeBtn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const knownBpmInput = document.getElementById("knownBpm");
const knownKeyInput = document.getElementById("knownKey");

let essentia = null;
let selectedFile = null;

// --- Init essentia.js WASM backend ---
// EssentiaWASM here is the Emscripten module object; `.ready` resolves once
// the WASM binary (base64-inlined in this ES build) has finished compiling.
async function initEssentia() {
  statusEl.textContent = "Loading essentia.js WASM backend...";
  await EssentiaWASM.ready;
  essentia = new Essentia(EssentiaWASM);
  statusEl.textContent = `essentia.js ready (v${essentia.version})`;
  // console.log("essentia.js algorithms available:", essentia.algorithmNames);
}

initEssentia().catch((err) => {
  statusEl.textContent = "Failed to load essentia.js — see console";
  console.error(err);
});

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files[0] || null;
  analyzeBtn.disabled = !selectedFile || !essentia;
});

analyzeBtn.addEventListener("click", async () => {
  if (!selectedFile || !essentia) return;
  analyzeBtn.disabled = true;
  statusEl.textContent = "Decoding audio...";
  resultsEl.innerHTML = "";

  try {
    // essentia's rhythm/key algorithms hard-require a 44100 Hz signal internally
    // (this is documented in essentia's own source, not just a recommendation) —
    // they do NOT error on other rates, they silently produce wrong results scaled
    // by the ratio of actual-rate/44100. Forcing sampleRate here, rather than
    // trusting the system/browser default (often 48000 Hz), is what fixes that.
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 44100,
    });
    const arrayBuffer = await selectedFile.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    // Downmix to mono Float32Array — essentia algorithms expect single-channel signal.
    const monoSignal = essentia.audioBufferToMonoSignal(audioBuffer);

    // essentia's WASM-bound algorithms require its own VectorFloat type, not a
    // plain JS typed array — audioBufferToMonoSignal only gets you to Float32Array.
    // This conversion is mandatory before any algorithm call; skipping it is what
    // produced the "Cannot pass ... as a VectorFloat" BindingError.
    const signalVector = essentia.arrayToVector(monoSignal);

    statusEl.textContent =
      "Running RhythmExtractor2013 (multifeature method)...";
    // Yield to the browser so the status text actually paints before the
    // (synchronous, potentially multi-second) WASM analysis call blocks the thread.
    await new Promise((r) => setTimeout(r, 0));

    // multifeature: slower, fuses several onset-detection functions, and is the
    // only method whose confidence output is meaningful (see degara note below).
    const multifeatureResult = essentia.RhythmExtractor2013(
      signalVector,
      208,
      "multifeature",
      40,
    );
    const bpmMultifeature = multifeatureResult.bpm;
    const beatTicks = essentia.vectorToArray(multifeatureResult.ticks); // seconds, this is the beat grid
    const confidence = multifeatureResult.confidence;

    statusEl.textContent = "Running RhythmExtractor2013 (degara method)...";
    await new Promise((r) => setTimeout(r, 0));

    // degara: single-feature, cheaper method. Per essentia's own source comment,
    // its confidence output should be ignored entirely — it's not meaningful for
    // this method — so we only use it for a second, independent BPM estimate.
    const degaraResult = essentia.RhythmExtractor2013(
      signalVector,
      208,
      "degara",
      40,
    );
    const bpmDegara = degaraResult.bpm;

    statusEl.textContent = "Running KeyExtractor (key + scale)...";
    await new Promise((r) => setTimeout(r, 0));

    const keyResult = essentia.KeyExtractor(signalVector);
    const key = keyResult.key;
    const scale = keyResult.scale;
    const keyStrength = keyResult.strength;

    statusEl.textContent = "Running Danceability (energy proxy)...";
    await new Promise((r) => setTimeout(r, 0));

    const danceResult = essentia.Danceability(signalVector);
    const danceability = danceResult.danceability;

    signalVector.delete(); // WASM-bound objects need explicit cleanup — they're not garbage collected by JS

    audioCtx.close();

    renderResults({
      filename: selectedFile.name,
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      bpm: bpmMultifeature,
      bpmDegara,
      confidence,
      beatTicks,
      key,
      scale,
      keyStrength,
      danceability,
    });

    statusEl.textContent = "Done.";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Analysis failed — see console";
  } finally {
    analyzeBtn.disabled = false;
  }
});

function renderResults(r) {
  const knownBpm = parseFloat(knownBpmInput.value);
  const knownKey = knownKeyInput.value.trim();

  let bpmRow = `<tr><td>BPM (multifeature)</td><td>${r.bpm.toFixed(2)}</td><td>${isNaN(knownBpm) ? "—" : knownBpm}</td><td>${bpmDiffCell(r.bpm, knownBpm)}</td></tr>`;
  let bpmDegaraRow = `<tr><td>BPM (degara)</td><td>${r.bpmDegara.toFixed(2)}</td><td>${isNaN(knownBpm) ? "—" : knownBpm}</td><td>${bpmDiffCell(r.bpmDegara, knownBpm)}</td></tr>`;
  let agreementRow = `<tr><td>Methods agree?</td><td colspan="3">${methodsAgreeCell(r.bpm, r.bpmDegara)}</td></tr>`;
  let keyRow = `<tr><td>Key</td><td>${r.key} ${r.scale}</td><td>${knownKey || "—"}</td><td>${keyDiffCell(r.key, r.scale, knownKey)}</td></tr>`;

  resultsEl.innerHTML = `
    <h2>${escapeHtml(r.filename)}</h2>
    <table>
      <tr><th>Metric</th><th>essentia.js</th><th>Known (ground truth)</th><th>Match?</th></tr>
      ${bpmRow}
      ${bpmDegaraRow}
      ${agreementRow}
      ${keyRow}
      <tr><td>BPM confidence</td><td colspan="3">${confidenceCell(r.confidence)}</td></tr>
      <tr><td>Danceability</td><td colspan="3">${r.danceability.toFixed(3)} (0-3 scale, higher = more danceable)</td></tr>
      <tr><td>Sample rate used for analysis</td><td colspan="3">${r.sampleRate} Hz ${r.sampleRate === 44100 ? '<span class="diff-ok">(correct)</span>' : '<span class="diff-bad">(WRONG — essentia requires 44100 Hz, results below are unreliable)</span>'}</td></tr>
      <tr><td>Duration</td><td colspan="3">${r.duration.toFixed(1)}s</td></tr>
      <tr><td># beat ticks detected (multifeature)</td><td colspan="3">${r.beatTicks.length}</td></tr>
      <tr><td>First 8 beat ticks (s)</td><td colspan="3">${r.beatTicks
        .slice(0, 8)
        .map((t) => t.toFixed(3))
        .join(", ")}</td></tr>
    </table>
  `;
}

function confidenceCell(confidence) {
  // NOTE: this only applies to the multifeature method's confidence output —
  // degara's confidence should be ignored per essentia's own source comments,
  // so it's deliberately not shown at all.
  // Essentia documents the scale as 0-5.32 but does not publish an official
  // "reliable" cutoff. The tiers below are our own heuristic, not an essentia
  // standard — treat them as a rough guide, not ground truth.
  const pct = (confidence / 5.32) * 100;
  let tier;
  if (confidence < 1.5)
    tier = '<span class="diff-bad">LOW — treat this BPM as unreliable</span>';
  else if (confidence < 3) tier = '<span style="color:#b8860b">MEDIUM</span>';
  else tier = '<span class="diff-ok">HIGH</span>';
  return `${confidence.toFixed(3)} / 5.32 (${pct.toFixed(0)}%) — ${tier} <em>(heuristic tier, not an official essentia threshold)</em>`;
}

function methodsAgreeCell(bpmA, bpmB) {
  const pctDiff = (Math.abs(bpmA - bpmB) / Math.min(bpmA, bpmB)) * 100;
  if (pctDiff < 2)
    return `<span class="diff-ok">yes (Δ${pctDiff.toFixed(1)}%) — good sign</span>`;
  return `<span class="diff-bad">no (Δ${pctDiff.toFixed(1)}%) — treat this track's BPM as suspect</span>`;
}

function bpmDiffCell(detected, known) {
  if (isNaN(known)) return "—";
  const diff = Math.abs(detected - known);
  const pctDiff = (diff / known) * 100;
  // Flag common half/double-tempo octave errors explicitly, since these are
  // essentia's most likely failure mode per Phase 1 goals.
  const isHalf = Math.abs(detected - known / 2) / (known / 2) < 0.03;
  const isDouble = Math.abs(detected - known * 2) / (known * 2) < 0.03;
  if (pctDiff < 2)
    return `<span class="diff-ok">match (Δ${pctDiff.toFixed(1)}%)</span>`;
  if (isHalf) return `<span class="diff-bad">HALF-TEMPO error</span>`;
  if (isDouble) return `<span class="diff-bad">DOUBLE-TEMPO error</span>`;
  return `<span class="diff-bad">mismatch (Δ${pctDiff.toFixed(1)}%)</span>`;
}

function keyDiffCell(detectedKey, detectedScale, known) {
  if (!known) return "—";
  const normalizedKnown = known.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedDetected = `${detectedKey.toLowerCase()} ${detectedScale.toLowerCase()}`;
  if (normalizedKnown === normalizedDetected)
    return `<span class="diff-ok">match</span>`;
  return `<span class="diff-bad">mismatch</span>`;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
