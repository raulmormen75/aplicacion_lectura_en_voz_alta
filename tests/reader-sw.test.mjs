import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { createPrecacheManifest, SHELL_PATH } from "../scripts/generate-reader-precache.mjs";

const SW = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://reader.test";
const PREFIX = "lector-documental-raul-core-";
const COMPLETE = ORIGIN + "/reader-assets/offline-complete";

async function fixture(id = "a") {
  const html = '<html><head><script src="/_next/static/' + id + '.js"></script>' +
    '<link rel="stylesheet" href="/_next/static/' + id + '.css">' +
    '<link rel="preload" as="font" href="/_next/static/font.woff2"></head>' +
    '<body>Static shell ' + id + '</body></html>';
  const files = new Map([
    [SHELL_PATH, { body: html, type: "text/html; charset=utf-8" }],
    ["/_next/static/" + id + ".js", { body: "hydrate-" + id, type: "application/javascript" }],
    ["/_next/static/" + id + ".css", { body: "body{color:green}", type: "text/css" }],
    ["/_next/static/font.woff2", { body: "font-bytes", type: "font/woff2" }],
    ["/manifest.webmanifest", { body: JSON.stringify({ icons: [{ src: "/icons/icon.png" }] }), type: "application/manifest+json" }],
    ["/icons/icon.png", { body: "icon-bytes", type: "image/png" }],
  ]);
  const manifest = await createPrecacheManifest({
    html, buildId: id, workerSource: SW, buildManifest: { rootMainFiles: ["static/" + id + ".js"] },
    readAsset: async (path) => {
      if (!files.has(path)) throw Error("missing fixture asset");
      return Buffer.from(files.get(path).body);
    },
  });
  return { manifest, files };
}

