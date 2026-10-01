// Phase 0 proof of concept: two decks, live crossfade, tempo-matching via SoundTouch.
// This is deliberately bare-bones — no library UI, no analysis, no queue.
// The only question this file answers: "can two tracks crossfade, beat-matched, and sound acceptable?"

import { SoundTouchNode } from '@soundtouchjs/audio-worklet';
import processorUrl from '@soundtouchjs/audio-worklet/processor?url';

const audioCtx = new AudioContext();
let processorRegistered = false;

const state = {
  bufferA: null,
  bufferB: null,
  sourceA: null,
  gainA: null,
};

const els = {
  fileA: document.getElementById('fileA'),
  fileB: document.getElementById('fileB'),
  bpmA: document.getElementById('bpmA'),
  bpmB: document.getElementById('bpmB'),
  duration: document.getElementById('duration'),
  useStretch: document.getElementById('useStretch'),
  playBtn: document.getElementById('playBtn'),
  crossfadeBtn: document.getElementById('crossfadeBtn'),
  stopBtn: document.getElementById('stopBtn'),
  status: document.getElementById('status'),
};

function log(msg) {
  console.log(msg);
  els.status.textContent = msg;
}

async function decodeFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  return audioCtx.decodeAudioData(arrayBuffer);
}

els.fileA.addEventListener('change', async (e) => {
  if (!e.target.files[0]) return;
  state.bufferA = await decodeFile(e.target.files[0]);
  log(`Track A loaded — ${state.bufferA.duration.toFixed(1)}s`);
});

els.fileB.addEventListener('change', async (e) => {
  if (!e.target.files[0]) return;
  state.bufferB = await decodeFile(e.target.files[0]);
  log(`Track B loaded — ${state.bufferB.duration.toFixed(1)}s`);
});

async function ensureProcessorRegistered() {
  if (processorRegistered) return;
  await SoundTouchNode.register(audioCtx, processorUrl);
  processorRegistered = true;
}

els.playBtn.addEventListener('click', async () => {
  if (!state.bufferA) return log('Load track A first.');
  await audioCtx.resume();

  const gain = audioCtx.createGain();
  gain.gain.value = 1;
  gain.connect(audioCtx.destination);

  const source = audioCtx.createBufferSource();
  source.buffer = state.bufferA;
  source.connect(gain);
  source.start();

  state.sourceA = source;
  state.gainA = gain;
  log('Playing track A. Whenever you like, hit "Crossfade to track B now" to trigger the transition.');
});

els.crossfadeBtn.addEventListener('click', async () => {
  if (!state.bufferB) return log('Load track B first.');
  if (!state.sourceA) return log('Play track A first.');

  const bpmA = parseFloat(els.bpmA.value) || 120;
  const bpmB = parseFloat(els.bpmB.value) || 120;
  const ratio = bpmA / bpmB; // stretch B so its tempo lands on A's tempo
  const duration = Math.max(0.5, parseFloat(els.duration.value) || 8);
  const useStretch = els.useStretch.checked;

  const gainB = audioCtx.createGain();
  gainB.gain.value = 0;
  gainB.connect(audioCtx.destination);

  const sourceB = audioCtx.createBufferSource();
  sourceB.buffer = state.bufferB;

  if (useStretch) {
    await ensureProcessorRegistered();
    const stNode = new SoundTouchNode({ context: audioCtx });
    stNode.connect(gainB);

    sourceB.playbackRate.value = ratio; // feed samples at the matched rate
    sourceB.connect(stNode);
    stNode.playbackRate.value = ratio; // tell the processor what rate is coming in
    stNode.pitch.value = 1; // 1 = compensate fully, keep original pitch
  } else {
    // Naive comparison mode: speeding up/slowing down via playbackRate alone.
    // This WILL shift pitch audibly — that's the point, it's the baseline to compare against.
    sourceB.playbackRate.value = ratio;
    sourceB.connect(gainB);
  }

  const now = audioCtx.currentTime;
  sourceB.start();

  // Equal-power-ish linear crossfade for a first pass — swap for a proper equal-power
  // curve (cosine-based) later once the basic mechanics are confirmed working.
  gainB.gain.setValueAtTime(0, now);
  gainB.gain.linearRampToValueAtTime(1, now + duration);
  state.gainA.gain.setValueAtTime(state.gainA.gain.value, now);
  state.gainA.gain.linearRampToValueAtTime(0, now + duration);

  const finishingSourceA = state.sourceA;
  setTimeout(() => {
    try { finishingSourceA.stop(); } catch (err) { /* already stopped */ }
  }, duration * 1000 + 200);

  // B becomes the new "current" deck for a potential next transition later.
  state.sourceA = sourceB;
  state.gainA = gainB;

  log(
    `Crossfading A -> B over ${duration}s | BPM ${bpmA} -> ${bpmB} (ratio ${ratio.toFixed(3)}) | ` +
    `stretch mode: ${useStretch ? 'SoundTouch (pitch-preserving)' : 'naive playbackRate (pitch will shift)'}`
  );
});

els.stopBtn.addEventListener('click', () => {
  if (state.sourceA) { try { state.sourceA.stop(); } catch (err) { /* noop */ } }
  log('Stopped. Reload files to run another test.');
});
