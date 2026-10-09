import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LAURA_CACHE, LAURA_MODEL_URL, LAURA_MODEL_SOURCE_URL, LAURA_MODEL_SHA256, loadLauraAsset,
  verifyLauraModel, parseLauraConfig, lauraPcmWav, createLauraSession,
} from "../src/lib/reader/laura.ts";
import { createPiperEngine } from "../src/lib/reader/piper-engine.ts";

const bytes = value => new TextEncoder().encode(value).buffer;
const config = {
  audio: { sample_rate: 22050 }, espeak: { voice: "es-419" }, phoneme_type: "espeak",
  inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 },
};
const configBytes = bytes(JSON.stringify(config));
const noop = () => {};
const validate = data => assert.equal(new TextDecoder().decode(data), "laura");
function memoryCache(fail = "") {
  const entries = new Map();
  const cache = {
    async match(url) { if (fail === "match") throw Error("denied"); return entries.get(url)?.clone(); },
    async put(url, response) { if (fail === "put") throw Error("quota"); entries.set(url, response.clone()); },
  };
  return { entries, async open(name) { assert.equal(name, LAURA_CACHE); if (fail === "open") throw Error("denied"); return cache; } };
}

test("Laura uses an isolated cache and original model identity, never Claude", async () => {
  assert.equal(LAURA_MODEL_URL, "/models/laura/es_MX-laura-high.onnx");
  assert.match(LAURA_MODEL_SOURCE_URL, /HirCoir\/Piper-TTS-Laura\/resolve\/main\/es_MX-laura-high\.onnx$/);
  assert.match(LAURA_CACHE, /laura/);
  assert.equal(LAURA_MODEL_SHA256, "c1415da8e5409734e9be7623d34914461674eb1efc83873d5e6332cb61ed1068");
  await assert.rejects(verifyLauraModel(bytes("claude")), /no corresponde/);
});

test("cache persists by exact URL across independent loads; no text/audio is stored", async () => {
  const storage = memoryCache();
  let downloads = 0;
  const fetchAsset = async (url, options) => {
    downloads++;
    assert.equal(url, LAURA_MODEL_URL);
    assert.equal(options.credentials, "omit");
    return new Response("laura", { headers: { "content-length": "5" } });
  };
  const updates = [];
  await loadLauraAsset(LAURA_MODEL_URL, s => updates.push(s), validate, storage, fetchAsset);
  await loadLauraAsset(LAURA_MODEL_URL, noop, validate, storage, fetchAsset);
  assert.equal(downloads, 1);
  assert.deepEqual([...storage.entries.keys()], [LAURA_MODEL_URL]);
  assert.equal(updates.at(-1).progress, 100);
});

for (const failure of ["open", "match", "put"]) test(`cache ${failure} failure is nonfatal`, async () => {
  const result = await loadLauraAsset(LAURA_MODEL_URL, noop, validate, memoryCache(failure), async () => new Response("laura"));
  assert.equal(new TextDecoder().decode(result), "laura");
});

test("missing CacheStorage and missing content-length remain usable", async () => {
  const events = [];
  await loadLauraAsset(LAURA_MODEL_URL, s => events.push(s), validate, undefined, async () => new Response("laura"));
  assert.equal(events.at(-1).progress, undefined);
});

test("corrupt cached bytes are replaced only by validated original bytes", async () => {
  const storage = memoryCache();
  storage.entries.set(LAURA_MODEL_URL, new Response("claude"));
  await loadLauraAsset(LAURA_MODEL_URL, noop, validate, storage, async () => new Response("laura"));
  assert.equal(await storage.entries.get(LAURA_MODEL_URL).text(), "laura");
});

test("HTTP failures, invalid and interrupted downloads do not enter cache", async () => {
  for (const response of [
    () => new Response("unavailable", { status: 503 }),
    () => new Response("claude"),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(Error("network")); } })),
  ]) {
    const storage = memoryCache();
    await assert.rejects(loadLauraAsset(LAURA_MODEL_URL, noop, validate, storage, async () => response()));
    assert.equal(storage.entries.size, 0);
  }
});

test("configuration validates language, sample rate, phonemizer and inference scales", () => {
  assert.deepEqual(parseLauraConfig(configBytes), config);
  for (const invalid of ["{}", "not json", JSON.stringify({ ...config, espeak: { voice: "en-us" } }),
    JSON.stringify({ ...config, inference: { ...config.inference, length_scale: -1 } })]) {
    assert.throws(() => parseLauraConfig(bytes(invalid)));
  }
});

