import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Isolated test contexts and public text, never a personal browser profile.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supplied = process.argv[2];
const appUrl = supplied ?? "http://127.0.0.1:3018/";
const url = new URL(appUrl);
const uiOnly = process.argv.includes("--ui-only");
if (uiOnly && (!supplied || !["127.0.0.1", "localhost"].includes(url.hostname))) {
  throw new Error("UI-only checks require an explicit local development URL.");
}
if (!["127.0.0.1", "localhost", "aplicacionparaleerenvozalta.vercel.app"].includes(url.hostname)) {
  throw new Error("This test only allows the local app or its named production deployment.");
}
let server;
let serverLog = "";
let browser;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function launchBrowser() {
  const executablePath = process.env.READER_CHROMIUM_EXECUTABLE;
  return chromium.launch({ headless: true, ...(executablePath ? {
    executablePath,
    args: JSON.parse(process.env.READER_CHROMIUM_ARGS ?? "[]")
      .filter(arg => !["--disable-web-security", "--allow-running-insecure-content"].includes(arg)),
  } : {}) });
}

const catalog = [
  { name: "Microsoft Sabina - Spanish (Mexico)", lang: "es-MX", voiceURI: "test-mx", default: false, localService: true },
  { name: "Microsoft Helena - Spanish (Spain)", lang: "es-ES", voiceURI: "test-es", default: false, localService: true },
  { name: "Google español de Estados Unidos", lang: "es-US", voiceURI: "test-us", default: false, localService: false },
  { name: "Microsoft Raul - Spanish (Mexico)", lang: "es-MX", voiceURI: "test-male", default: false, localService: true },
  { name: "Español", lang: "es", voiceURI: "test-bare", default: false, localService: true },
  { name: "Default English", lang: "en-GB", voiceURI: "test-en", default: true, localService: true },
  { name: "Português", lang: "pt-BR", voiceURI: "test-pt", default: false, localService: true },
];
const dalia = { name: "Microsoft Dalia Online (Natural) - Spanish (Mexico)", lang: "es-MX", voiceURI: "test-dalia", default: false, localService: false };
function fakeDeviceSpeech() {
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  const events = new EventTarget();
  window.__readerVoices = [];
  window.__readerSpeech = { starts: 0, pauses: 0, resumes: 0, last: null, catalogs: 0 };
  window.__readerVoiceEvent = () => events.dispatchEvent(new Event("voiceschanged"));
  const synthesis = {
    speaking: false, paused: false,
    getVoices() { window.__readerSpeech.catalogs++; return window.__readerVoices; },
    speak(utterance) { this.speaking = true; this.paused = false; window.__readerSpeech.starts++; window.__readerSpeech.last = utterance; },
    cancel() { this.speaking = false; },
    pause() { this.paused = true; window.__readerSpeech.pauses++; },
    resume() { this.paused = false; window.__readerSpeech.resumes++; },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  };
  Object.defineProperty(window, "speechSynthesis", { value: synthesis, configurable: true });
}
async function prepareText(page) {
  await page.getByRole("button", { name: "Pegar texto", exact: true }).click();
  const paragraphs = ["Primero", "Segundo", "Tercero"].map(word => `${word} comenzamos un documento que conserva palabras y permite navegar con claridad. `.repeat(4));
  await page.getByRole("textbox", { name: "Texto para escuchar" }).fill(paragraphs.join("\n\n"));
  await page.getByRole("button", { name: "Preparar texto", exact: true }).click();
  await page.getByRole("region", { name: "Contenido del documento" }).waitFor();
}

