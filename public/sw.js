// Generated after next build. Import changes participate in service-worker updates.
importScripts("/reader-assets/offline-manifest.js");

const MANIFEST = self.__READER_PRECACHE;
const PREFIX = "lector-documental-raul-core-";
const CACHE_NAME = PREFIX + MANIFEST.version;
const ROOT = new URL("/", self.location.origin).href;
const COMPLETE = new URL("/reader-assets/offline-complete", self.location.origin).href;
const SHELL = "/reader-assets/offline-shell.html";
const entries = new Map(MANIFEST.entries.map((entry) => [new URL(entry.url, ROOT).href, entry]));

self.addEventListener("install", (event) => {
  event.waitUntil(installCore());
  // Let the browser wait for old controlled tabs to close; never skipWaiting.
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (!await isComplete(cache)) throw new Error("Offline core is incomplete.");
    // Keep previous generations: open tabs can still request their build's chunks.
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.searchParams.has("_rsc") ||
      request.headers.has("rsc") || request.headers.has("next-router-prefetch") ||
      request.headers.has("next-router-state-tree") || request.headers.has("authorization") ||
      request.headers.has("range") ||
      (request.headers.get("accept") ?? "").includes("text/x-component")) return;

  if (request.mode === "navigate") {
    if (url.pathname !== "/" || url.search) return;
    event.respondWith(serveShell(request));
    return;
  }

  // No API/document/model caching. Unknown lazy chunks are network-only.
  const known = entries.has(url.href) && url.pathname !== SHELL;
  const oldChunk = url.pathname.startsWith("/_next/static/") &&
    /\.(?:js|css|woff2?)$/.test(url.pathname);
  if (!known && !oldChunk) return;
  event.respondWith(serveAsset(request, known));
});

function validResponse(response, entry) {
  if (response.status !== 200 || response.redirected || response.type === "opaque" ||
      /\b(?:private|no-store)\b/i.test(response.headers.get("cache-control") ?? "")) return false;
  const type = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const types = {
    html: ["text/html"],
    js: ["application/javascript", "text/javascript"],
    css: ["text/css"],
    font: ["font/woff", "font/woff2", "application/font-woff", "application/octet-stream"],
    json: ["application/manifest+json", "application/json"],
    icon: ["image/png", "image/x-icon", "image/vnd.microsoft.icon"],
  };
  return types[entry.kind]?.includes(type) ?? false;
}

async function verifiedResponse(entry) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const source = new URL(entry.fetchUrl ?? entry.url, ROOT);
    if (source.origin !== self.location.origin || source.username || source.password || source.hash ||
        (entry.fetchUrl !== undefined && (entry.kind !== "js" ||
          entry.fetchUrl !== `/reader-assets/offline/${entry.sha256}.js`))) {
      throw new Error("Invalid precache source.");
    }
    const response = await fetch(new Request(source, {
      cache: "reload", credentials: "omit", redirect: "error", signal: controller.signal,
    }));
    if (!validResponse(response, entry)) throw new Error("Invalid precache response.");
    // Fetch exposes decoded bytes; Content-Length can describe compressed transfer bytes.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing precache body.");
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > entry.bytes) throw new Error("Oversized precache response.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (size !== entry.bytes) throw new Error("Incomplete precache response.");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== entry.sha256) throw new Error("Precache build mismatch.");
    return new Response(bytes, { status: 200, headers: response.headers });
  } finally {
    clearTimeout(timeout);
  }
}

async function isComplete(cache) {
  const marker = await cache.match(COMPLETE);
  if (!marker || await marker.text() !== MANIFEST.version) return false;
  for (const [url, entry] of entries) {
    const response = await cache.match(url);
    if (!response || !validResponse(response, entry)) return false;
  }
  return true;
}

async function installCore() {
  if (!/^[a-f0-9]{64}$/.test(MANIFEST.version) || entries.size !== MANIFEST.entries.length ||
      !entries.has(new URL(SHELL, ROOT).href) || entries.size > 128) {
    throw new Error("Invalid offline manifest.");
  }
  const cache = await caches.open(CACHE_NAME);
  if (await isComplete(cache)) return;
  try {
    for (const [url, entry] of entries) await cache.put(url, await verifiedResponse(entry));
    // Commit only after every required byte was verified and stored.
    await cache.put(COMPLETE, new Response(MANIFEST.version));
    if (!await isComplete(cache)) throw new Error("Offline core did not persist.");
  } catch (error) {
    await caches.delete(CACHE_NAME).catch(() => {});
    throw error;
  }
}

async function serveShell(request) {
  try {
    const response = await fetch(request);
    if (response.status < 500) return response;
  } catch { /* Offline navigation uses only a complete, build-pinned snapshot. */ }
  try {
    const cache = await caches.open(CACHE_NAME);
    if (await isComplete(cache)) return await cache.match(new URL(SHELL, ROOT).href);
  } catch { /* Cache may be unavailable or evicted. */ }
  return Response.error();
}

async function serveAsset(request, known) {
  try {
    const current = await caches.open(CACHE_NAME);
    if (await current.match(COMPLETE)) {
      const cached = await current.match(request);
      if (cached && (!known || validResponse(cached, entries.get(request.url)))) return cached;
    }
    if (!known && new URL(request.url).pathname.startsWith("/_next/static/")) {
      for (const name of await caches.keys()) {
        if (!name.startsWith(PREFIX) || name === CACHE_NAME) continue;
        const cache = await caches.open(name);
        if (!await cache.match(COMPLETE)) continue;
        const cached = await cache.match(request);
        if (cached) return cached;
      }
    }
  } catch { /* Storage errors must not block online resources. */ }
  try { return await fetch(request); } catch { return Response.error(); }
}
