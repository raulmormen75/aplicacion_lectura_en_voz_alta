// Manual only: node tests/browser-offline.mjs http://localhost:3010/
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";

const target = new URL(process.argv[2] ?? "http://localhost:3010/");
assert.ok(["http:", "https:"].includes(target.protocol), "La URL debe usar HTTP o HTTPS.");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "Esta prueba solo admite un servidor local.");
assert.ok(!target.username && !target.password && target.pathname === "/" && !target.search && !target.hash,
  "Usa la raiz del servidor local, sin credenciales, parametros ni fragmentos.");

const TIMEOUT = 30_000;
const SW_TIMEOUT = 120_000;
const sample = [
  "# Prueba local sin conexion",
  "Este documento sintetico comprueba que el contenido puede prepararse sin una conexion de red.",
  "Este segundo parrafo permite verificar la estructura y los controles de la interfaz.",
].join("\n\n");
const expectedText = sample.replace(/^# /, "").replace(/\s+/g, " ");
const outputRoot = fileURLToPath(new URL("../output/playwright/", import.meta.url));
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, "offline-"));
const report = { url: target.href, startedAt: new Date().toISOString(), passed: false,
  phases: [], blockedApi: [], failures: [], consoleErrors: [], pageErrors: [], responses: [] };
let phase = "setup";
let browser;
let context;
let page;
let tracing = false;
let failure;
const phasesByRequest = new WeakMap();
const mark = (name) => {
  phase = name;
  report.phases.push({ name, at: new Date().toISOString() });
  console.log(name);
};
const isApi = (url) => /\/api(?:\/|$)/.test(new URL(url).pathname);

