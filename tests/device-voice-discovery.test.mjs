import assert from "node:assert/strict";
import test from "node:test";
import { discoverSpanishDeviceVoices, readDeviceVoices } from "../src/lib/reader/device-voice-discovery.ts";
import { preferredSpanishVoice, spanishDeviceVoices } from "../src/lib/reader/device-voices.ts";

const spanish = Object.freeze({ name: "Español de México", lang: "es-MX", voiceURI: "test-es-mx", default: false, localService: true });
const english = Object.freeze({ name: "Default English", lang: "en-US", voiceURI: "test-en", default: true, localService: true });
const realTimerFunctions = Object.fromEntries(["setTimeout", "setInterval", "clearTimeout", "clearInterval"]
  .map(method => [method, globalThis[method]]));

function catalog(initialVoices = [], { events = true, onSubscribe, onRead } = {}) {
  let voices = initialVoices;
  let reads = 0;
  const listeners = new Set();
  const speechCalls = [];
  const provider = {
    getVoices() {
      reads += 1;
      return onRead ? onRead({ reads, voices, setVoices, emit }) : voices;
    },
    speak() { speechCalls.push("speak"); },
    cancel() { speechCalls.push("cancel"); },
    pause() { speechCalls.push("pause"); },
    resume() { speechCalls.push("resume"); },
  };
  if (events) {
    provider.addEventListener = (type, listener) => {
      assert.equal(type, "voiceschanged");
      listeners.add(listener);
      onSubscribe?.({ setVoices, emit });
    };
    provider.removeEventListener = (type, listener) => {
      assert.equal(type, "voiceschanged");
      listeners.delete(listener);
    };
  }
  function setVoices(next) { voices = next; }
  function emit() {
    for (const listener of [...listeners]) listener(new Event("voiceschanged"));
  }
  return { provider, setVoices, emit, speechCalls, reads: () => reads, listenerCount: () => listeners.size };
}

// Audit active timers as well as advancing virtual time: a settled lookup must
// release its resources, including when initialization delivers an early event.
function virtualClock(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const active = new Set();
  const timerFunctions = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  };
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const handle = timerFunctions.setTimeout(() => {
      active.delete(handle);
      callback(...args);
    }, delay);
    active.add(handle);
    return handle;
  });
  t.mock.method(globalThis, "setInterval", (callback, delay, ...args) => {
    const handle = timerFunctions.setInterval(callback, delay, ...args);
    active.add(handle);
    return handle;
  });
  for (const method of ["clearTimeout", "clearInterval"]) {
    t.mock.method(globalThis, method, handle => {
      active.delete(handle);
      timerFunctions[method](handle);
    });
  }
  t.after(() => {
    // Reset both layers together and forget the method mocks. Otherwise the
    // automatic cleanup restores virtual functions after timers were reset.
    t.mock.reset();
  });
  return { tick: ms => t.mock.timers.tick(ms), activeCount: () => active.size };
}

test("reading a catalog preserves voice objects while isolating the array snapshot", () => {
  const original = [english, spanish];
  const source = catalog(original);
  const snapshot = readDeviceVoices(source.provider);
  assert.notEqual(snapshot, original);
  assert.equal(snapshot[0], english);
  assert.equal(snapshot[1], spanish);
  snapshot.pop();
  assert.equal(original.length, 2);
  assert.deepEqual(source.speechCalls, []);
});

test("missing or failing voice engines produce an empty readable catalog", () => {
  assert.deepEqual(readDeviceVoices(), []);
  assert.deepEqual(readDeviceVoices({}), []);
  assert.deepEqual(readDeviceVoices({ getVoices() { throw new Error("Engine is starting"); } }), []);
});

test("an immediate Spanish catalog resolves with the original voice objects and releases resources", async t => {
  const clock = virtualClock(t);
  const source = catalog([english, spanish]);
  const updates = [];
  const result = await discoverSpanishDeviceVoices(source.provider, { onUpdate: voices => updates.push(voices) });
  assert.equal(result[0], english);
  assert.equal(result[1], spanish);
  assert.equal(updates.at(-1)[1], spanish);
  assert.equal(clock.activeCount(), 0);
  assert.equal(source.listenerCount(), 0);
  const readsAtCompletion = source.reads();
  clock.tick(10_000);
  source.emit();
  assert.equal(source.reads(), readsAtCompletion);
  assert.deepEqual(source.speechCalls, []);
});