try {
  if (!supplied) {
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3018", "--hostname", "127.0.0.1"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-12000); });
    const deadline = Date.now() + 30000;
    for (;;) {
      try { if ((await fetch(appUrl)).ok) break; } catch { /* Wait for startup. */ }
      if (server.exitCode !== null || Date.now() > deadline) throw new Error(`App startup failed: ${serverLog}`);
      await wait(200);
    }
  }
  await mkdir(resolve(root, "output/playwright"), { recursive: true });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 914, height: 677 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await context.addInitScript(fakeDeviceSpeech);
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text()); });
    context.on("request", request => requests.push(request.url()));
    await page.goto(appUrl, { waitUntil: "networkidle" });
    await prepareText(page);
    assert.equal(await page.locator("#reading-settings").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Ajustes de lectura", exact: true }).count(), 0);
    assert.equal(await page.getByRole("combobox", { name: "Idioma de lectura", exact: true }).count(), 0);
    assert.equal(await page.getByRole("checkbox", { name: /Lectura temporal/ }).count(), 0);
    const voiceButton = page.getByRole("button", { name: /^Voz:/ });
    await voiceButton.click();
    assert.equal(await page.getByRole("menuitemradio").count(), 0);
    assert.match(await page.getByRole("menu", { name: "Voces", exact: true }).innerText(), /Buscando voces en español/);
    // No voiceschanged event: opening the menu retries the actual browser catalog.
    await page.evaluate(voices => { window.__readerVoices = [...voices, { ...voices[0] }]; }, catalog);
    await page.waitForFunction(() => document.querySelectorAll("[role=menuitemradio]").length === 5);
    const names = await page.getByRole("menuitemradio").allTextContents();
    assert.deepEqual(names.slice(0, 2).map(name => name.trim()), ["Raul", "Sabina"]);
    assert.ok(!names.some(name => /English|Português|Hugging|Dispositivo/.test(name)));
    assert.equal(await page.getByRole("menuitemradio", { name: "Sabina", exact: true }).getAttribute("aria-checked"), "true");
    await page.getByRole("menuitemradio").first().focus();
    await page.keyboard.press("End");
    assert.equal(await page.getByRole("menuitem", { name: "Actualizar voces", exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("menu").count(), 0);
    assert.equal(await voiceButton.evaluate(el => el === document.activeElement), true);
    await voiceButton.click();
    await page.evaluate(voice => { window.__readerVoices.push(voice); }, dalia);
    await page.getByRole("menuitem", { name: "Actualizar voces", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Dalia", exact: true }).waitFor();
    await page.getByRole("menuitemradio", { name: "Dalia", exact: true }).click();
    await page.getByRole("button", { name: "Reproducir", exact: true }).click();
    await page.waitForFunction(() => window.__readerSpeech.starts === 1);
    assert.equal(await page.evaluate(() => window.__readerSpeech.last.voice.voiceURI), "test-dalia");
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    await page.getByRole("button", { name: "Reproducir", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__readerSpeech.resumes), 1);
    // A speed change during pause cancels the old utterance; resume uses the new rate.
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    await page.getByRole("combobox", { name: "Velocidad de lectura", exact: true }).selectOption("1.5");
    await page.getByRole("button", { name: "Reproducir", exact: true }).click();
    await page.waitForFunction(() => window.__readerSpeech.last.rate === 1.5);
    await page.evaluate(() => window.__readerSpeech.last.onboundary({ name: "word", charIndex: 90 }));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("lector-documental-raul:v2") ?? "{}").progress?.currentWord > 0);
    const wordBeforeVoice = await page.evaluate(() => JSON.parse(localStorage.getItem("lector-documental-raul:v2")).progress.currentWord);
    await voiceButton.click();
    await page.getByRole("menuitemradio", { name: "Helena", exact: true }).click();
    await page.waitForFunction(() => window.__readerSpeech.last.voice.voiceURI === "test-es");
    await page.waitForFunction(expected => JSON.parse(localStorage.getItem("lector-documental-raul:v2") ?? "{}").preferences?.systemVoiceURI === expected, "test-es");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("lector-documental-raul:v2")).progress.currentWord), wordBeforeVoice);
    await page.getByRole("button", { name: "Siguiente párrafo", exact: true }).click();
    await page.waitForFunction(() => window.__readerSpeech.last.text.startsWith("Segundo"));
    await page.getByRole("button", { name: "Siguiente línea", exact: true }).click();
    assert.equal(await page.locator("dialog[open], .voice-startup-overlay").count(), 0);
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    const textSize = page.getByRole("combobox", { name: "Tamaño del texto", exact: true });
    const previousSize = await page.locator(".book-page-body").first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    await textSize.selectOption("1.25");
    const changedSize = await page.locator(".book-page-body").first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(Math.abs(changedSize / previousSize - 1.25) < 0.02);
    const layout = await page.evaluate(() => {
      const selectors = [".speed-control", ".text-size-control", ".reset-button", ".voice-model-button", ".text-nav"];
      const rects = selectors.map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { selector, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
      const alignment = [".speed-control", ".text-size-control"].map(selector => {
        const label = document.querySelector(selector);
        const a = label.querySelector(".control-label").getBoundingClientRect();
        const b = label.querySelector("select").getBoundingClientRect();
        return { selector, direction: getComputedStyle(label).flexDirection, centerDifference: Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) };
      });
      return { rects, alignment, viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.equal(layout.overflow, false, JSON.stringify(layout));
    for (const rect of layout.rects) assert.ok(rect.x >= -1 && rect.right <= viewport.width + 1, JSON.stringify(layout));
    for (let a = 0; a < layout.rects.length; a++) for (let b = a + 1; b < layout.rects.length; b++) {
      const r = layout.rects[a], t = layout.rects[b];
      const overlap = Math.min(r.right, t.right) - Math.max(r.x, t.x) > 1 && Math.min(r.bottom, t.bottom) - Math.max(r.y, t.y) > 1;
      assert.equal(overlap, false, JSON.stringify({ r, t }));
    }
    for (const item of layout.alignment) if (item.direction === "row") assert.ok(item.centerDifference <= 1, JSON.stringify(item));
    await page.waitForFunction(() => {
      const value = JSON.parse(localStorage.getItem("lector-documental-raul:v2") ?? "{}");
      return value.documentKey && value.progress.currentWord > 0 && value.preferences.textScale === 1.25;
    });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("lector-documental-raul:v2")));
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("region", { name: "Contenido del documento" }).waitFor();
    assert.equal(await textSize.inputValue(), "1.25");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("lector-documental-raul:v2")).progress.currentWord), saved.progress.currentWord);
    await page.evaluate(voices => { window.__readerVoices = voices; window.__readerVoiceEvent(); }, [...catalog, dalia]);
    await page.waitForFunction(() => document.querySelector(".voice-model-button")?.textContent.includes("Helena"));
    await page.screenshot({ path: resolve(root, `output/playwright/reader-${viewport.width}.png`), fullPage: true });
    await voiceButton.click();
    const menuRect = await page.getByRole("menu", { name: "Voces", exact: true }).boundingBox();
    assert.ok(menuRect.x >= 0 && menuRect.x + menuRect.width <= viewport.width + 1);
    await page.screenshot({ path: resolve(root, `output/playwright/voices-${viewport.width}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Pantalla completa", exact: true }).click();
    await page.getByRole("combobox", { name: "Tamaño del texto", exact: true }).selectOption("1.1");
    assert.equal(await page.getByRole("combobox", { name: "Velocidad de lectura", exact: true }).inputValue(), "1.5");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: resolve(root, `output/playwright/focus-${viewport.width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Ocultar controles", exact: true }).click();
    await page.getByRole("button", { name: "Mostrar controles", exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Reproducir", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Mostrar controles", exact: true }).click();
    await page.getByRole("button", { name: "Reproducir", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Salir", exact: true }).click();
    assert.equal(requests.filter(url => /api\/speech|hf\.space|huggingface\.co|models\/|onnxruntime|piper.*(?:wasm|worker)/i.test(url)).length, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, status: "PASS", checks: "Spanish-only device catalog, delayed detection, refresh, keyboard, chosen voice, pause/resume and speed, line/paragraph navigation, aligned controls, text size, automatic persistence and reload, focus controls, no remote TTS or model requests, no CSP errors" }));
    await context.close();
    await browser.close();
    browser = undefined;
  }

  // An English default must never be spoken when no Spanish voice is exposed.
  browser = await launchBrowser();
  const unavailableContext = await browser.newContext({
    viewport: { width: 390, height: 844 }, serviceWorkers: "block",
    userAgent: "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0",
  });
  await unavailableContext.addInitScript(fakeDeviceSpeech);
  const unavailable = await unavailableContext.newPage();
  await unavailable.goto(appUrl, { waitUntil: "networkidle" });
  await unavailable.evaluate(voices => { window.__readerVoices = voices; }, catalog.filter(voice => voice.lang === "en-GB"));
  await prepareText(unavailable);
  await unavailable.getByRole("button", { name: "Reproducir", exact: true }).click();
  await unavailable.getByRole("alert").filter({ hasText: "No se detectaron voces en español" }).waitFor();
  assert.equal(await unavailable.evaluate(() => window.__readerSpeech.starts), 0);
  await unavailable.getByRole("button", { name: /^Voz:/ }).click();
  await unavailable.getByRole("status").filter({ hasText: "No se detectaron voces" }).waitFor();
  await unavailable.getByRole("menuitem", { name: "Ayuda para Android", exact: true }).click();
  const help = unavailable.locator(".voice-menu-help");
  assert.match(await help.innerText(), /Texto a voz/);
  assert.match(await help.innerText(), /Dalia.*sin compartirla con esta página/);
  assert.equal(await unavailable.getByRole("menuitemradio", { name: "Dalia", exact: true }).count(), 0);
  const emptyMenu = await unavailable.getByRole("menu", { name: "Voces", exact: true }).boundingBox();
  assert.ok(emptyMenu.x >= 0 && emptyMenu.x + emptyMenu.width <= 391);
  await unavailable.screenshot({ path: resolve(root, "output/playwright/android-voice-help.png"), fullPage: true });
  await unavailable.keyboard.press("Escape");
  await unavailable.getByRole("button", { name: "Cerrar aviso de audio", exact: true }).click();
  await unavailable.getByRole("button", { name: "Reproducir", exact: true }).click();
  await unavailable.getByRole("button", { name: "Pausar", exact: true }).click();
  await unavailable.evaluate(voices => { window.__readerVoices = voices; window.__readerVoiceEvent(); }, catalog);
  await unavailable.waitForTimeout(1100);
  assert.equal(await unavailable.evaluate(() => window.__readerSpeech.starts), 0);
  console.log(JSON.stringify({ unavailableSpanish: "PASS", checks: "no English fallback; cancelling a pending catalog lookup prevents stale playback" }));
  await unavailableContext.close();

  // Android-style delayed initialization, without a voiceschanged event. The
  // old 900 ms playback / 1500 ms menu lookups miss both of these catalogs.
  const delayedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await delayedContext.addInitScript(fakeDeviceSpeech);
  const delayed = await delayedContext.newPage();
  await delayed.goto(appUrl, { waitUntil: "networkidle" });
  await prepareText(delayed);
  await delayed.evaluate(voice => {
    window.__readerVoices = [{ name: "Microsoft Helena", lang: "es-ES", voiceURI: "test-es", default: false, localService: true }];
    window.setTimeout(() => { window.__readerVoices.push(voice); }, 2000);
  }, dalia);
  await delayed.getByRole("button", { name: /^Voz:/ }).click();
  await delayed.getByRole("menuitemradio", { name: "Dalia", exact: true }).waitFor();
  assert.equal(await delayed.evaluate(() => window.__readerSpeech.starts), 0, "Catalog discovery must never synthesize silent/test audio.");
  await delayed.keyboard.press("Escape");
  await delayed.evaluate(voice => {
    window.__readerVoices = [];
    window.setTimeout(() => { window.__readerVoices = [voice]; }, 1700);
  }, dalia);
  await delayed.getByRole("button", { name: "Reproducir", exact: true }).click();
  await delayed.getByRole("button", { name: /^Voz:/ }).click();
  await delayed.getByRole("menuitem", { name: "Actualizar voces", exact: true }).click();
  await delayed.waitForFunction(() => window.__readerSpeech.starts === 1);
  assert.equal(await delayed.evaluate(() => window.__readerSpeech.last.voice.voiceURI), "test-dalia");
  // Next's route announcer also has role=alert, even when it is empty.
  assert.equal(await delayed.locator(".playback-notice[role=alert]").count(), 0);
  assert.equal(await delayed.locator(".voice-startup-overlay, dialog[open]").count(), 0);
  await delayed.keyboard.press("Escape");
  await delayed.getByRole("button", { name: "Pausar", exact: true }).click();
  // A new attempt that is cancelled must not speak/error after its late catalog.
  await delayed.getByRole("button", { name: "Reiniciar", exact: true }).click();
  await delayed.evaluate(voice => {
    window.__readerVoices = [];
    window.setTimeout(() => { window.__readerVoices = [voice]; }, 1700);
  }, dalia);
  const startsBeforeCancel = await delayed.evaluate(() => window.__readerSpeech.starts);
  await delayed.getByRole("button", { name: "Reproducir", exact: true }).click();
  await delayed.getByRole("button", { name: "Pausar", exact: true }).click();
  await delayed.waitForTimeout(2000);
  assert.equal(await delayed.evaluate(() => window.__readerSpeech.starts), startsBeforeCancel);
  assert.equal(await delayed.locator(".playback-notice[role=alert]").count(), 0);
  console.log(JSON.stringify({ delayedVoiceCatalog: "PASS", checks: "menu after 2s and playback after 1.7s without events, refresh independent of pending play, no probe audio, cancel prevents stale speech/error, Android help never fabricates Dalia" }));
  await delayedContext.close();
  await browser.close();
  browser = undefined;

  if (!uiOnly) {
  // Verify the actual production precache, rather than relying on HTTP cache.
  browser = await launchBrowser();
  const offlineContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  const offlinePage = await offlineContext.newPage();
  const offlineErrors = [];
  const offlinePosts = [];
  offlinePage.on("pageerror", error => offlineErrors.push(error.message));
  await offlineContext.route("**/api/**", async route => {
    if (route.request().method() === "POST") offlinePosts.push(route.request().url());
    await route.abort();
  });
  await offlinePage.goto(appUrl, { waitUntil: "load" });
  await offlinePage.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated", null, { timeout: 45000 });
  await offlineContext.setOffline(true);
  const offlineResponse = await offlinePage.reload({ waitUntil: "load" });
  assert.equal(offlineResponse?.status(), 200);
  assert.equal(offlineResponse.fromServiceWorker(), true);
  await offlinePage.getByRole("button", { name: "Pegar texto", exact: true }).click();
  await offlinePage.getByRole("textbox", { name: "Texto para escuchar" }).fill("# Lectura sin conexión\n\nEste texto público mantiene estructura y puntuación.\n\nPodemos leer sin descargar modelos.");
  await offlinePage.getByRole("button", { name: "Preparar texto", exact: true }).click();
  const offlineDocument = offlinePage.getByRole("region", { name: "Contenido del documento" });
  await offlineDocument.waitFor();
  assert.match(await offlineDocument.innerText(), /Lectura sin conexión/);
  assert.match(await offlineDocument.innerText(), /Podemos leer sin descargar modelos\./);
  assert.equal(await offlinePage.locator(".app-brand img").evaluate(img => img.complete && img.naturalWidth > 0), true);
  assert.equal(await offlinePage.evaluate(() => navigator.onLine), false);
  assert.deepEqual(offlinePosts, []);
  assert.deepEqual(offlineErrors, []);
  console.log(JSON.stringify({ offline: "PASS", checks: "production service worker, offline reload, local text preparation, icon and punctuation, no API POST" }));
  await offlineContext.close();
  await browser.close();
  browser = undefined;

  }
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
}