try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({ serviceWorkers: "allow", viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(TIMEOUT);
  context.setDefaultNavigationTimeout(TIMEOUT);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  tracing = true;

  // No API data is transmitted, including the initial optional integration checks.
  // The app SW does not intercept API routes. Routing also disables HTTP cache,
  // so successful offline reloads must use the service worker, not HTTP cache.
  await context.route("**/*", async (route) => {
    if (isApi(route.request().url())) {
      report.blockedApi.push({ phase, url: route.request().url(), method: route.request().method() });
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  context.on("request", (request) => phasesByRequest.set(request, phase));
  context.on("requestfailed", (request) => report.failures.push({
    phase: phasesByRequest.get(request), url: request.url(), type: request.resourceType(),
    serviceWorker: !!request.serviceWorker(), error: request.failure()?.errorText,
  }));
  context.on("response", (response) => report.responses.push({
    phase: phasesByRequest.get(response.request()), url: response.url(), status: response.status(),
    serviceWorker: response.fromServiceWorker(),
  }));
  page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push({ phase, message: error.message }));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push({ phase, message: message.text() });
  });

  mark("first-visit-online");
  const online = await page.goto(target.href, { waitUntil: "load" });
  assert.equal(online?.status(), 200, "La primera visita debe responder HTTP 200.");
  await page.getByRole("button", { name: "Pegar texto", exact: true }).waitFor({ state: "visible" });

  mark("wait-service-worker");
  await page.evaluate(async (timeout) => {
    if (!("serviceWorker" in navigator)) throw new Error("Service worker no disponible.");
    let timer;
    try {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Timeout esperando SW ready.")), timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  }, SW_TIMEOUT);
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated", null, { timeout: SW_TIMEOUT });
  const worker = context.serviceWorkers().find((candidate) => candidate.url() === new URL("/sw.js", target).href);
  assert.ok(worker, "No se encontro el SW de la aplicacion.");
  const manifest = await worker.evaluate(() => self.__READER_PRECACHE);
  assert.match(manifest?.version ?? "", /^[a-f0-9]{64}$/, "El SW debe cargar un manifiesto versionado.");
  assert.ok(Array.isArray(manifest.entries) && manifest.entries.length > 0, "El manifiesto debe contener recursos.");
  const cacheState = await page.evaluate(async (manifest) => {
    const name = `lector-documental-raul-core-${manifest.version}`;
    if (!await caches.has(name)) throw new Error("No existe la cache de esta version.");
    const cache = await caches.open(name);
    const marker = await cache.match(new URL("/reader-assets/offline-complete", location.origin).href);
    const missing = [];
    for (const entry of manifest.entries) {
      if (!await cache.match(new URL(entry.url, location.origin).href)) missing.push(entry.url);
    }
    return { name, marker: marker ? await marker.text() : null, missing,
      controller: navigator.serviceWorker.controller?.scriptURL };
  }, manifest);
  assert.equal(cacheState.marker, manifest.version, "La cache debe estar completa para esta version.");
  assert.deepEqual(cacheState.missing, [], "Faltan recursos del manifiesto en la cache.");
  report.cache = { ...cacheState, entries: manifest.entries.length };

  mark("offline-reload");
  await context.setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false);
  const reloaded = await page.reload({ waitUntil: "load" });
  assert.equal(reloaded?.status(), 200, "La recarga offline debe responder HTTP 200.");
  assert.equal(reloaded.fromServiceWorker(), true, "El documento debe provenir del SW.");
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL), cacheState.controller);

  const icon = page.locator('.reader-topbar .file-icon img');
  await icon.waitFor({ state: "visible" });
  report.icon = await icon.evaluate((image) => ({
    src: image.currentSrc, complete: image.complete, naturalWidth: image.naturalWidth,
  }));
  assert.equal(report.icon.complete, true, "El icono debe terminar de cargar offline.");
  assert.ok(report.icon.naturalWidth > 0, "El icono no debe aparecer roto offline.");

  const paste = page.getByRole("button", { name: "Pegar texto", exact: true });
  await paste.waitFor({ state: "visible" });
  assert.equal(await paste.isEnabled(), true);
  await paste.click();
  const textarea = page.getByRole("textbox", { name: "Texto para escuchar", exact: true });
  await textarea.waitFor({ state: "visible" });
  const prepare = page.getByRole("button", { name: "Preparar texto", exact: true });
  // A fresh context starts with the app's sample text, not an empty textarea.
  await textarea.fill("");
  assert.equal(await prepare.isDisabled(), true, "Preparar texto debe iniciar desactivado con texto vacio.");

  mark("prepare-synthetic-text-offline");
  await textarea.fill(sample);
  assert.equal(await prepare.isEnabled(), true);
  await prepare.click();
  const content = page.getByRole("region", { name: "Contenido del documento", exact: true });
  await content.waitFor({ state: "visible" });
  await page.waitForFunction((expected) => {
    const element = document.querySelector('[role="region"][aria-label="Contenido del documento"]');
    const text = element ? Array.from(element.children).map((block) => block.textContent).join(" ") : "";
    return text.replace(/\s+/g, " ").trim() === expected;
  }, expectedText);
  assert.equal(await content.locator("h2").count(), 1, "Debe conservarse un encabezado.");
  assert.equal(await content.locator("p").count(), 2, "Deben conservarse dos parrafos.");
  const visibleReset = page.getByRole("button", { name: "Reiniciar", exact: true }).filter({ visible: true });
  assert.ok(await visibleReset.count() > 0, "Los controles deben aparecer tras preparar el texto.");
  assert.equal(await visibleReset.first().isEnabled(), true);
  // Do not press play: voice models and OCR are deliberately outside this contract.
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  assert.deepEqual(report.blockedApi.filter((entry) => entry.phase === phase), [], "Preparar texto no debe intentar usar una API.");
  assert.deepEqual(report.pageErrors, [], "Se produjeron errores JavaScript.");
  const offlinePhases = new Set(["offline-reload", "prepare-synthetic-text-offline"]);
  assert.deepEqual(report.responses.filter((entry) => offlinePhases.has(entry.phase)
    && /^https?:/.test(entry.url) && entry.status >= 200 && entry.status < 400 && !entry.serviceWorker), [],
  "Hubo respuestas de red exitosas durante la fase offline.");
  assert.deepEqual(report.failures.filter((entry) => offlinePhases.has(entry.phase) && !entry.serviceWorker
    && ["document", "script", "stylesheet", "font"].includes(entry.type)), [],
  "Fallaron recursos esenciales de la pagina offline.");
  await page.screenshot({ path: join(output, "offline-success.png"), fullPage: true });
  report.passed = true;
  mark("passed");
} catch (error) {
  failure = error;
  report.error = error instanceof Error ? error.stack : String(error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, "offline-failure.png"), fullPage: true }).catch(() => {});
  }
} finally {
  if (tracing) await context.tracing.stop({ path: join(output, "trace.zip") }).catch((error) => {
    report.traceError = String(error);
  });
  await context?.close().catch((error) => { failure ??= error; report.cleanupError = String(error); });
  await browser?.close().catch((error) => { failure ??= error; report.cleanupError = String(error); });
  report.passed = report.passed && !failure;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Evidencia temporal: ${output}`);
}

if (failure) {
  console.error(failure);
  process.exitCode = 1;
} else console.log("PASS: UI y preparacion de texto offline. Voces y OCR no evaluados.");
