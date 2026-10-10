import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Isolated test contexts and generated audio, never a personal browser profile.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supplied = process.argv[2];
const appUrl = supplied ?? "http://127.0.0.1:3018/";
const url = new URL(appUrl);
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
function wav(seconds = 30) {
  const rate = 24000;
  const bytes = Buffer.alloc(44 + rate * seconds * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < rate * seconds; i++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 440) * 1000), 44 + i * 2);
  return bytes;
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

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await context.addInitScript(() => {
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      const events = new EventTarget();
      const voices = [{ name: "Sabina México", lang: "es-MX", voiceURI: "test-mx", default: true, localService: true },
        { name: "Sonia English", lang: "en-GB", voiceURI: "test-en", default: false, localService: true }];
      window.__readerSpeech = { starts: 0, pauses: 0, resumes: 0, last: null };
      const synthesis = {
        speaking: false, paused: false, getVoices: () => voices,
        speak(utterance) { this.speaking = true; this.paused = false; window.__readerSpeech.starts++; window.__readerSpeech.last = utterance; },
        cancel() { this.speaking = false; this.paused = false; },
        pause() { this.paused = true; window.__readerSpeech.pauses++; },
        resume() { this.paused = false; window.__readerSpeech.resumes++; },
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      };
      Object.defineProperty(window, "speechSynthesis", { value: synthesis, configurable: true });
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.__readerAudio = this;
        if (window.__rejectReaderAudio) { window.__rejectReaderAudio = false; return Promise.reject(new Error("Synthetic playback rejection")); }
        return play.call(this);
      };
    });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    const speechRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text()); });
    context.on("request", request => requests.push(request.url()));
    await page.goto(appUrl, { waitUntil: "networkidle" });
    const sameOriginStatus = await page.evaluate(async () => (await fetch("/api/speech", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: "unknown", text: "Prueba pública." }),
    })).status);
    assert.equal(sameOriginStatus, 400, "The real API must accept same-origin browser requests before validating the voice.");
    await context.route("**/api/speech", async route => {
      speechRequests.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: "audio/wav", headers: { "cache-control": "no-store" }, body: wav() });
    });
    await page.getByRole("button", { name: "Pegar texto", exact: true }).click();
    const paragraphs = ["Primero", "Segundo", "Tercero"].map(word => `${word} comenzamos una lectura que conserva palabras y permite navegar con claridad. `.repeat(4));
    await page.getByRole("textbox", { name: "Texto para escuchar" }).fill(paragraphs.join("\n\n"));
    await page.getByRole("button", { name: "Preparar texto", exact: true }).click();
    await page.getByRole("region", { name: "Contenido del documento" }).waitFor();
    assert.match(await page.getByRole("button", { name: /^Voz:/ }).innerText(), /Dispositivo/);
    await page.getByRole("button", { name: "Reproducir", exact: true }).click();
    await page.waitForFunction(() => window.__readerSpeech.starts === 1);
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    await page.getByRole("button", { name: "Reproducir", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__readerSpeech.resumes), 1);

    await page.getByRole("button", { name: /^Voz:/ }).click();
    await page.getByRole("menuitemradio", { name: /^México/ }).click();
    await page.waitForFunction(() => window.__readerAudio?.currentTime > 0.1);
    await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"));
    const currentAudio = await page.evaluate(() => { window.__firstReaderAudio = window.__readerAudio; return window.__readerAudio.currentTime; });
    assert.ok(currentAudio > 0);
    const callsBefore = speechRequests.length;
    await page.getByRole("button", { name: "Siguiente línea", exact: true }).click();
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.equal(await page.evaluate(() => window.__readerAudio === window.__firstReaderAudio), true);
    assert.equal(speechRequests.length, callsBefore);
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__readerAudio.paused), true);
    await page.getByRole("button", { name: "Reproducir", exact: true }).click();
    await page.waitForFunction(() => window.__readerAudio && !window.__readerAudio.paused);
    await page.getByRole("combobox", { name: "Velocidad de lectura", exact: true }).selectOption("1.5");
    assert.equal(await page.evaluate(() => window.__readerAudio.playbackRate), 1.5);
    const preparedParagraph = speechRequests.find(request => request.voice === "hf-mexico" && request.text.startsWith("Segundo"));
    assert.ok(preparedParagraph, "The next paragraph should be prepared ahead of playback.");
    await page.getByRole("button", { name: "Siguiente párrafo", exact: true }).click();
    await page.waitForFunction(() => window.__readerAudio !== window.__firstReaderAudio && window.__readerAudio?.currentTime > 0.1);
    assert.equal(speechRequests.filter(request => request.voice === preparedParagraph.voice && request.text === preparedParagraph.text).length, 1);
    assert.equal(await page.locator("dialog[open]").count(), 0);

    // A rejected audio.play must leave speechSynthesis as the active transport.
    await page.evaluate(() => { window.__rejectReaderAudio = true; });
    await page.getByRole("button", { name: /^Voz:/ }).click();
    await page.getByRole("menuitemradio", { name: /^Dora/ }).click();
    await page.waitForFunction(() => document.querySelector("[role=alert]")?.textContent.includes("Dispositivo"));
    assert.match(await page.getByRole("button", { name: /^Voz:/ }).innerText(), /Dispositivo/);
    const resumedBefore = await page.evaluate(() => window.__readerSpeech.resumes);
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    await page.getByRole("button", { name: "Reproducir", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__readerSpeech.resumes), resumedBefore + 1);

    await page.getByRole("button", { name: "Cerrar aviso de audio", exact: true }).click();
    await page.getByRole("button", { name: "Ajustes de lectura", exact: true }).click();
    await page.getByRole("combobox", { name: "Tamaño del texto", exact: true }).selectOption("1.25");
    await page.getByRole("combobox", { name: "Idioma de lectura", exact: true }).selectOption("en");
    await page.getByRole("combobox", { name: "Voz del dispositivo", exact: true }).selectOption("test-en");
    await page.getByRole("checkbox", { name: /Lectura temporal/ }).check();
    const checkpointBefore = await page.evaluate(() => localStorage.getItem("lector-documental-raul:v2"));
    await page.getByRole("button", { name: "Cerrar ajustes", exact: true }).click();
    await page.getByRole("button", { name: "Siguiente párrafo", exact: true }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem("lector-documental-raul:v2")), checkpointBefore);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.screenshot({ path: resolve(root, `output/playwright/reader-${viewport.width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Pantalla completa", exact: true }).click();
    await page.getByRole("button", { name: "Ocultar controles", exact: true }).click();
    await page.getByRole("button", { name: "Mostrar controles", exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Reproducir", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Mostrar controles", exact: true }).click();
    await page.getByRole("button", { name: "Reproducir", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Salir", exact: true }).click();
    await page.getByRole("button", { name: "Ajustes de lectura", exact: true }).click();
    await page.getByRole("button", { name: "Borrar datos del lector", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("lector-documental-raul:v2") ?? "{}").cleared === true);
    assert.equal(await page.evaluate(() => localStorage.getItem("lector-documental-raul:v1")), null);
    assert.deepEqual(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("lector-documental-raul:v2"))).sort()), ["cleared", "revision", "version"]);
    assert.equal(requests.filter(url => /models\/|onnxruntime|piper.*(?:wasm|worker)/i.test(url)).length, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, status: "PASS", mockedSpeechRequests: speechRequests.length,
      checks: "layout, real same-origin API validation, system voice, real WAV playback, prepared line/paragraph seeks, pause/resume, speed, audio.play fallback, focus controls, temporary mode, privacy erase, no model requests, no CSP errors" }));
    await context.close();
    await browser.close();
    browser = undefined;
  }

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

  if (process.env.READER_VERIFY_HF_LIVE === "1") {
    for (const voice of ["hf-mexico", "hf-dora"]) {
      const started = performance.now();
      const response = await fetch(new URL("/api/speech", appUrl), { method: "POST",
        headers: { origin: url.origin, "content-type": "application/json" },
        body: JSON.stringify({ voice, text: "Esta es una prueba breve de lectura en español." }),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      console.log(JSON.stringify({ liveVoice: voice, status: response.status, bytes: bytes.length,
        elapsedMs: Math.round(performance.now() - started), result: response.ok ? bytes.toString("ascii", 0, 4) : bytes.toString("utf8") }));
      assert.equal(response.status, 200); assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
}
