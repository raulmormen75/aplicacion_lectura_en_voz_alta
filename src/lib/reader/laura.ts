import type * as Ort from "onnxruntime-web";
import type { PiperStatusUpdate } from "./piper";

// HirCoir / Laura: personal local use only in this integration. See REPORTE_PIPER_TTS.md.
export const LAURA_MODEL_URL = "/models/laura/es_MX-laura-high.onnx";
export const LAURA_MODEL_SOURCE_URL = "https://huggingface.co/HirCoir/Piper-TTS-Laura/resolve/main/es_MX-laura-high.onnx";
export const LAURA_MODEL_SHA256 = "c1415da8e5409734e9be7623d34914461674eb1efc83873d5e6332cb61ed1068";
export const LAURA_CACHE = "reader-piper-laura-v1";
const PHONEMIZER_URL = "https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@1.1.1/dist/piper-o91UDS6e.js";
const PHONEMIZER_BASE = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";

type Report = (update: PiperStatusUpdate) => void;
type Config = {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
};
type PhonemizerOptions = {
  print(message: string): void;
  printErr(message: string): void;
  locateFile(path: string): string;
};
type PhonemizerFactory = (options: PhonemizerOptions) => Promise<{ callMain(args: string[]): void }>;

function browserCache() {
  try { return globalThis.caches; } catch { return undefined; }
}

// Cache failures never prevent inference. Only complete, validated downloads are stored.
export async function loadLauraAsset(
  url: string,
  report: Report,
  validate: (bytes: ArrayBuffer) => Promise<void> | void,
  storage: CacheStorage | undefined = browserCache(),
  fetchAsset: typeof fetch = globalThis.fetch,
): Promise<ArrayBuffer> {
  let cache: Cache | undefined;
  try {
    cache = await storage?.open(LAURA_CACHE);
    const hit = await cache?.match(url);
    if (hit?.ok) {
      const bytes = await hit.arrayBuffer();
      await validate(bytes);
      return bytes;
    }
  } catch { /* Unavailable or corrupt cache: use the original source. */ }

  const response = await fetchAsset(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`No se pudo descargar Laura (HTTP ${response.status}).`);
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body?.getReader();
  let bytes: ArrayBuffer;
  if (reader) {
    const chunks: BlobPart[] = [];
    let loaded = 0;
    let reportedAt = -Infinity;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        loaded += value.byteLength;
        const now = performance.now();
        if (now - reportedAt >= 100 || loaded === total) {
          reportedAt = now;
          report({
            stage: "downloading", message: "Descargando Laura",
            progress: total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : undefined,
            detail: `${(loaded / 1e6).toFixed(1)} MB${total > 0 ? ` de ${(total / 1e6).toFixed(1)} MB` : ""}`,
          });
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    bytes = await new Blob(chunks).arrayBuffer();
  } else {
    bytes = await response.arrayBuffer();
  }
  await validate(bytes);
  try { await cache?.put(url, new Response(bytes)); } catch { /* Quota or private browsing. */ }
  return bytes;
}

export async function verifyLauraModel(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  if (hash !== LAURA_MODEL_SHA256) throw new Error("El archivo no corresponde al modelo Laura verificado.");
}

export function parseLauraConfig(bytes: ArrayBuffer): Config {
  const config = JSON.parse(new TextDecoder().decode(bytes));
  const inference = config?.inference;
  if (config?.audio?.sample_rate !== 22050 || config?.espeak?.voice !== "es-419" ||
      config?.phoneme_type !== "espeak" ||
      ![inference?.noise_scale, inference?.length_scale, inference?.noise_w].every(
        value => typeof value === "number" && Number.isFinite(value) && value > 0,
      )) throw new Error("La configuracion de Laura no es compatible.");
  return config;
}

async function loadRuntime() {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  // Match the installed JS runtime rather than silently mixing WASM versions.
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
  const { createPiperPhonemize } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ PHONEMIZER_URL);
  return { ort, createPiperPhonemize: createPiperPhonemize as PhonemizerFactory };
}

// Adapted from output/playwright/voice-lab/lab.mjs; callers serialize via createPiperEngine.
export async function createLauraSession(
  report: Report,
  dependencies = { loadAsset: loadLauraAsset, loadRuntime },
) {
  report({ stage: "downloading", message: "Preparando Laura", detail: "Buscando los archivos de la voz." });
  const config = parseLauraConfig(await dependencies.loadAsset(`${LAURA_MODEL_URL}.json`, report, bytes => {
    parseLauraConfig(bytes);
  }));
  const model = await dependencies.loadAsset(LAURA_MODEL_URL, report, verifyLauraModel);
  report({ stage: "initializing", message: "Preparando Laura", detail: "Cargando el motor en este dispositivo." });
  const { ort, createPiperPhonemize } = await dependencies.loadRuntime();
  let phonemeIds: number[] = [];
  let phonemeError = "";
  const phonemizer = await createPiperPhonemize({
    print: message => {
      try {
        const ids: unknown = JSON.parse(message).phoneme_ids;
        if (Array.isArray(ids) && ids.length && ids.every(id => Number.isSafeInteger(id) && id >= 0)) {
          phonemeIds.push(...ids);
        }
      } catch { /* Emscripten may also print diagnostics. */ }
    },
    printErr: message => { phonemeError = String(message); },
    locateFile: path => path.endsWith(".wasm") ? `${PHONEMIZER_BASE}.wasm`
      : path.endsWith(".data") ? `${PHONEMIZER_BASE}.data` : path,
  });
  const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
  return {
    async predict(text: string): Promise<Blob> {
      phonemeIds = [];
      phonemeError = "";
      phonemizer.callMain(["-l", config.espeak.voice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
      if (!phonemeIds.length) throw new Error(phonemeError || "Laura no devolvio fonemas.");
      const { noise_scale, length_scale, noise_w } = config.inference;
      const feeds: Record<string, Ort.Tensor> = {
        input: new ort.Tensor("int64", BigInt64Array.from(phonemeIds, BigInt), [1, phonemeIds.length]),
        input_lengths: new ort.Tensor("int64", BigInt64Array.of(BigInt(phonemeIds.length)), [1]),
        scales: new ort.Tensor("float32", Float32Array.of(noise_scale, length_scale, noise_w), [3]),
      };
      if (session.inputNames.includes("sid")) feeds.sid = new ort.Tensor("int64", BigInt64Array.of(BigInt(0)), [1]);
      let output: Ort.InferenceSession.ReturnType | undefined;
      try {
        output = await session.run(feeds);
        const samples = output[session.outputNames[0]]?.data;
        if (!(samples instanceof Float32Array)) throw new Error("Laura devolvio un formato de audio inesperado.");
        return lauraPcmWav(samples, config.audio.sample_rate);
      } finally {
        for (const tensor of Object.values(feeds)) tensor.dispose();
        if (output) for (const tensor of Object.values(output)) tensor.dispose();
      }
    },
  };
}

export function lauraPcmWav(samples: Float32Array, sampleRate: number): Blob {
  if (!samples.length || !samples.every(Number.isFinite) || !samples.some(value => Math.abs(value) > 0.0001)) {
    throw new Error("Laura genero audio vacio o sin senal valida.");
  }
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const word = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  word(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); word(8, "WAVE"); word(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * (samples[i] < 0 ? 32768 : 32767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