test("menu discovery keeps watching after the first Spanish voice and publishes later voices without an event", async t => {
  const clock = virtualClock(t);
  const additionalSpanish = Object.freeze({ name: "Otra voz española", lang: "es-ES", voiceURI: "test-es-es", default: false, localService: true });
  const source = catalog([spanish]);
  const updates = [];
  let completed = false;
  const pending = discoverSpanishDeviceVoices(source.provider, {
    keepWatching: true,
    timeoutMs: 100,
    pollIntervalMs: 10,
    onUpdate: voices => updates.push(voices),
  }).then(result => { completed = true; return result; });
  await Promise.resolve();
  assert.equal(completed, false, "The first Spanish voice must not stop menu discovery");
  assert.equal(updates.at(-1)[0], spanish);
  clock.tick(30);
  source.setVoices([spanish, additionalSpanish]);
  clock.tick(10);
  assert.equal(updates.at(-1)[1], additionalSpanish, "A later voice must appear even without voiceschanged");
  clock.tick(59);
  await Promise.resolve();
  assert.equal(completed, false);
  clock.tick(1);
  const result = await pending;
  assert.equal(result[0], spanish);
  assert.equal(result[1], additionalSpanish);
  assert.equal(clock.activeCount(), 0);
  assert.equal(source.listenerCount(), 0);
  const readsAtCompletion = source.reads();
  const updatesAtCompletion = updates.length;
  source.setVoices([]);
  source.emit();
  clock.tick(1000);
  assert.equal(source.reads(), readsAtCompletion);
  assert.equal(updates.length, updatesAtCompletion);
  assert.deepEqual(source.speechCalls, []);
});

test("polling recovers a late Spanish catalog when the provider has no event API", async t => {
  const clock = virtualClock(t);
  const source = catalog([english], { events: false });
  const updates = [];
  const pending = discoverSpanishDeviceVoices(source.provider, {
    timeoutMs: 100,
    pollIntervalMs: 10,
    onUpdate: voices => updates.push(voices),
  });
  clock.tick(30);
  source.setVoices([english, spanish]);
  clock.tick(10);
  const result = await pending;
  assert.equal(result[1], spanish);
  assert.equal(updates.at(-1)[1], spanish);
  assert.equal(clock.activeCount(), 0);
  assert.deepEqual(source.speechCalls, []);
});

test("a voiceschanged event discovers Spanish without waiting for the next poll", async t => {
  const clock = virtualClock(t);
  const source = catalog([]);
  const pending = discoverSpanishDeviceVoices(source.provider, { timeoutMs: 100, pollIntervalMs: 80 });
  source.setVoices([spanish]);
  source.emit();
  assert.equal((await pending)[0], spanish);
  assert.equal(clock.activeCount(), 0);
  assert.equal(source.listenerCount(), 0);
  assert.deepEqual(source.speechCalls, []);
});

test("initialization before the first scheduled read cannot leave discovery timers alive", async t => {
  const clock = virtualClock(t);
  const source = catalog([], {
    onSubscribe({ setVoices, emit }) {
      setVoices([spanish]);
      emit();
    },
  });
  const result = await discoverSpanishDeviceVoices(source.provider, { timeoutMs: 100, pollIntervalMs: 10 });
  assert.equal(result[0], spanish);
  assert.equal(source.listenerCount(), 0);
  assert.equal(clock.activeCount(), 0, "An already completed discovery must not install more timers");
});

test("an initialization event cannot let an older catalog snapshot replace the discovered voice", async t => {
  const clock = virtualClock(t);
  const updates = [];
  const source = catalog([], {
    onRead({ reads, voices, setVoices, emit }) {
      if (reads === 1) {
        setVoices([spanish]);
        emit();
        return [];
      }
      return voices;
    },
  });
  const result = await discoverSpanishDeviceVoices(source.provider, {
    timeoutMs: 100,
    pollIntervalMs: 10,
    onUpdate: voices => updates.push(voices),
  });
  assert.equal(result[0], spanish);
  assert.equal(updates.at(-1)[0], spanish, "A stale outer read must not overwrite a completed event result");
  assert.equal(clock.activeCount(), 0);
  assert.equal(source.listenerCount(), 0);
});