function worker({ manifest, files }, stores = new Map()) {
  const events = {};
  const deleted = [];
  const control = { offline: false, fetches: [], puts: 0, claims: 0, skips: 0, overrides: new Map() };
  const key = (request) => typeof request === "string" ? new URL(request, ORIGIN).href : request.url;
  const caches = {
    async open(name) {
      if (control.failOpen) throw Error("cache denied");
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(request) { return store.get(key(request))?.clone(); },
        async put(request, response) {
          if (control.failPut || control.failMarker && key(request) === COMPLETE) throw Error("cache full");
          control.puts++;
          store.set(key(request), response.clone());
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name, handler) => { events[name] = handler; },
    skipWaiting: async () => { control.skips++; },
    clients: { claim: async () => { control.claims++; } },
  };
  runInNewContext(SW, {
    URL, Request, Response, Uint8Array, AbortController, setTimeout, clearTimeout, crypto: webcrypto, caches, self,
    importScripts(path) {
      assert.equal(path, "/reader-assets/offline-manifest.js");
      self.__READER_PRECACHE = manifest;
    },
    fetch: async (request) => {
      const url = key(request);
      control.fetches.push(url);
      if (control.offline) throw Error("offline");
      const path = new URL(url).pathname;
      const asset = files.get(path) ?? { body: "network-only", type: "application/javascript" };
      const override = control.overrides.get(path) ?? {};
      if (override.error) throw Error("network failed");
      const response = new Response(override.body ?? asset.body, {
        status: override.status ?? 200,
        headers: { "content-type": override.type ?? asset.type, "cache-control": override.cacheControl ?? "public", ...override.headers },
      });
      if (override.redirected) Object.defineProperty(response, "redirected", { value: true });
      return response;
    },
  });
  const lifecycle = async (name) => {
    let job;
    events[name]({ waitUntil: (promise) => { job = promise; } });
    await job;
  };
  const request = async (path, options = {}) => {
    let response;
    events.fetch({
      request: { url: new URL(path, ORIGIN).href, method: options.method ?? "GET", mode: options.mode ?? "cors", headers: new Headers(options.headers) },
      respondWith: (promise) => { response = promise; },
    });
    return response;
  };
  return { control, caches, stores, deleted, lifecycle, request, name: PREFIX + manifest.version };
}

test("first install precaches complete HTML/JS/CSS/fonts without visiting any asset first", async () => {
  const data = await fixture();
  const w = worker(data);
  await w.lifecycle("install");
  assert.equal(w.control.fetches.length, data.manifest.entries.length);
  assert.equal(w.control.skips, 0);
  assert.ok(w.stores.get(w.name).has(COMPLETE));
  await w.lifecycle("activate");
  assert.equal(w.control.claims, 1);
  w.control.offline = true;
  assert.equal(await (await w.request("/", { mode: "navigate" })).text(), data.files.get(SHELL_PATH).body);
  for (const entry of data.manifest.entries.filter((entry) => entry.url !== SHELL_PATH)) {
    assert.equal(await (await w.request(entry.url)).text(), data.files.get(entry.url).body);
  }
});

test("partial first install cannot activate or leave a committed shell", async () => {
  const w = worker(await fixture());
  w.control.overrides.set("/_next/static/a.css", { status: 500 });
  await assert.rejects(w.lifecycle("install"));
  assert.equal(w.stores.has(w.name), false);
  await assert.rejects(w.lifecycle("activate"));
  assert.equal(w.control.claims, 0);
  assert.equal(w.control.skips, 0);
});

test("update failure preserves the complete old generation and unrelated caches", async () => {
  const stores = new Map([["piper-models", new Map()], ["other-app", new Map()], ["lector-documental-raul-assets-v9", new Map()]]);
  const oldData = await fixture("a");
  const old = worker(oldData, stores);
  await old.lifecycle("install");
  await old.lifecycle("activate");
  const next = worker(await fixture("b"), stores);
  next.control.overrides.set("/_next/static/b.js", { error: true });
  await assert.rejects(next.lifecycle("install"));
  assert.deepEqual(next.deleted, [next.name]);
  assert.ok(stores.has(old.name));
  assert.ok(stores.has("piper-models"));
  assert.ok(stores.has("lector-documental-raul-assets-v9"));
  old.control.offline = true;
  assert.equal(await (await old.request("/", { mode: "navigate" })).text(), oldData.files.get(SHELL_PATH).body);
  assert.equal(await (await old.request("/_next/static/a.js")).text(), "hydrate-a");
});

test("successful update waits naturally; activation retains chunks used by old tabs", async () => {
  const stores = new Map();
  const oldData = await fixture("a");
  const old = worker(oldData, stores);
  await old.lifecycle("install");
  const nextData = await fixture("b");
  const next = worker(nextData, stores);
  await next.lifecycle("install");
  assert.equal(next.control.skips, 0);
  assert.equal(next.control.claims, 0);
  old.control.offline = true;
  assert.equal(await (await old.request("/", { mode: "navigate" })).text(), oldData.files.get(SHELL_PATH).body);
  await next.lifecycle("activate");
  assert.equal(next.deleted.length, 0);
  next.control.offline = true;
  assert.equal(await (await next.request("/", { mode: "navigate" })).text(), nextData.files.get(SHELL_PATH).body);
  assert.equal(await (await next.request("/_next/static/a.js")).text(), "hydrate-a");
});

test("new network HTML never overwrites the offline build-pinned shell", async () => {
  const data = await fixture();
  const w = worker(data);
  await w.lifecycle("install");
  w.control.overrides.set("/", { body: "<html>new deployment</html>", type: "text/html" });
  assert.equal(await (await w.request("/", { mode: "navigate" })).text(), "<html>new deployment</html>");
  w.control.offline = true;
  assert.equal(await (await w.request("/", { mode: "navigate" })).text(), data.files.get(SHELL_PATH).body);
});

test("commit marker write failure and quota errors abort installation", async () => {
  for (const flag of ["failPut", "failMarker"]) {
    const w = worker(await fixture());
    w.control[flag] = true;
    await assert.rejects(w.lifecycle("install"));
    assert.equal(w.control.skips, 0);
    assert.equal(w.stores.has(w.name), false);
  }
});

test("precache rejects private, redirected, partial, HTML-as-JS and wrong-build bytes", async () => {
  for (const override of [
    { status: 206 }, { status: 404 }, { redirected: true }, { cacheControl: "private" },
    { cacheControl: "no-store" }, { type: "text/html" }, { body: "wrongbytes" },
    { body: "x".repeat(100) }, { body: "x" },
  ]) {
    const w = worker(await fixture());
    w.control.overrides.set("/_next/static/a.js", override);
    await assert.rejects(w.lifecycle("install"));
    assert.equal(w.control.skips, 0);
    assert.equal(w.stores.has(w.name), false);
  }
});

test("compressed Content-Length does not reject valid decoded bytes or bypass body validation", async () => {
  const data = await fixture();
  const path = "/_next/static/a.js";
  const body = data.files.get(path).body;
  const headers = { "content-encoding": "gzip", "content-length": String(gzipSync(body).byteLength) };
  assert.ok(Number(headers["content-length"]) > Buffer.byteLength(body));
  const w = worker(data);
  // Browser Fetch already decoded the body, but retains the transfer headers.
  w.control.overrides.set(path, { body, headers });
  await w.lifecycle("install");
  await w.lifecycle("activate");
  w.control.offline = true;
  assert.equal(await (await w.request(path)).text(), body);
  for (const invalid of [body + "extra", "x", "x".repeat(body.length)]) {
    const failed = worker(data);
    failed.control.overrides.set(path, { body: invalid, headers });
    await assert.rejects(failed.lifecycle("install"));
    assert.equal(failed.stores.has(failed.name), false);
  }
});

test("activation and offline HTML require every core entry, not just a marker", async () => {
  const w = worker(await fixture());
  await w.lifecycle("install");
  w.stores.get(w.name).delete(ORIGIN + "/_next/static/a.js");
  await assert.rejects(w.lifecycle("activate"));
  assert.equal(w.control.claims, 0);
  w.control.offline = true;
  assert.equal((await w.request("/", { mode: "navigate" })).type, "error");
});

test("APIs, document text, models, WASM, RSC and authenticated requests bypass the cache", async () => {
  const w = worker(await fixture());
  for (const [url, options] of [
    ["/api/documents/process"], ["/api/text/reconstruct"], ["/api/auth/session"],
    ["https://cdn.test/_next/static/a.js"], ["/models/voice.onnx"], ["/piper/voice.json"],
    ["/reader-assets/tesseract.worker.min.js"], ["/_next/static/engine.wasm"], ["/_next/image?url=x"],
    ["/_next/static/a.js?_rsc=1"], ["/_next/static/a.js", { headers: { rsc: "1" } }],
    ["/_next/static/a.js", { headers: { range: "bytes=0-100" } }], ["/_next/static/a.js", { method: "POST" }],
    ["/", { mode: "navigate", headers: { authorization: "Bearer test" } }],
    ["/", { mode: "navigate", headers: { accept: "text/x-component" } }],
    ["/", { mode: "navigate", headers: { "next-router-prefetch": "1" } }],
    ["/", { mode: "navigate", headers: { "next-router-state-tree": "tree" } }],
    ["/?view=private", { mode: "navigate" }], ["/other", { mode: "navigate" }],
  ]) assert.equal(await w.request(url, options), undefined, url);
  assert.equal(w.control.fetches.length, 0);
  assert.equal(w.stores.size, 0);
});

test("unknown lazy JS is network-only; no arbitrary or foreign cache fallback", async () => {
  const w = worker(await fixture());
  await w.request("/_next/static/piper-lazy.js");
  assert.equal(w.control.puts, 0);
  const foreign = await w.caches.open("other-app");
  await foreign.put("/_next/static/missing.js", new Response("foreign"));
  w.control.offline = true;
  assert.equal((await w.request("/_next/static/missing.js")).type, "error");
  assert.equal((await w.request("/", { mode: "navigate" })).type, "error");
});

test("cache failures preserve online responses and valid offline core handles 5xx", async () => {
  const data = await fixture();
  const w = worker(data);
  await w.lifecycle("install");
  w.control.overrides.set("/", { status: 503 });
  assert.equal(await (await w.request("/", { mode: "navigate" })).text(), data.files.get(SHELL_PATH).body);
  w.control.failOpen = true;
  w.control.overrides.set("/", { body: "online", type: "text/html" });
  assert.equal(await (await w.request("/", { mode: "navigate" })).text(), "online");
  assert.equal(await (await w.request("/_next/static/a.js")).text(), "hydrate-a");
});

test("generator uses structured HTML and JSON; includes exact query URLs and runtime files", async () => {
  const files = new Map([
    ["/_next/static/main.js?v=1", "main"], ["/_next/static/runtime.js", "runtime"],
    ["/_next/static/main.css", "css"], ["/manifest.webmanifest", '{"icons":[]}'],
  ]);
  const manifest = await createPrecacheManifest({
    html: '<html><script src="/_next/static/main.js?v=1"></script><link href="/_next/static/main.css" rel="stylesheet"></html>',
    buildId: "build", workerSource: SW, buildManifest: { rootMainFiles: ["static/runtime.js"] },
    readAsset: async (path) => Buffer.from(files.get(path)),
  });
  assert.ok(manifest.entries.some((entry) => entry.url === "/_next/static/main.js?v=1"));
  assert.ok(manifest.entries.some((entry) => entry.url === "/_next/static/runtime.js"));
  assert.match(manifest.version, /^[a-f0-9]{64}$/);
  assert.ok(manifest.entries.every((entry) => entry.bytes > 0 && /^[a-f0-9]{64}$/.test(entry.sha256)));
});

test("generator rejects external resources, large models, missing files and oversized core assets", async () => {
  for (const source of ["https://cdn.test/main.js", "/models/model.onnx", "/_next/static/engine.wasm"]) {
    await assert.rejects(createPrecacheManifest({
      html: '<script src="' + source + '"></script>', buildId: "build", workerSource: SW,
      buildManifest: {}, readAsset: async () => Buffer.from('{"icons":[]}'),
    }));
  }
  await assert.rejects(createPrecacheManifest({
    html: '<script src="/_next/static/a.js"></script><link rel="stylesheet" href="/_next/static/a.css">',
    buildId: "build", workerSource: SW, buildManifest: {},
    readAsset: async (path) => path === "/manifest.webmanifest" ? Buffer.from('{"icons":[]}') : Buffer.alloc(2_000_001),
  }));
});

test("generated version changes with worker logic, HTML or build identity", async () => {
  const a = await fixture("a");
  const b = await fixture("b");
  assert.notEqual(a.manifest.version, b.manifest.version);
});
