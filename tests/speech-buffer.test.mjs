import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { Worker } from "node:worker_threads";
import { createSpeechBuffer, speechFragment } from "../src/lib/reader/speech-buffer.ts";
import { tokenizeWords } from "../src/lib/reader/text.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const audio = (text = "synthetic") => new Blob([text], { type: "audio/wav" });
const aborted = (error) => error?.name === "AbortError";
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("An immediate retry never settled")), 500);
    })]);
  } finally { clearTimeout(timer); }
}

function controlledBuffer(t, budget) {
  const calls = [];
  const buffer = createSpeechBuffer((voice, text, signal) => new Promise((resolve, reject) => {
    calls.push({ voice, text, signal, resolve, reject });
  }), budget);
  t.after(async () => {
    buffer.clear();
    for (const call of calls) call.resolve(audio());
    await tick();
  });
  return { ...buffer, calls };
}

function chunkFor(text, startWord = 103) {
  const tokens = tokenizeWords(text);
  return {
    chunk: { id: "synthetic", text, cleanText: text, startWord, wordCount: tokens.length, language: "es" },
    tokens,
  };
}

for (const [voice, maxChars, maxWords] of [["hf-mexico", 280, 38], ["hf-dora", 720, 64]]) {
  test(`${voice}: word jumps reuse stable fragments and count global word indices`, () => {
    const { chunk, tokens } = chunkFor("Una oración explica el resultado. ".repeat(35));
    let index = chunk.startWord;
    const fragments = [];
    while (index < chunk.startWord + tokens.length) {
      const fragment = speechFragment(chunk, tokens, index, voice);
      assert.equal(fragment.speechBaseWord, index);
      assert.ok(fragment.chunkEndWord > index);
      assert.ok(fragment.textToSpeak.length <= maxChars);
      assert.ok(fragment.chunkEndWord - index <= maxWords);
      assert.equal(tokenizeWords(fragment.textToSpeak).length, fragment.chunkEndWord - index);
      for (let jumped = index; jumped < fragment.chunkEndWord; jumped++) {
        assert.deepEqual(speechFragment(chunk, tokens, jumped, voice), { ...fragment, resumeWord: jumped });
      }
      fragments.push(fragment.textToSpeak);
      index = fragment.chunkEndWord;
    }
    assert.equal(fragments.join(" "), chunk.cleanText.trim());
    assert.equal(index, chunk.startWord + tokens.length);
    assert.equal(speechFragment(chunk, tokens, chunk.startWord - 1, voice), null);
    assert.equal(speechFragment(chunk, tokens, index, voice), null);
    const oversized = chunkFor("a".repeat(maxChars + 1));
    assert.throws(() => speechFragment(oversized.chunk, oversized.tokens, oversized.chunk.startWord, voice), /palabra demasiado larga/);
  });
}

test("fragment boundaries preserve opening question punctuation for the next sentence", () => {
  const { chunk, tokens } = chunkFor(`${"dato ".repeat(38)}¿Cuál es el resultado?`);
  const first = speechFragment(chunk, tokens, chunk.startWord, "hf-mexico");
  const next = speechFragment(chunk, tokens, first.chunkEndWord, "hf-mexico");
  assert.equal(first.textToSpeak.endsWith("¿"), false);
  assert.ok(next.textToSpeak.startsWith("¿Cuál"));
});

test("fragment word limits do not cut a decimal into two separate syntheses", () => {
  const { chunk, tokens } = chunkFor(`${"dato ".repeat(37)}3.14 unidades continúan.`);
  const first = speechFragment(chunk, tokens, chunk.startWord, "hf-mexico");
  assert.equal(first.textToSpeak.endsWith("3."), false);
  const fragments = [first];
  while (fragments.at(-1).chunkEndWord < chunk.startWord + tokens.length) {
    fragments.push(speechFragment(chunk, tokens, fragments.at(-1).chunkEndWord, "hf-mexico"));
  }
  assert.equal(fragments.filter((fragment) => fragment.textToSpeak.includes("3.14")).length, 1);
});