test("aborting a pending lookup releases timers and listeners and prevents later catalog updates", async t => {
  const clock = virtualClock(t);
  const source = catalog([english]);
  const controller = new AbortController();
  const updates = [];
  const pending = discoverSpanishDeviceVoices(source.provider, {
    signal: controller.signal,
    timeoutMs: 100,
    pollIntervalMs: 10,
    onUpdate: voices => updates.push(voices),
  });
  clock.tick(20);
  controller.abort();
  assert.deepEqual(await pending, []);
  assert.equal(clock.activeCount(), 0);
  assert.equal(source.listenerCount(), 0);
  const readsAtCancellation = source.reads();
  const updatesAtCancellation = updates.length;
  source.setVoices([spanish]);
  source.emit();
  clock.tick(1000);
  assert.equal(source.reads(), readsAtCancellation);
  assert.equal(updates.length, updatesAtCancellation);
  assert.deepEqual(source.speechCalls, []);
});

test("an already aborted signal prevents any access to the provider", async t => {
  const clock = virtualClock(t);
  const controller = new AbortController();
  controller.abort();
  let accesses = 0;
  const provider = new Proxy({}, { get() { accesses += 1; throw new Error("Unexpected provider access"); } });
  const result = await discoverSpanishDeviceVoices(provider, {
    signal: controller.signal,
    onUpdate() { assert.fail("A cancelled discovery must not publish updates"); },
  });
  assert.deepEqual(result, []);
  assert.equal(accesses, 0);
  assert.equal(clock.activeCount(), 0);
});

test("an English-only catalog settles within the default limit without inventing Spanish or speaking", async t => {
  const clock = virtualClock(t);
  const source = catalog([english]);
  let completed = false;
  const pending = discoverSpanishDeviceVoices(source.provider).then(result => { completed = true; return result; });
  clock.tick(4999);
  await Promise.resolve();
  assert.equal(completed, false);
  clock.tick(1);
  const result = await pending;
  assert.deepEqual(result, [english]);
  assert.deepEqual(spanishDeviceVoices(result), []);
  assert.equal(preferredSpanishVoice(result), undefined);
  assert.equal(clock.activeCount(), 0);
  assert.equal(source.listenerCount(), 0);
  const readsAtCompletion = source.reads();
  source.setVoices([spanish]);
  source.emit();
  clock.tick(10_000);
  assert.equal(source.reads(), readsAtCompletion);
  assert.deepEqual(source.speechCalls, []);
});

test("a voice engine that initially throws can recover on a later catalog read", async t => {
  const clock = virtualClock(t);
  const source = catalog([spanish], {
    onRead({ reads, voices }) {
      if (reads < 3) throw new Error("Engine is starting");
      return voices;
    },
  });
  const updates = [];
  const pending = discoverSpanishDeviceVoices(source.provider, {
    timeoutMs: 100,
    pollIntervalMs: 10,
    onUpdate: voices => updates.push(voices),
  });
  clock.tick(20);
  assert.equal((await pending)[0], spanish);
  assert.equal(updates[0].length, 0);
  assert.equal(updates.at(-1)[0], spanish);
  assert.equal(clock.activeCount(), 0);
  assert.equal(source.listenerCount(), 0);
  assert.deepEqual(source.speechCalls, []);
});

test("an unavailable discovery provider resolves without waiting or publishing a false catalog", async t => {
  const clock = virtualClock(t);
  for (const provider of [undefined, {}]) {
    assert.deepEqual(await discoverSpanishDeviceVoices(provider, {
      onUpdate() { assert.fail("No provider means no catalog update"); },
    }), []);
  }
  assert.equal(clock.activeCount(), 0);
});

test("discovery timer mocks leave real scheduling intact for subsequent test files", async () => {
  for (const [method, original] of Object.entries(realTimerFunctions)) {
    assert.equal(globalThis[method], original, `${method} must be restored before another test file runs`);
  }
  await new Promise(resolve => setTimeout(resolve, 1));
});
