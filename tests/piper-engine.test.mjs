import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiperEngine } from "../src/lib/reader/piper-engine.ts";

const stages = {
  preparing: { stage: "preparing", message: "Preparando voz" },
  generating: { stage: "generating", message: "Generando audio" },
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("FIFO, repeated text reuse and zero cache-hit timings", async () => {
  const gate = deferred();
  const calls = [];
  const synthesize = createPiperEngine(async () => ({ predict: async text => {
    calls.push(text);
    if (text === "a") await gate.promise;
    return new Blob([text]);
  } }), stages);
  const a = synthesize({ text: "a" });
  const duplicate = synthesize({ text: " a " });
  const b = synthesize({ text: "b" });
  await tick();
  assert.deepEqual(calls, ["a"]);
  gate.resolve();
  const [first, cached] = await Promise.all([a, duplicate, b]);
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(first.audio, cached.audio);
  assert.equal(cached.initMs, 0);
  assert.equal(cached.generationMs, 0);
});

test("LRU byte budget, promotion, and oversized bypass", async () => {
  const calls = [];
  const synthesize = createPiperEngine(async () => ({ predict: async text => {
    calls.push(text);
    return new Blob([text]);
  } }), stages, 6);
  for (const text of ["a", "b", "a", "c", "a", "b", "oversize", "oversize", "b"]) {
    await synthesize({ text });
  }
  assert.deepEqual(calls, ["a", "b", "c", "b", "oversize", "oversize"]);
});

test("abort rejects immediately, silences events, and retains native lock", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const calls = [], firstEvents = [], nextEvents = [];
  let report;
  const synthesize = createPiperEngine(async emit => {
    report ??= emit; // Mimic the library retaining the first session callbacks.
    report({ stage: "initializing", message: "Preparando voz" });
    return { predict: async text => {
      calls.push(text);
      if (text === "a") await gate.promise;
      return new Blob([text]);
    } };
  }, stages);
  const first = synthesize({ text: "a", signal: controller.signal, onStatus: s => firstEvents.push(s) });
  await tick();
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  const count = firstEvents.length;
  const next = synthesize({ text: "b", onStatus: s => nextEvents.push(s) });
  report({ stage: "downloading", message: "Descargando voz" });
  await tick();
  assert.deepEqual(calls, ["a"]);
  assert.equal(firstEvents.length, count);
  assert.equal(nextEvents.length, 0);
  gate.resolve();
  await next;
  assert.deepEqual(calls, ["a", "b"]);
  assert(nextEvents.some(s => s.stage === "initializing"));
  const nextCount = nextEvents.length;
  report(stages.generating);
  assert.equal(nextEvents.length, nextCount);
  assert.equal(firstEvents.length, count);
  await synthesize({ text: "a" });
  assert.deepEqual(calls, ["a", "b", "a"]); // Cancelled output was not cached.
});

test("queued cancellation and timeout never start inference", async () => {
  const gate = deferred();
  const calls = [];
  const synthesize = createPiperEngine(async () => ({ predict: async text => {
    calls.push(text);
    if (text === "a") await gate.promise;
    return new Blob([text]);
  } }), stages);
  const first = synthesize({ text: "a" });
  const controller = new AbortController();
  const cancelled = synthesize({ text: "b", signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  await assert.rejects(synthesize({ text: "c", timeoutMs: 10 }), /tardo demasiado/);
  gate.resolve();
  await first;
  await synthesize({ text: "d" });
  assert.deepEqual(calls, ["a", "d"]);
});

test("inference timeout retains lock even on late native rejection", async () => {
  const gate = deferred();
  const calls = [], events = [];
  let report;
  const synthesize = createPiperEngine(async emit => {
    report = emit;
    return { predict: async text => {
      calls.push(text);
      if (text === "a") await gate.promise;
      return new Blob([text]);
    } };
  }, stages);
  await assert.rejects(synthesize({ text: "a", timeoutMs: 15, onStatus: s => events.push(s) }), /tardo demasiado/);
  const count = events.length;
  const next = synthesize({ text: "b" });
  report(stages.generating);
  await tick();
  assert.deepEqual(calls, ["a"]);
  assert.equal(events.length, count);
  gate.reject(new Error("late native failure"));
  await next;
  assert.deepEqual(calls, ["a", "b"]);
});

test("cancellation during preparation skips predict; next caller can reuse session", async () => {
  const gate = deferred();
  let calls = 0;
  const session = { predict: async () => { calls++; return new Blob(["audio"]); } };
  const synthesize = createPiperEngine(async () => { await gate.promise; return session; }, stages);
  const controller = new AbortController();
  const first = synthesize({ text: "a", signal: controller.signal });
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  const next = synthesize({ text: "b" });
  gate.resolve();
  await next;
  assert.equal(calls, 1);
});

test("pre-abort, invalid input, throwing/reentrant callbacks, and failures", async () => {
  let calls = 0;
  const synthesize = createPiperEngine(async () => ({ predict: async text => {
    calls++;
    if (text === "fail") throw new Error("native failure");
    return new Blob([text]);
  } }), stages);
  await assert.rejects(synthesize({ text: "a", signal: AbortSignal.abort() }), { name: "AbortError" });
  await assert.rejects(synthesize({ text: " " }), /texto/);
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(synthesize({ text: "a", timeoutMs }), /positivo/);
  }
  const controller = new AbortController();
  await assert.rejects(synthesize({ text: "a", signal: controller.signal, onStatus: () => controller.abort() }), { name: "AbortError" });
  assert.equal(calls, 0);
  await assert.rejects(synthesize({ text: "fail" }), /native failure/);
  await synthesize({ text: "a", onStatus: () => { throw new Error("UI failure"); } });
  assert.equal(calls, 2);
});