test("oversized punctuation gaps cannot hang fragment preparation", { timeout: 10000 }, async () => {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    Promise.all([import(workerData.speechUrl), import(workerData.textUrl)]).then(([speech, text]) => {
      parentPort.once("message", () => {
        const cleanText = "A " + "¿".repeat(50000) + "! B C";
        const started = performance.now();
        try {
          speech.speechFragment({ cleanText, startWord: 0 }, text.tokenizeWords(cleanText), 0, "hf-mexico");
          parentPort.postMessage({ unexpectedSuccess: true });
        } catch (error) {
          parentPort.postMessage({ message: error.message, elapsedMs: performance.now() - started });
        }
      });
      parentPort.postMessage({ ready: true });
    });
  `, {
    eval: true, execArgv: ["--experimental-strip-types"],
    workerData: {
      speechUrl: new URL("../src/lib/reader/speech-buffer.ts", import.meta.url).href,
      textUrl: new URL("../src/lib/reader/text.ts", import.meta.url).href,
    },
  });
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Fragment worker did not initialize")), 6000);
      worker.on("error", reject);
      worker.on("message", (message) => {
        if (message.ready) {
          clearTimeout(timer);
          timer = setTimeout(() => reject(new Error("Punctuation rejection exceeded two seconds")), 2000);
          worker.postMessage("start");
        } else resolve(message);
      });
    });
    assert.match(result.message, /palabra demasiado larga/);
    assert.ok(result.elapsedMs < 2000);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});

test("deduplicate playback and prefetch while retaining the finished Blob in memory", async (t) => {
  const buffer = controlledBuffer(t);
  const first = buffer.synthesize({ voice: "hf-mexico", text: "Un fragmento", priority: "prefetch" });
  const second = buffer.synthesize({ voice: "hf-mexico", text: "Un fragmento", priority: "play" });
  assert.equal(buffer.calls.length, 1);
  const expected = audio();
  buffer.calls[0].resolve(expected);
  assert.strictEqual(await first, expected);
  assert.strictEqual(await second, expected);
  await tick();
  assert.strictEqual(await buffer.synthesize({ voice: "hf-mexico", text: "Un fragmento" }), expected);
  assert.equal(buffer.calls.length, 1);
  const otherVoice = buffer.synthesize({ voice: "hf-dora", text: "Un fragmento" });
  assert.equal(buffer.calls.length, 2);
  buffer.calls[1].resolve(audio("other voice"));
  await otherVoice;
});

test("cancel one consumer without aborting another consumer of the same audio", async (t) => {
  const buffer = controlledBuffer(t);
  const cancelled = new AbortController();
  const waiting = new AbortController();
  const first = buffer.synthesize({ voice: "hf-dora", text: "Compartido", signal: cancelled.signal });
  const firstRejected = assert.rejects(first, aborted);
  const second = buffer.synthesize({ voice: "hf-dora", text: "Compartido", signal: waiting.signal });
  assert.equal(buffer.calls.length, 1);
  assert.equal(getEventListeners(cancelled.signal, "abort").length, 1);
  cancelled.abort();
  await firstRejected;
  assert.equal(buffer.calls[0].signal.aborted, false);
  assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
  const expected = audio();
  buffer.calls[0].resolve(expected);
  assert.strictEqual(await second, expected);
  assert.equal(getEventListeners(waiting.signal, "abort").length, 0);
});

test("cancel the last consumer, then retry without a late response contaminating the replacement", async (t) => {
  const buffer = controlledBuffer(t);
  const cancelled = new AbortController();
  const first = buffer.synthesize({ voice: "hf-dora", text: "Reintento", signal: cancelled.signal });
  const firstRejected = assert.rejects(first, aborted);
  cancelled.abort();
  await firstRejected;
  assert.equal(buffer.calls[0].signal.aborted, true);
  const replacement = buffer.synthesize({ voice: "hf-dora", text: "Reintento" });
  assert.equal(buffer.calls.length, 2);
  buffer.calls[0].resolve(audio("stale"));
  await tick();
  const expected = audio("fresh");
  buffer.calls[1].resolve(expected);
  assert.strictEqual(await replacement, expected);
  await tick();
  assert.strictEqual(await buffer.synthesize({ voice: "hf-dora", text: "Reintento" }), expected);
  assert.equal(buffer.calls.length, 2);
});

test("playback takes the next available slot ahead of pending preparation with at most two transports", async (t) => {
  const buffer = controlledBuffer(t);
  const request = (text, priority) => buffer.synthesize({ voice: "hf-dora", text, priority });
  const active = [request("active one", "prefetch"), request("active two", "prefetch")];
  const pending = [request("later one", "prefetch"), request("later two", "prefetch"), request("play now", "play")];
  assert.deepEqual(buffer.calls.map((call) => call.text), ["active one", "active two"]);
  buffer.calls[0].resolve(audio());
  await active[0];
  await tick();
  assert.deepEqual(buffer.calls.map((call) => call.text), ["active one", "active two", "play now"]);
  buffer.calls[1].resolve(audio());
  buffer.calls[2].resolve(audio());
  await tick();
  assert.deepEqual(buffer.calls.slice(3).map((call) => call.text), ["later one", "later two"]);
  for (const call of buffer.calls.slice(3)) call.resolve(audio());
  await Promise.all([...active, ...pending]);
});

test("promote an already queued preparation request without creating a duplicate", async (t) => {
  const buffer = controlledBuffer(t);
  const request = (text, priority) => buffer.synthesize({ voice: "hf-dora", text, priority });
  const promises = [request("active one", "play"), request("active two", "play"), request("first", "prefetch"), request("promoted", "prefetch"), request("promoted", "play")];
  buffer.calls[0].resolve(audio());
  await promises[0];
  await tick();
  assert.equal(buffer.calls[2].text, "promoted");
  buffer.calls[1].resolve(audio());
  buffer.calls[2].resolve(audio());
  await tick();
  assert.equal(buffer.calls[3].text, "first");
  buffer.calls[3].resolve(audio());
  await Promise.all(promises);
  assert.equal(buffer.calls.filter((call) => call.text === "promoted").length, 1);
});

test("clear cancels queued and active consumers and ignores their late responses", async (t) => {
  const buffer = controlledBuffer(t);
  const pending = ["old one", "old two", "queued"].map((text) => buffer.synthesize({ voice: "hf-dora", text }));
  const rejected = pending.map((promise) => assert.rejects(promise, aborted));
  buffer.clear();
  await Promise.all(rejected);
  assert.equal(buffer.calls.length, 2);
  assert.ok(buffer.calls.every((call) => call.signal.aborted));
  for (const call of buffer.calls) call.resolve(audio("stale"));
  await tick();
  assert.equal(buffer.calls.length, 2, "the cleared queued job must not start");
  const retried = buffer.synthesize({ voice: "hf-dora", text: "old one" });
  assert.equal(buffer.calls.length, 3, "late audio must not enter the cache");
  const expected = audio("fresh");
  buffer.calls[2].resolve(expected);
  assert.strictEqual(await retried, expected);
});

test("a replacement queued immediately after clear survives both old transports settling", async (t) => {
  const buffer = controlledBuffer(t);
  const old = ["same text", "other text"].map((text) => buffer.synthesize({ voice: "hf-dora", text }));
  const rejected = old.map((promise) => assert.rejects(promise, aborted));
  buffer.clear();
  await Promise.all(rejected);
  const replacement = buffer.synthesize({ voice: "hf-dora", text: "same text" });
  assert.equal(buffer.calls.length, 2);
  buffer.calls[0].resolve(audio("stale one"));
  await tick();
  assert.equal(buffer.calls[2].text, "same text");
  buffer.calls[1].resolve(audio("stale two"));
  await tick();
  const expected = audio("replacement");
  buffer.calls[2].resolve(expected);
  assert.strictEqual(await replacement, expected);
  await tick();
  assert.strictEqual(await buffer.synthesize({ voice: "hf-dora", text: "same text" }), expected);
});

test("bounded memory evicts the least recently used audio", async (t) => {
  const calls = new Map();
  const buffer = createSpeechBuffer(async (_voice, text) => {
    calls.set(text, (calls.get(text) ?? 0) + 1);
    return audio("123456");
  }, 50);
  t.after(() => buffer.clear());
  const request = async (text) => {
    const result = await buffer.synthesize({ voice: "hf-dora", text });
    await tick();
    return result;
  };
  await request("a");
  await request("b");
  await request("a");
  await request("c");
  await request("a");
  assert.equal(calls.get("a"), 1);
  await request("b");
  assert.equal(calls.get("b"), 2);
});

test("immediately retrying an uncached oversized entry starts a fresh generation", async (t) => {
  let calls = 0;
  const buffer = createSpeechBuffer(async () => { calls++; return audio("123456"); }, 50);
  t.after(() => buffer.clear());
  const request = () => buffer.synthesize({ voice: "hf-dora", text: "a".repeat(100) });
  await request();
  const retry = request();
  await promptly(retry);
  assert.equal(calls, 2);
});

test("immediate retry after a rejected generation cannot attach to its completed job", async (t) => {
  let calls = 0;
  const buffer = createSpeechBuffer(async () => {
    if (++calls === 1) throw new Error("synthetic failure");
    return audio();
  });
  t.after(() => buffer.clear());
  let failure;
  try { await buffer.synthesize({ voice: "hf-dora", text: "Retry now" }); }
  catch (error) { failure = error; }
  assert.match(failure.message, /synthetic failure/);
  const retry = buffer.synthesize({ voice: "hf-dora", text: "Retry now" });
  await promptly(retry);
  assert.equal(calls, 2);
});

test("failed generation can be retried and an already aborted consumer never starts transport", async () => {
  let calls = 0;
  const buffer = createSpeechBuffer(async () => {
    if (++calls === 1) throw new Error("synthetic failure");
    return audio();
  });
  await assert.rejects(buffer.synthesize({ voice: "hf-dora", text: "Retry" }), /synthetic failure/);
  await tick();
  await buffer.synthesize({ voice: "hf-dora", text: "Retry" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buffer.synthesize({ voice: "hf-dora", text: "Never", signal: controller.signal }), aborted);
  assert.equal(calls, 2);
  buffer.clear();
});
