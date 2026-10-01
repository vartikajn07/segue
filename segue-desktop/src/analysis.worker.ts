const CONFIDENCE_MAX = 5.32;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

type AnalysisRequest = { id: number; monoBuffer: ArrayBuffer; durationSeconds: number };

// These browser-only builds avoid the Node fallbacks in Essentia's ES module.
// They are copied to the app's assets folder by angular.json.
importScripts("./assets/essentia/essentia-wasm.web.js", "./assets/essentia/essentia.js-core.js");
const essentiaGlobal = self as unknown as { EssentiaWASM: any; Essentia: any };

addEventListener("message", async ({ data }: MessageEvent<AnalysisRequest>) => {
  try {
    await essentiaGlobal.EssentiaWASM.ready;
    const essentia = new essentiaGlobal.Essentia(essentiaGlobal.EssentiaWASM);
    const signal = essentia.arrayToVector(new Float32Array(data.monoBuffer));
    const rhythm = essentia.RhythmExtractor2013(signal, 208, "multifeature", 40);
    const key = essentia.KeyExtractor(signal);
    const dance = essentia.Danceability(signal);
    const beatTicks = essentia.vectorToArray(rhythm.ticks);
    signal.delete();

    postMessage({
      id: data.id,
      ok: true,
      result: {
        bpm: rhythm.bpm,
        musicalKey: `${key.key} ${key.scale}`,
        energy: clamp(dance.danceability / 3),
        confidence: clamp(rhythm.confidence / CONFIDENCE_MAX),
        beatTicks,
        durationSeconds: data.durationSeconds,
      },
    });
  } catch (error) {
    postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
