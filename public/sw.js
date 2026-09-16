// Bump with app-shell deployments; Next static resources also use build-specific URLs.
const APP_CACHE_VERSION = "v9";
const CACHE_NAME = `lector-documental-raul-assets-${APP_CACHE_VERSION}`;
const SHELL_CACHE_NAME = `lector-documental-raul-shell-${APP_CACHE_VERSION}`;
const SHELL_URL = new URL("/", self.location.origin).href;
const OWN_CACHE = /^lector-documental-raul-(?:v\d+|assets-v\d+|shell-v\d+)$/;
const PUBLIC_ASSETS = new Set([
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icons/lector-documental-icon-headphones.png",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then((cache) => cache.addAll([...PUBLIC_ASSETS])),
      precacheShell(),
    ])
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => OWN_CACHE.test(key) &&
          key !== CACHE_NAME && key !== SHELL_CACHE_NAME)
          .map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Never substitute the shell for API, RSC, range or authenticated requests.
  if (url.origin !== self.location.origin || url.searchParams.has("_rsc") ||
      request.headers.has("rsc") || request.headers.has("next-router-prefetch") ||
      request.headers.has("next-router-state-tree") || request.headers.has("authorization") ||
      (request.headers.get("accept") ?? "").includes("text/x-component") ||
      request.headers.has("range")) return;

  if (request.mode === "navigate") {
    // Query-string variants can represent a different page state; only cache canonical root HTML.
    if (url.pathname !== "/" || url.search !== "") return;
    const response = serveShell(request);
    event.respondWith(response);
    event.waitUntil(response.then(() => undefined, () => undefined));
    return;
  }

  const immutableAsset = url.pathname.startsWith("/_next/static/") &&
    /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|avif|svg|ico)$/.test(url.pathname);
  // Remote models, WASM and Piper requests do not enter the app's asset cache.
  if (!immutableAsset && !PUBLIC_ASSETS.has(url.pathname)) return;

  const response = serveAsset(request, immutableAsset);
  event.respondWith(response);
  event.waitUntil(response.then(() => undefined, () => undefined));
});

function isCacheableShell(response) {
  return response.status === 200 && !response.redirected && response.type !== "opaque" &&
    !/\b(?:no-store|private)\b/i.test(response.headers.get("cache-control") ?? "") &&
    (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() === "text/html";
}

async function precacheShell() {
  const response = await fetch(new Request(SHELL_URL, {
    cache: "reload", headers: { accept: "text/html" },
  }));
  if (!isCacheableShell(response)) throw new Error("Root HTML is not safe to precache.");
  const cache = await caches.open(SHELL_CACHE_NAME);
  await cache.put(SHELL_URL, response);
}

async function serveShell(request) {
  let cache;
  let cached;
  try {
    cache = await caches.open(SHELL_CACHE_NAME);
    cached = await cache.match(SHELL_URL);
    if (cached && !isCacheableShell(cached)) cached = undefined;
  } catch { /* Storage failure must not prevent online navigation. */ }
  try {
    const response = await fetch(request);
    if (response.status >= 500 && cached) return cached;
    if (isCacheableShell(response)) {
      try { await cache?.put(SHELL_URL, response.clone()); } catch { /* Preserve the online response. */ }
    }
    return response;
  } catch {
    return cached ?? Response.error();
  }
}

async function serveAsset(request, immutableAsset) {
  let cache;
  let cached;
  try {
    cache = await caches.open(CACHE_NAME);
    cached = await cache.match(request);
  } catch { /* A cache failure must not prevent an online request. */ }
  if (immutableAsset && cached) return cached;
  try {
    const response = await fetch(request);
    if (response.status === 200 && !response.redirected && response.type !== "opaque" &&
        !/\b(?:no-store|private)\b/i.test(response.headers.get("cache-control") ?? "") &&
        !(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
      try { await cache?.put(request, response.clone()); } catch { /* Cache writes are optional. */ }
    }
    return response;
  } catch {
    return cached ?? Response.error();
  }
}
