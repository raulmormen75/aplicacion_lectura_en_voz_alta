import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = ts.transpileModule(
  readFileSync(new URL("../src/lib/reader/storage.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const V1 = "lector-documental-raul:v1";
const V2 = "lector-documental-raul:v2";
const turn = () => new Promise((resolve) => setImmediate(resolve));

// Shared transaction queue models IDB's cross-connection readwrite serialization and rollback.
function harness(shared = {}) {
  const local = shared.local ?? new Map();
  const documents = shared.documents ?? new Map();
  const coordination = shared.coordination ?? { queue: [], busy: false };
  const control = { writes: 0, hold: false, pending: [], failPut: false, failLocal: false, failOpen: false, blocked: false };
  const pump = () => {
    if (coordination.busy || !coordination.queue.length) return;
    coordination.busy = true;
    coordination.queue.shift()();
  };
  const indexedDB = {
    open() {
      const request = {};
      setImmediate(() => {
        if (control.blocked) { request.onblocked?.(); return; }
        if (control.failOpen) { request.error = new Error("denied"); request.onerror?.(); return; }
        request.result = {
          close() {},
          transaction(_store, mode) {
            const jobs = [];
            let staged;
            let ended = false;
            const finish = (aborted) => {
              if (ended) return;
              ended = true;
              if (!aborted && mode === "readwrite") {
                documents.clear();
                for (const [key, value] of staged) documents.set(key, value);
              }
              if (aborted) transaction.onabort?.();
              else transaction.oncomplete?.();
              control.afterTransaction?.(aborted);
              coordination.busy = false;
              setImmediate(pump);
            };
            const transaction = { abort() { finish(true); } };
            const next = () => {
              if (ended) return;
              const job = jobs.shift();
              if (job) job();
              else finish(false);
            };
            const operation = (kind, key, value) => {
              const item = {};
              const copy = structuredClone(value);
              if (kind === "put") control.writes++;
              const complete = () => {
                if (ended) return;
                if (kind === "put") staged.set(key, copy);
                if (kind === "clear") staged.clear();
                if (kind === "get") item.result = structuredClone(staged.get(key));
                if (kind === "getKey") item.result = staged.has(key) ? key : undefined;
                item.onsuccess?.();
                if ((kind === "put" && control.failPut) || (kind === "clear" && control.failClear)) {
                  transaction.error = new Error("aborted after request success");
                  finish(true);
                  return;
                }
                setImmediate(next);
              };
              jobs.push(() => {
                if ((kind === "put" && control.hold) || ((kind === "get" || kind === "getKey") && control.holdGet) ||
                    (kind === "clear" && control.holdClear)) control.pending.push(complete);
                else setImmediate(complete);
              });
              return item;
            };
            transaction.objectStore = () => ({
              get: (key) => operation("get", key),
              getKey: (key) => operation("getKey", key),
              put: (value, key) => operation("put", key, value),
              clear: () => operation("clear"),
            });
            coordination.queue.push(() => { staged = new Map(documents); next(); });
            setImmediate(pump);
            return transaction;
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
  const window = { indexedDB, localStorage: {
    getItem(key) { if (control.failRead) throw new Error("denied"); return local.get(key) ?? null; },
    setItem(key, value) { if (control.failLocal) throw new DOMException("full", "QuotaExceededError"); local.set(key, value); },
    removeItem(key) { local.delete(key); },
  } };
  const exports = {};
  runInNewContext(source, { exports, require, window, structuredClone, crypto: globalThis.crypto, setTimeout, clearTimeout });
  return { api: exports, local, documents, control, coordination };
}

async function waitForPending(h) {
  for (let i = 0; i < 50 && !h.control.pending.length; i++) await turn();
  assert.ok(h.control.pending.length, "expected a held IDB request");
}

function document(id = "book-a", words = 4) {
  const text = Array(words).fill("palabra").join(" ");
  return {
    id, title: id, source: "pastedText", sourceLabel: "test", createdAt: "2026-09-16T00:00:00.000Z",
    originalText: text, cleanText: text, wordCount: words, detectedLanguage: "es",
    chunks: [{ id: "chunk-1", text, cleanText: text, startWord: 0, wordCount: words, language: "es" }],
    quality: { status: "ready", message: "test", ocrAvailable: false },
  };
}

function state(h, doc = document(), word = 1) {
  const value = structuredClone(h.api.DEFAULT_READER_STATE);
  value.document = doc;
  value.progress.documentId = doc?.id ?? null;
  value.progress.currentWord = doc ? word : 0;
  return value;
}

test("empty storage loads fresh independent defaults", async () => {
  const h = harness();
  const first = await h.api.loadReaderState();
  assert.equal(first.ok, true);
  first.state.preferences.rate = 0.5;
  assert.equal((await h.api.loadReaderState()).state.preferences.rate, 1);
  assert.equal(h.local.size, 0);
});

test("v1 migrates document before checkpoint and remains byte-for-byte intact", async () => {
  const h = harness();
  const legacy = JSON.stringify(state(h));
  h.local.set(V1, legacy);
  h.control.hold = true;
  const loading = h.api.loadReaderState();
  await waitForPending(h);
  assert.equal(h.local.has(V2), false);
  assert.equal(h.local.get(V1), legacy);
  h.control.pending.shift()();
  assert.equal((await loading).ok, true);
  assert.equal(h.local.get(V1), legacy);
  assert.equal(JSON.parse(h.local.get(V2)).progress.currentWord, 1);
  assert.equal(h.documents.size, 1);
});

test("aborted migration preserves v1 and retries successfully", async () => {
  const h = harness();
  const legacy = JSON.stringify(state(h));
  h.local.set(V1, legacy);
  h.control.failPut = true;
  const failed = await h.api.loadReaderState();
  assert.equal(failed.ok, false);
  assert.equal(failed.state.progress.currentWord, 1);
  assert.equal(h.local.has(V2), false);
  assert.equal(h.local.get(V1), legacy);
  h.control.failPut = false;
  assert.equal((await h.api.loadReaderState()).ok, true);
});

test("checkpoint quota failure preserves v1 and returns a handled error", async () => {
  const h = harness();
  const legacy = JSON.stringify(state(h));
  h.local.set(V1, legacy);
  h.control.failLocal = true;
  assert.equal((await h.api.loadReaderState()).ok, false);
  assert.equal(h.local.get(V1), legacy);
  assert.equal(h.local.has(V2), false);
});

test("unchanged large document publishes only a small checkpoint without rewriting the book", async () => {
  const h = harness();
  const value = state(h, document("long-book", 150000));
  assert.equal((await h.api.saveReaderState(value)).ok, true);
  const writes = h.control.writes;
  for (let word = 2; word < 50; word++) {
    const saving = h.api.saveReaderState({ ...value, progress: { ...value.progress, currentWord: word } });
    assert.equal((await saving).ok, true);
    assert.equal(JSON.parse(h.local.get(V2)).progress.currentWord, word);
  }
  assert.equal(h.control.writes, writes);
  assert.ok(h.local.get(V2).length < 1500);
  assert.equal(h.local.get(V2).includes("palabra"), false);
});

test("fresh load reuses its document record on the next word", async () => {
  const h = harness();
  await h.api.saveReaderState(state(h));
  const fresh = harness(h);
  const loaded = await fresh.api.loadReaderState();
  assert.equal(loaded.ok, true);
  loaded.state.progress.currentWord = 2;
  const saving = fresh.api.saveReaderState(loaded.state);
  assert.equal((await saving).ok, true);
  assert.equal(JSON.parse(h.local.get(V2)).progress.currentWord, 2);
  assert.equal(fresh.control.writes, 0);
});

test("changed reference with same ID creates a new durable version", async () => {
  const h = harness();
  const old = state(h);
  await h.api.saveReaderState(old);
  const before = h.local.get(V2);
  const changed = state(h, document("book-a", 8), 6);
  h.control.failLocal = true;
  assert.equal((await h.api.saveReaderState(changed)).ok, false);
  assert.equal(h.local.get(V2), before);
  const loaded = await harness(h).api.loadReaderState();
  assert.equal(loaded.state.document.wordCount, 4);
  assert.equal(loaded.state.progress.currentWord, 1);
  h.control.failLocal = false;
  assert.equal((await h.api.saveReaderState(changed)).ok, true);
  assert.equal((await harness(h).api.loadReaderState()).state.document.wordCount, 8);
  assert.equal(h.control.writes, 2);
});

test("pending word saves share one document write and latest checkpoint wins", async () => {
  const h = harness();
  h.control.hold = true;
  const value = state(h);
  const first = h.api.saveReaderState(value);
  const second = h.api.saveReaderState({ ...value, progress: { ...value.progress, currentWord: 3 } });
  await waitForPending(h);
  assert.equal(h.control.writes, 1);
  h.control.pending.shift()();
  assert.equal((await first).code, "superseded");
  assert.equal((await second).ok, true);
  assert.equal(JSON.parse(h.local.get(V2)).progress.currentWord, 3);
});

test("queued document writes cannot publish an older selection", async () => {
  const h = harness();
  h.control.hold = true;
  const first = h.api.saveReaderState(state(h, document("a")));
  const second = h.api.saveReaderState(state(h, document("b"), 2));
  await waitForPending(h);
  h.control.pending.shift()();
  assert.equal((await first).code, "superseded");
  await waitForPending(h);
  h.control.pending.shift()();
  assert.equal((await second).ok, true);
  assert.equal(JSON.parse(h.local.get(V2)).documentId, "b");
});

test("bad JSON and malformed documents are not silently overwritten", async () => {
  for (const raw of ["{broken", '{"document":{}}', '{"progress":{"currentWord":-1}}']) {
    const h = harness();
    h.local.set(V1, raw);
    assert.equal((await h.api.loadReaderState()).ok, false);
    assert.equal(h.local.get(V1), raw);
    assert.equal(h.local.has(V2), false);
  }
});

test("mismatched IDs, out-of-bounds progress and invalid document structure are rejected", async () => {
  for (const mutate of [
    (s) => { s.progress.documentId = "another-book"; },
    (s) => { s.progress.currentWord = 100; },
    (s) => { s.progress.currentWord = NaN; },
    (s) => { s.preferences.rate = 0; },
    (s) => { s.document.chunks[0].startWord = 3; },
    (s) => { s.document.wordCount = 9; },
  ]) {
    const h = harness();
    const value = state(h);
    mutate(value);
    assert.equal((await h.api.saveReaderState(value)).ok, false);
    assert.equal(h.local.has(V2), false);
  }
});

test("missing IDB document never attaches an old v1 book to a newer checkpoint", async () => {
  const h = harness();
  h.local.set(V1, JSON.stringify(state(h, document("old"))));
  await h.api.saveReaderState(state(h, document("new")));
  const before = h.local.get(V2);
  h.documents.clear();
  const loaded = await harness(h).api.loadReaderState();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.state.document, null);
  assert.equal(h.local.get(V2), before);
});

test("tampered checkpoint document ID and progress are rejected on load", async () => {
  for (const field of ["documentId", "progress"]) {
    const h = harness();
    await h.api.saveReaderState(state(h));
    const checkpoint = JSON.parse(h.local.get(V2));
    if (field === "documentId") checkpoint.documentId = "wrong";
    else checkpoint.progress.documentId = "wrong";
    h.local.set(V2, JSON.stringify(checkpoint));
    assert.equal((await harness(h).api.loadReaderState()).ok, false);
  }
});

test("denied and blocked IDB operations return errors, not rejected promises", async () => {
  for (const flag of ["failOpen", "blocked"]) {
    const h = harness();
    h.control[flag] = true;
    assert.equal((await h.api.saveReaderState(state(h))).ok, false);
    assert.equal(h.local.has(V2), false);
  }
  const h = harness();
  h.control.failRead = true;
  assert.equal((await h.api.loadReaderState()).ok, false);
});

test("null checkpoints write no document and reset affects only reader storage", async () => {
  const h = harness();
  h.local.set("unrelated", "keep");
  assert.equal((await h.api.saveReaderState(state(h, null))).ok, true);
  assert.equal(h.control.writes, 0);
  await h.api.saveReaderState(state(h));
  const legacy = JSON.stringify(state(h));
  h.local.set(V1, legacy);
  assert.equal((await h.api.clearReaderState()).ok, true);
  assert.equal(h.local.get("unrelated"), "keep");
  assert.equal(h.local.get(V1), legacy);
  assert.equal(JSON.parse(h.local.get(V2)).documentKey, null);
  assert.equal(h.documents.size, 0);
  assert.equal((await harness(h).api.loadReaderState()).state.document, null);
});

async function twoTabs() {
  const a = harness();
  await a.api.saveReaderState(state(a, document("shared", 400), 100));
  const b = harness(a);
  const aState = (await a.api.loadReaderState()).state;
  const bState = (await b.api.loadReaderState()).state;
  return { a, b, aState, bState };
}

function assertVisibleConflict(result) {
  assert.equal(result.ok, false);
  assert.equal(result.code, "storage");
  assert.match(result.error, /Recarga.*avance mas reciente/);
}

test("stale tab and repeated autosaves cannot overwrite progress or silently adopt a new baseline", async () => {
  const { a, b, aState, bState } = await twoTabs();
  aState.progress.currentWord = 200;
  assert.equal((await a.api.saveReaderState(aState)).ok, true);
  const current = a.local.get(V2);
  bState.preferences.theme = "night";
  for (let attempt = 0; attempt < 3; attempt++) {
    bState.progress.currentWord++;
    assertVisibleConflict(await b.api.saveReaderState(bState));
    assert.equal(a.local.get(V2), current);
  }
  assertVisibleConflict(await b.api.saveReaderState(state(b, document("replacement"))));
  assert.equal(a.local.get(V2), current);
  const recovered = await b.api.loadReaderState();
  assert.equal(recovered.state.progress.currentWord, 200);
  assert.equal((await b.api.saveReaderState(recovered.state)).ok, true);
});

test("intentional backward progress and document replacement work on a current baseline", async () => {
  const { a, b, aState, bState } = await twoTabs();
  aState.progress.currentWord = 10;
  assert.equal((await a.api.saveReaderState(aState)).ok, true);
  assert.equal(JSON.parse(a.local.get(V2)).progress.currentWord, 10);
  assertVisibleConflict(await b.api.saveReaderState(bState));
  assert.equal((await a.api.saveReaderState(state(a, document("new-book")))).ok, true);
  assert.equal((await harness(a).api.loadReaderState()).state.document.id, "new-book");
});

test("simultaneous tabs sharing a baseline allow exactly one publication", async () => {
  const { a, b, aState, bState } = await twoTabs();
  aState.progress.currentWord = 150;
  bState.progress.currentWord = 50;
  const results = await Promise.all([a.api.saveReaderState(aState), b.api.saveReaderState(bState)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assertVisibleConflict(results.find((result) => !result.ok));
  const expectedWord = results[0].ok ? 150 : 50;
  assert.equal(JSON.parse(a.local.get(V2)).progress.currentWord, expectedWord);
});

test("revision detects changes even when another tab restores byte-identical state values", async () => {
  const { a, b, aState, bState } = await twoTabs();
  const before = a.local.get(V2);
  aState.progress.currentWord = 200;
  await a.api.saveReaderState(aState);
  aState.progress.currentWord = 100;
  await a.api.saveReaderState(aState);
  assert.notEqual(a.local.get(V2), before);
  assertVisibleConflict(await b.api.saveReaderState(bState));
});

test("reset in another tab prevents a cached ready reference from publishing a missing document", async () => {
  const { a, b, bState } = await twoTabs();
  a.local.set(V1, "legacy stays");
  assert.equal((await a.api.clearReaderState()).ok, true);
  const tombstone = a.local.get(V2);
  for (let attempt = 0; attempt < 2; attempt++) assertVisibleConflict(await b.api.saveReaderState(bState));
  assert.equal(a.local.get(V2), tombstone);
  assert.equal(a.documents.size, 0);
  assert.equal(a.local.get(V1), "legacy stays");
  assert.equal((await b.api.loadReaderState()).state.document, null);
  assert.equal((await b.api.saveReaderState(state(b, document("after-reset")))).ok, true);
  assert.equal((await harness(a).api.loadReaderState()).state.document.id, "after-reset");
});

test("a document removed without a checkpoint change is not falsely reported as saved", async () => {
  const { a, b, bState } = await twoTabs();
  const checkpoint = a.local.get(V2);
  a.documents.clear();
  const result = await b.api.saveReaderState(bState);
  assert.equal(result.ok, false);
  assert.equal(result.code, "storage");
  assert.match(result.error, /documento ya no esta disponible/);
  assert.equal(a.local.get(V2), checkpoint);
});

test("publication quota failure keeps the instance baseline retryable", async () => {
  const { a, aState } = await twoTabs();
  const before = a.local.get(V2);
  a.control.failLocal = true;
  aState.progress.currentWord = 150;
  assert.equal((await a.api.saveReaderState(aState)).ok, false);
  assert.equal(a.local.get(V2), before);
  a.control.failLocal = false;
  assert.equal((await a.api.saveReaderState(aState)).ok, true);
  assert.equal(JSON.parse(a.local.get(V2)).progress.currentWord, 150);
});

test("clear abort restores the checkpoint and baseline without losing the document", async () => {
  const { a, aState } = await twoTabs();
  const before = a.local.get(V2);
  a.local.set(V1, "legacy");
  a.control.failClear = true;
  assert.equal((await a.api.clearReaderState()).ok, false);
  assert.equal(a.local.get(V2), before);
  assert.equal(a.local.get(V1), "legacy");
  assert.equal(a.documents.size, 1);
  const restored = await harness(a).api.loadReaderState();
  assert.equal(restored.ok, true);
  assert.equal(restored.state.progress.currentWord, 100);
  aState.progress.currentWord = 120;
  assert.equal((await a.api.saveReaderState(aState)).ok, true);
});

test("clear rollback does not overwrite a publication from a non-cooperating writer", async () => {
  const { a } = await twoTabs();
  const before = JSON.parse(a.local.get(V2));
  a.control.failClear = true;
  a.control.holdClear = true;
  const clearing = a.api.clearReaderState();
  await waitForPending(a);
  const newer = JSON.stringify({ ...before, revision: "foreign-writer" });
  a.local.set(V2, newer);
  a.control.pending.shift()();
  assert.equal((await clearing).ok, false);
  assert.equal(a.local.get(V2), newer);
  assertVisibleConflict(await a.api.saveReaderState(state(a)));
});

test("Helmholtz P1: A clear, B load and autosave, A abort preserves the original document", async () => {
  const { a, b } = await twoTabs();
  const before = a.local.get(V2);
  a.control.failClear = true;
  a.control.holdClear = true;
  const clearing = a.api.clearReaderState();
  await waitForPending(a);
  assert.equal(JSON.parse(a.local.get(V2)).pendingClear, true);
  const loaded = await b.api.loadReaderState();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, "storage");
  assert.match(loaded.error, /Borrado pendiente/);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await b.api.saveReaderState(loaded.state)).ok, false);
    assert.equal((await b.api.clearReaderState()).ok, false);
  }
  a.control.pending.shift()();
  assert.equal((await clearing).ok, false);
  assert.equal(a.local.get(V2), before);
  assert.equal(a.documents.size, 1);
  const restored = await b.api.loadReaderState();
  assert.equal(restored.ok, true);
  assert.equal(restored.state.document.id, "shared");
  assert.equal(restored.state.progress.currentWord, 100);
});

test("pending clear remains non-recoverable between IDB commit and coordinated finalization", async () => {
  const { a, b } = await twoTabs();
  a.control.afterTransaction = (aborted) => {
    if (!aborted && a.documents.size === 0) a.control.holdGet = true;
  };
  const clearing = a.api.clearReaderState();
  await waitForPending(a);
  assert.equal(a.documents.size, 0);
  assert.equal(JSON.parse(a.local.get(V2)).pendingClear, true);
  const loaded = await b.api.loadReaderState();
  assert.equal(loaded.ok, false);
  assert.equal((await b.api.saveReaderState(loaded.state)).ok, false);
  assert.equal((await b.api.clearReaderState()).ok, false);
  a.control.pending.shift()();
  assert.equal((await clearing).ok, true);
  assert.equal(JSON.parse(a.local.get(V2)).pendingClear, undefined);
  const final = await b.api.loadReaderState();
  assert.equal(final.ok, true);
  assert.equal(final.state.document, null);
});

test("corrupt checkpoint recovery is explicit and does not authorize autosave", async () => {
  for (const raw of ["{broken", '{"version":2}', '{"documentKey":123}']) {
    const h = harness();
    h.local.set(V2, raw);
    h.local.set(V1, "legacy");
    const failed = await h.api.loadReaderState();
    assert.equal(failed.ok, false);
    assertVisibleConflict(await h.api.saveReaderState(failed.state));
    assert.equal(h.local.get(V2), raw);
    assert.equal((await h.api.clearReaderState()).ok, true);
    assert.equal(h.local.get(V1), "legacy");
    assert.equal((await h.api.loadReaderState()).state.document, null);
  }
});

test("explicit recovery cannot erase a checkpoint replaced since the failed load", async () => {
  const { a, b, bState } = await twoTabs();
  const valid = a.local.get(V2);
  a.local.set(V2, "{broken");
  assert.equal((await a.api.loadReaderState()).ok, false);
  a.local.set(V2, valid);
  bState.progress.currentWord = 200;
  assert.equal((await b.api.saveReaderState(bState)).ok, true);
  const newer = a.local.get(V2);
  assertVisibleConflict(await a.api.clearReaderState());
  assert.equal(a.local.get(V2), newer);
  assert.equal(a.documents.size, 1);
});

test("aborted corrupt-checkpoint recovery restores the corrupt raw for another explicit attempt", async () => {
  const h = harness();
  h.local.set(V2, "{broken");
  await h.api.loadReaderState();
  h.control.failClear = true;
  assert.equal((await h.api.clearReaderState()).ok, false);
  assert.equal(h.local.get(V2), "{broken");
  assertVisibleConflict(await h.api.saveReaderState(state(h)));
  h.control.failClear = false;
  assert.equal((await h.api.clearReaderState()).ok, true);
});

test("stale reset cannot delete a newer tab's update", async () => {
  const { a, b, aState } = await twoTabs();
  aState.progress.currentWord = 200;
  await a.api.saveReaderState(aState);
  const checkpoint = a.local.get(V2);
  assertVisibleConflict(await b.api.clearReaderState());
  assert.equal(a.local.get(V2), checkpoint);
  assert.equal(a.documents.size, 1);
});

test("simultaneous update and reset serialize without dangling checkpoints", async () => {
  for (const resetFirst of [false, true]) {
    const { a, b, bState } = await twoTabs();
    bState.progress.currentWord = 200;
    const results = await Promise.all(resetFirst
      ? [a.api.clearReaderState(), b.api.saveReaderState(bState)]
      : [b.api.saveReaderState(bState), a.api.clearReaderState()]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assertVisibleConflict(results.find((result) => !result.ok));
    const loaded = await harness(a).api.loadReaderState();
    assert.equal(loaded.ok, true);
    if (loaded.state.document) assert.equal(loaded.state.progress.currentWord, 200);
    else assert.equal(a.documents.size, 0);
  }
});

test("document preparation racing reset cannot publish its deleted record", async () => {
  const { a, b } = await twoTabs();
  b.control.hold = true;
  const saving = b.api.saveReaderState(state(b, document("replacement")));
  await waitForPending(b);
  const clearing = a.api.clearReaderState();
  await turn();
  b.control.pending.shift()();
  assert.equal((await clearing).ok, true);
  assertVisibleConflict(await saving);
  assert.equal(a.documents.size, 0);
  assert.equal((await harness(a).api.loadReaderState()).state.document, null);
});

test("saving during reset is rejected until a final checkpoint is loaded", async () => {
  const { a, b } = await twoTabs();
  a.control.holdClear = true;
  const clearing = a.api.clearReaderState();
  await waitForPending(a);
  assert.equal((await b.api.loadReaderState()).ok, false);
  assert.equal((await b.api.saveReaderState(state(b, document("after-clear")))).ok, false);
  a.control.pending.shift()();
  assert.equal((await clearing).ok, true);
  assert.equal((await b.api.loadReaderState()).ok, true);
  assert.equal((await b.api.saveReaderState(state(b, document("after-clear")))).ok, true);
  assert.equal((await harness(a).api.loadReaderState()).state.document.id, "after-clear");
});

test("checkpoints from the prior release without a revision remain loadable", async () => {
  const h = harness();
  await h.api.saveReaderState(state(h));
  const checkpoint = JSON.parse(h.local.get(V2));
  delete checkpoint.revision;
  h.local.set(V2, JSON.stringify(checkpoint));
  const fresh = harness(h);
  const loaded = await fresh.api.loadReaderState();
  assert.equal(loaded.ok, true);
  assert.equal((await fresh.api.saveReaderState(loaded.state)).ok, true);
  assert.equal(typeof JSON.parse(h.local.get(V2)).revision, "string");
});

test("concurrent v1 migrations preserve legacy and cannot replace the winner's checkpoint", async () => {
  const a = harness();
  const legacy = JSON.stringify(state(a));
  a.local.set(V1, legacy);
  const b = harness(a);
  const results = await Promise.all([a.api.loadReaderState(), b.api.loadReaderState()]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assertVisibleConflict(results.find((result) => !result.ok));
  assert.equal(a.local.get(V1), legacy);
  assert.equal((await harness(a).api.loadReaderState()).ok, true);
});

test("replacement growth is explicit: immutable revisions are retained, not garbage-collected", async () => {
  const h = harness();
  for (let version = 0; version < 12; version++) {
    assert.equal((await h.api.saveReaderState(state(h, document("book-a", 4 + version)))).ok, true);
  }
  assert.equal(h.documents.size, 12);
  assert.equal((await harness(h).api.loadReaderState()).state.document.wordCount, 15);
});

test("failed reset checkpoint leaves the previous document and legacy intact", async () => {
  const h = harness();
  await h.api.saveReaderState(state(h));
  h.local.set(V1, "legacy");
  const checkpoint = h.local.get(V2);
  h.control.failLocal = true;
  assert.equal((await h.api.clearReaderState()).ok, false);
  assert.equal(h.local.get(V1), "legacy");
  assert.equal(h.local.get(V2), checkpoint);
  assert.equal(h.documents.size, 1);
});

test("real text constructor output survives validation and round-trip", async () => {
  const { createDocumentFromText } = await import("../src/lib/reader/text.ts");
  const h = harness();
  for (const text of [
    "# Titulo\n\nUn parrafo de prueba.\n\n- Primer punto\n- Segundo punto",
    "2 + 2 = 4.\n\n" + "Esta es una frase extensa. ".repeat(150),
    "",
  ]) {
    const doc = createDocumentFromText({ title: "test", source: "pastedText", sourceLabel: "test", text });
    const saving = await h.api.saveReaderState(state(h, doc, 0));
    assert.equal(saving.ok, true, saving.error);
    const loaded = await harness(h).api.loadReaderState();
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.state.document.cleanText, doc.cleanText);
  }
});

test("save/load during reset return a retryable error and do not create a dangling checkpoint", async () => {
  const h = harness();
  await h.api.saveReaderState(state(h));
  const clearing = h.api.clearReaderState();
  assert.equal((await h.api.saveReaderState(state(h, document("new")))).code, "storage");
  assert.equal((await h.api.loadReaderState()).ok, false);
  assert.equal((await clearing).ok, true);
  assert.equal((await h.api.loadReaderState()).state.document, null);
  assert.equal((await h.api.saveReaderState(state(h, document("new")))).ok, true);
});