test("WAV is mono PCM16 at 22050 Hz, clips correctly and rejects invalid signal", async () => {
  const wav = lauraPcmWav(Float32Array.of(-2, 0, 2), 22050);
  const data = await wav.arrayBuffer();
  const view = new DataView(data);
  assert.equal(wav.type, "audio/wav");
  assert.equal(new TextDecoder().decode(data.slice(0, 4)), "RIFF");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 22050);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
  for (const invalid of [[], [0, 0], [NaN, 1], [Infinity, 1]]) {
    assert.throws(() => lauraPcmWav(Float32Array.from(invalid), 22050), /audio vacio/);
  }
});

function runtimeFixture({ sid = false, noPhonemes = false, rejectRun = false } = {}) {
  const calls = [], assets = [], tensors = [];
  let callbacks;
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims, disposed: false }); tensors.push(this); }
    dispose() { this.disposed = true; }
  }
  const native = {
    inputNames: sid ? ["input", "sid"] : ["input"], outputNames: ["output"],
    async run(feeds) {
      calls.push(feeds);
      if (rejectRun) throw Error("native error");
      return { output: new Tensor("float32", Float32Array.of(-0.5, 0.5), [1, 2]) };
    },
  };
  return {
    calls, assets, tensors,
    dependencies: {
      async loadAsset(url) { assets.push(url); return url.endsWith(".json") ? configBytes : bytes("model"); },
      async loadRuntime() { return {
        ort: { Tensor, InferenceSession: { async create(model, options) { assert.deepEqual(options, { executionProviders: ["wasm"] }); return native; } } },
        async createPiperPhonemize(options) {
          callbacks = options;
          return { callMain(args) {
            assert.equal(args[1], "es-419");
            assert.equal(JSON.parse(args[3])[0].text, "Texto privado.");
            callbacks.print("diagnostic");
            if (!noPhonemes) { callbacks.print('{"phoneme_ids":[1,2,3]}'); callbacks.print('{"phoneme_ids":[4,5]}'); }
            else callbacks.printErr("no phonemes");
          } };
        },
      }; },
    },
  };
}

for (const sid of [false, true]) test(`real adapter feeds, multiple phoneme replies and disposal (sid=${sid})`, async () => {
  const fixture = runtimeFixture({ sid });
  const session = await createLauraSession(noop, fixture.dependencies);
  await session.predict("Texto privado.");
  await session.predict("Texto privado.");
  assert.deepEqual(fixture.assets, [`${LAURA_MODEL_URL}.json`, LAURA_MODEL_URL]);
  for (const feeds of fixture.calls) {
    assert.deepEqual(feeds.input.dims, [1, 5]);
    assert.deepEqual([...feeds.input.data], [1n, 2n, 3n, 4n, 5n]);
    assert.deepEqual([...feeds.input_lengths.data], [5n]);
    assert.equal(feeds.scales.data[1], 1);
    assert.equal(Boolean(feeds.sid), sid);
  }
  assert(fixture.tensors.every(t => t.disposed));
});

test("phonemizer failure prevents inference and native failures dispose feeds", async () => {
  const missing = runtimeFixture({ noPhonemes: true });
  await assert.rejects((await createLauraSession(noop, missing.dependencies)).predict("Texto privado."), /no phonemes/);
  assert.equal(missing.calls.length, 0);
  const broken = runtimeFixture({ rejectRun: true });
  await assert.rejects((await createLauraSession(noop, broken.dependencies)).predict("Texto privado."), /native error/);
  assert(broken.tensors.every(t => t.disposed));
});

test("Laura preparation remains singleflight after timeout and queued cancellation", async () => {
  let finishDownload, preparations = 0;
  const gate = new Promise(resolve => { finishDownload = resolve; });
  const fixture = runtimeFixture();
  const loadAsset = fixture.dependencies.loadAsset;
  fixture.dependencies.loadAsset = async (...args) => { await gate; return loadAsset(...args); };
  let sessionPromise;
  const synthesize = createPiperEngine(report => {
    if (!sessionPromise) { preparations++; sessionPromise = createLauraSession(report, fixture.dependencies); }
    return sessionPromise;
  }, { preparing: { stage: "preparing", message: "Laura" }, generating: { stage: "generating", message: "Laura" } });
  await assert.rejects(synthesize({ text: "Texto privado.", timeoutMs: 15 }), /tardo demasiado/);
  const controller = new AbortController();
  const cancelled = synthesize({ text: "cancelled", signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const next = synthesize({ text: "Texto privado." });
  assert.equal(preparations, 1);
  finishDownload();
  await next;
  assert.equal(preparations, 1);
  assert.equal(fixture.calls.length, 1);
});
