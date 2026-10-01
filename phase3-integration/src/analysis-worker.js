import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";
import Essentia from "essentia.js/dist/essentia.js-core.es.js";

const CONFIDENCE_MAX = 5.32;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

self.onmessage = async ({ data }) => {
  try {
    await EssentiaWASM.ready;
    const essentia = new Essentia(EssentiaWASM);
    const signal = essentia.arrayToVector(new Float32Array(data.monoBuffer));
    const rhythm = essentia.RhythmExtractor2013(signal, 208, "multifeature", 40);
    const key = essentia.KeyExtractor(signal);
    const dance = essentia.Danceability(signal);
    const beatTicks = essentia.vectorToArray(rhythm.ticks);
    signal.delete();
    self.postMessage({
      ok: true,
      metadata: {
        id: data.id,
        bpm: rhythm.bpm,
        key: `${key.key} ${key.scale}`,
        energy: clamp(dance.danceability / 3),
        analysisConfidence: clamp(rhythm.confidence / CONFIDENCE_MAX),
      },
      beatTicks,
      rawAnalysis: {
        bpmConfidence: rhythm.confidence,
        danceability: dance.danceability,
        keyStrength: key.strength,
        sampleRate: 44100,
      },
    });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
