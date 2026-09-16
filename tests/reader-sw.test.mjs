import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const SW = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const CURRENT = "lector-documental-raul-assets-v9";
const SHELL = "lector-documental-raul-shell-v9";
const ORIGIN = "https://reader.test";

function worker() {
  const events = {};
  const stores = new Map();
  const deleted = [];
  const control = { offline: false, status: 200, body: "asset", type: "application/javascript", fetches: 0, puts: 0, claims: 0, skips: 0 };
  const key = (request) => typeof request === "string" ? new URL(request, ORIGIN).href : request.url;
  const caches = {
    async open(name) {
      if (control.failOpen) throw new Error("cache denied");
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(request) { return store.get(key(request))?.clone(); },
        async put(request, response) {
          if (control.failPut) throw new Error("cache full");
          control.puts++;
          store.set(key(request), response.clone());
        },
        async addAll(paths) {
          if (control.failInstall) throw new Error("precache failed");
          for (const path of paths) store.set(key(path), new Response("precache"));
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
  };
  runInNewContext(SW, {
    URL, Request, Response, caches,
    self: {
      location: { origin: ORIGIN },
      addEventListener: (name, handler) => { events[name] = handler; },
      skipWaiting: async () => { control.skips++; },
      clients: { claim: async () => { control.claims++; } },
    },
    fetch: async () => {
      control.fetches++;
      if (control.offline) throw new Error("offline");
      const response = new Response(control.body, {
        status: control.status,
        headers: { "content-type": control.type, "cache-control": control.cacheControl ?? "public" },
      });
      if (control.redirected) Object.defineProperty(response, "redirected", { value: true });
      return response;
    },
  });
  const lifecycle = async (name) => {
    let job;
    events[name]({ waitUntil: (promise) => { job = promise; } });
    await job;
  };
  const request = async (path, options = {}) => {
    let result;
    const lifetime = [];
    events.fetch({
      request: {
        url: new URL(path, ORIGIN).href,
        method: options.method ?? "GET",
        mode: options.mode ?? "cors",
        headers: new Headers(options.headers),
      },
      respondWith: (promise) => { result = promise; },
      waitUntil: (promise) => { lifetime.push(promise); },
    });
    const response = await result;
    await Promise.all(lifetime);
    return response;
  };
  return { control, caches, stores, deleted, lifecycle, request };
}

test("SW activation deletes only old reader app cache versions", async () => {
  const w = worker();
  const protectedNames = ["piper-models", "onnx-runtime", "other-app-v7", "lector-documental-raul-piper-v1", CURRENT, SHELL];
  for (const name of [...protectedNames, "lector-documental-raul-v7", "lector-documental-raul-assets-v6", "lector-documental-raul-shell-v8"]) {
    await w.caches.open(name);
  }
  await w.lifecycle("activate");
  assert.deepEqual(w.deleted.sort(), ["lector-documental-raul-assets-v6", "lector-documental-raul-shell-v8", "lector-documental-raul-v7"]);
  for (const name of protectedNames) assert.equal(w.stores.has(name), true);
  assert.equal(w.control.claims, 1);
});

test("SW failed precache rejects install and does not skip waiting", async () => {
  const w = worker();
  w.control.failInstall = true;
  await assert.rejects(w.lifecycle("install"));
  assert.equal(w.control.skips, 0);
  assert.equal(w.deleted.length, 0);
});

test("SW successful install precaches root HTML separately from assets", async () => {
  const w = worker();
  w.control.type = "text/html; charset=utf-8";
  w.control.body = "<html>root</html>";
  await w.lifecycle("install");
  assert.equal(w.control.skips, 1);
  assert.equal(w.stores.get(CURRENT).has(ORIGIN + "/"), false);
  assert.equal(w.stores.get(CURRENT).has(ORIGIN + "/manifest.webmanifest"), true);
  assert.equal(await w.stores.get(SHELL).get(ORIGIN + "/").text(), "<html>root</html>");
});

test("SW bypasses API, navigation, remote models, Piper, WASM, RSC and ranges", async () => {
  const w = worker();
  for (const [url, options] of [
    ["/other-page", { mode: "navigate" }], ["/api/integrations/status"], ["/api/auth/session"],
    ["https://cdn.test/_next/static/app.js"], ["/models/voice.onnx"], ["/piper/voice.json"],
    ["/_next/static/engine.wasm"], ["/_next/image?url=test"],
    ["/_next/static/app.js?_rsc=1"], ["/_next/static/app.js", { headers: { rsc: "1" } }],
    ["/_next/static/app.js", { headers: { range: "bytes=0-100" } }],
    ["/_next/static/app.js", { method: "POST" }],
  ]) assert.equal(await w.request(url, options), undefined, url);
  assert.equal(w.control.fetches, 0);
  assert.equal(w.stores.size, 0);
});

test("SW root HTML is network-first and reloads offline from its own shell cache", async () => {
  const w = worker();
  w.control.type = "text/html; charset=utf-8";
  w.control.body = "<html>first build</html>";
  await w.request("/", { mode: "navigate" });
  w.control.body = "<html>new build</html>";
  assert.equal(await (await w.request("/", { mode: "navigate" })).text(), "<html>new build</html>");
  w.control.offline = true;
  assert.equal(await (await w.request("/", { mode: "navigate" })).text(), "<html>new build</html>");
  assert.equal(w.control.fetches, 3);
  assert.equal(w.stores.has(CURRENT), false);
});

test("SW shell cannot intercept APIs, assets, RSC, query variants or remote navigation", async () => {
  const w = worker();
  w.control.type = "text/html";
  await w.request("/", { mode: "navigate" });
  w.control.offline = true;
  for (const [url, options] of [
    ["/api/auth/session", { mode: "navigate" }],
    ["/", {}], ["/?_rsc=1", { mode: "navigate" }],
    ["/?view=private", { mode: "navigate" }],
    ["/", { mode: "navigate", headers: { rsc: "1" } }],
    ["/", { mode: "navigate", headers: { accept: "text/x-component" } }],
    ["/", { mode: "navigate", headers: { "next-router-prefetch": "1" } }],
    ["/", { mode: "navigate", headers: { "next-router-state-tree": "tree" } }],
    ["/", { mode: "navigate", headers: { authorization: "Bearer test" } }],
    ["https://external.test/", { mode: "navigate" }],
  ]) assert.equal(await w.request(url, options), undefined, url);
  assert.equal((await w.request("/_next/static/missing.js")).type, "error");
});

test("SW invalid shell responses never replace valid HTML; 5xx uses the last valid shell", async () => {
  for (const change of [
    { type: "text/x-component" }, { type: "application/json" }, { status: 404 },
    { status: 500 }, { redirected: true }, { cacheControl: "private" }, { cacheControl: "no-store" },
  ]) {
    const w = worker();
    w.control.type = "text/html";
    w.control.body = "<html>valid</html>";
    await w.request("/", { mode: "navigate" });
    Object.assign(w.control, change, { body: "invalid replacement" });
    const online = await w.request("/", { mode: "navigate" });
    if (change.status === 500) assert.equal(await online.text(), "<html>valid</html>");
    w.control.offline = true;
    assert.equal(await (await w.request("/", { mode: "navigate" })).text(), "<html>valid</html>");
  }
});

test("SW rejects installation if the root is not public successful HTML", async () => {
  for (const change of [
    { type: "application/json" }, { status: 500 }, { redirected: true }, { cacheControl: "private" },
  ]) {
    const w = worker();
    Object.assign(w.control, { type: "text/html" }, change);
    await assert.rejects(w.lifecycle("install"));
    assert.equal(w.control.skips, 0);
    assert.equal(w.deleted.length, 0);
  }
});

test("SW root fallback never reads another cache version or non-HTML entries", async () => {
  const w = worker();
  for (const name of ["other-app", "lector-documental-raul-shell-v8", CURRENT]) {
    const cache = await w.caches.open(name);
    await cache.put(ORIGIN + "/", new Response("old HTML", { headers: { "content-type": "text/html" } }));
  }
  const shell = await w.caches.open(SHELL);
  await shell.put(ORIGIN + "/", new Response("rsc", { headers: { "content-type": "text/x-component" } }));
  w.control.offline = true;
  assert.equal((await w.request("/", { mode: "navigate" })).type, "error");
});

test("SW shell storage failures preserve online navigation", async () => {
  for (const flag of ["failOpen", "failPut"]) {
    const w = worker();
    w.control.type = "text/html";
    w.control.body = "<html>online</html>";
    w.control[flag] = true;
    assert.equal(await (await w.request("/", { mode: "navigate" })).text(), "<html>online</html>");
  }
});

test("SW caches successful immutable assets and serves the same exact URL offline", async () => {
  const w = worker();
  const path = "/_next/static/chunks/abc123.js";
  assert.equal(await (await w.request(path)).text(), "asset");
  w.control.offline = true;
  assert.equal(await (await w.request(path)).text(), "asset");
  assert.equal(w.control.fetches, 1);
  assert.equal((await w.request("/_next/static/chunks/different.js")).type, "error");
});

test("SW public assets refresh online; a 500 cannot poison a previous cached success", async () => {
  const w = worker();
  await w.request("/manifest.webmanifest");
  w.control.body = "fresh";
  assert.equal(await (await w.request("/manifest.webmanifest")).text(), "fresh");
  w.control.status = 500;
  w.control.body = "server error";
  assert.equal((await w.request("/manifest.webmanifest")).status, 500);
  w.control.offline = true;
  assert.equal(await (await w.request("/manifest.webmanifest")).text(), "fresh");
});

test("SW never caches HTML, partial responses or private/no-store assets", async () => {
  for (const options of [
    { type: "Text/Html; charset=utf-8" }, { status: 206 },
    { cacheControl: "private, max-age=100" }, { cacheControl: "no-store" },
  ]) {
    const w = worker();
    Object.assign(w.control, options);
    await w.request("/_next/static/app.js");
    assert.equal(w.control.puts, 0);
  }
});

test("SW missing asset never receives HTML from another cache or the app root", async () => {
  const w = worker();
  const foreign = await w.caches.open("other-app");
  await foreign.put(ORIGIN + "/", new Response("<html>old shell</html>"));
  await foreign.put(ORIGIN + "/_next/static/app.js", new Response("old script"));
  w.control.offline = true;
  const result = await w.request("/_next/static/app.js");
  assert.equal(result.type, "error");
  assert.equal(result.status, 0);
});

test("SW cache open/put failure does not turn an online response into a network failure", async () => {
  for (const flag of ["failOpen", "failPut"]) {
    const w = worker();
    w.control[flag] = true;
    const response = await w.request("/_next/static/app.js");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "asset");
    assert.equal(w.control.fetches, 1);
  }
});
