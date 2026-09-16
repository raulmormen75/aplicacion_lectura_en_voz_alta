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

// Minimal asynchronous IDB double: writes become visible only on transaction completion.
function harness(shared = {}) {
  const local = shared.local ?? new Map();
  const documents = shared.documents ?? new Map();
  const control = { writes: 0, hold: false, pending: [], failPut: false, failLocal: false, failOpen: false, blocked: false };
  const indexedDB = {
    open() {
      const request = {};
      setImmediate(() => {
        if (control.blocked) { request.onblocked?.(); return; }
        if (control.failOpen) { request.error = new Error("denied"); request.onerror?.(); return; }
        request.result = {
          close() {},
          transaction() {
            const transaction = { abort() { transaction.onabort?.(); } };
            const operation = (kind, key, value) => {
              const item = {};
              const copy = structuredClone(value);
              if (kind === "put") control.writes++;
              const complete = () => {
                item.onsuccess?.();
                if (kind === "put" && control.failPut) {
                  transaction.error = new Error("aborted after request success");
                  transaction.onabort?.();
                  return;
                }
                if (kind === "put") documents.set(key, copy);
                if (kind === "clear") documents.clear();
                if (kind === "get") item.result = structuredClone(documents.get(key));
                transaction.oncomplete?.();
              };
              if (kind === "put" && control.hold) control.pending.push(complete);
              else setImmediate(complete);
              return item;
            };
            transaction.objectStore = () => ({
              get: (key) => operation("get", key),
              put: (value, key) => operation("put", key, value),
              clear: () => operation("clear"),
            });
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
  return { api: exports, local, documents, control };
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
  await turn();
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

test("unchanged large document saves only a small synchronous checkpoint", async () => {
  const h = harness();
  const value = state(h, document("long-book", 150000));
  assert.equal((await h.api.saveReaderState(value)).ok, true);
  const writes = h.control.writes;
  for (let word = 2; word < 50; word++) {
    const saving = h.api.saveReaderState({ ...value, progress: { ...value.progress, currentWord: word } });
    assert.equal(JSON.parse(h.local.get(V2)).progress.currentWord, word);
    assert.equal((await saving).ok, true);
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
  assert.equal(JSON.parse(h.local.get(V2)).progress.currentWord, 2);
  assert.equal((await saving).ok, true);
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
  await turn();
  assert.equal(h.control.writes, 1);
  h.control.pending.shift()();
  assert.equal((await first).code, "superseded");
  assert.equal((await second).ok, true);
  assert.equal(JSON.parse(h.local.get(V2)).progress.currentWord, 3);
});

test("out-of-order document completion cannot overwrite the newest selection", async () => {
  const h = harness();
  h.control.hold = true;
  const first = h.api.saveReaderState(state(h, document("a")));
  const second = h.api.saveReaderState(state(h, document("b"), 2));
  await turn();
  h.control.pending[1]();
  assert.equal((await second).ok, true);
  h.control.pending[0]();
  assert.equal((await first).code, "superseded");
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

test("null document checkpoints need no IDB and clear only reader storage", async () => {
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
