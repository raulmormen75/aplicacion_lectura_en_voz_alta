import assert from "node:assert/strict";
import { test } from "node:test";

// Opt-in: exercises the local model supplied by the project, with an ephemeral browser cache.
// LAURA_APP_URL=http://127.0.0.1:3016 LAURA_BROWSER_CHANNEL=msedge node --test tests/laura-browser.test.mjs
test("Laura in Next: real audio, durable model cache, no Claude and Browser fallback", {
  skip: !process.env.LAURA_APP_URL,
  timeout: 240_000,
}, async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, channel: process.env.LAURA_BROWSER_CHANNEL || undefined });
  const modelUrl = new URL("/models/laura/es_MX-laura-high.onnx", process.env.LAURA_APP_URL).href;
  const source = "Esta es una prueba local de Laura. El texto se transforma en voz dentro de este dispositivo. ".repeat(8);
  const requests = [], logs = [];
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.addInitScript(() => {
      window.__lauraAudio = null;
      window.__lauraBlobs = [];
      window.__lauraTicks = 0;
      window.__lauraMaxGap = 0;
      let lastTick = performance.now();
      setInterval(() => {
        const now = performance.now();
        if (window.__lauraGenerating) {
          window.__lauraTicks++;
          window.__lauraMaxGap = Math.max(window.__lauraMaxGap, now - lastTick);
        }
        lastTick = now;
      }, 25);
      const info = console.info.bind(console);
      console.info = (...args) => {
        if (args[0] === "[Piper TTS] Estado" && args[1]?.stage === "generating") {
          window.__lauraGenerating = true;
          window.__lauraTicks = 0;
          window.__lauraMaxGap = 0;
          lastTick = performance.now();
        }
        info(...args);
      };
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        if (blob.type === "audio/wav") window.__lauraBlobs.push(blob);
        return create(blob);
      };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.__lauraGenerating = false;
        window.__lauraAudio = this;
        return play.call(this);
      };
    });
    const page = await context.newPage();
    let workers = 0;
    page.on("worker", () => { workers++; });
    context.on("request", request => requests.push(request.url()));
    page.on("console", message => {
      if (message.text().includes("Piper TTS") || message.type() === "error") logs.push(message.text());
    });
    page.on("pageerror", error => logs.push(error.message));
    await page.goto(process.env.LAURA_APP_URL);
    await page.getByRole("button", { name: "Pegar texto", exact: true }).click();
    await page.getByRole("textbox", { name: "Texto para escuchar" }).fill(source);
    await page.getByRole("button", { name: "Preparar texto", exact: true }).click();
    await page.getByRole("region", { name: "Contenido del documento" }).waitFor();
    assert.match(await page.getByRole("button", { name: "Cambiar modelo de voz" }).innerText(), /Laura/);

    async function playAndMeasure() {
      await page.getByRole("button", { name: "Reproducir", exact: true }).click();
      try {
        await page.waitForFunction(() => window.__lauraAudio?.currentTime > 0 ||
          document.body.innerText.includes("Laura no pudo iniciar"), { }, { timeout: 120_000 });
      } catch (error) {
        console.error("LAURA_DIAGNOSTICS", JSON.stringify({ logs: logs.filter(line => !line.includes("progress:")), workers,
          requests: requests.filter(url => /models\/laura|cdn.jsdelivr|laura-worker/.test(url)),
          body: await page.locator("body").innerText() }));
        throw error;
      }
      const result = await page.evaluate(async () => {
        const audio = window.__lauraAudio;
        if (!audio) return { error: document.body.innerText };
        const blob = window.__lauraBlobs.at(-1);
        const bytes = await blob.arrayBuffer();
        const pcm = new Int16Array(bytes.slice(44));
        const result = { duration: audio.duration, currentTime: audio.currentTime, error: audio.error?.message,
          bytes: blob.size, sampleRate: new DataView(bytes).getUint32(24, true), signal: pcm.some(value => value !== 0),
          uiTicksDuringGeneration: window.__lauraTicks, maxUiGapMs: window.__lauraMaxGap };
        audio.pause();
        return result;
      });
      assert.equal(result.error, undefined, JSON.stringify({ result, logs }));
      assert(result.duration > 1 && result.currentTime > 0 && result.bytes > 44 && result.signal);
      assert.equal(result.sampleRate, 22050);
      assert(result.uiTicksDuringGeneration > 5, "Main-thread timer must run during inference");
      assert(result.maxUiGapMs < 1000, `UI blocked for ${result.maxUiGapMs} ms`);
      return result;
    }
    const cold = await playAndMeasure();
    assert.equal(workers, 1);
    assert(requests.includes(modelUrl));
    assert(requests.includes(`${modelUrl}.json`));
    const keys = await page.evaluate(async () => (await (await caches.open("reader-piper-laura-v1")).keys()).map(k => k.url));
    assert.deepEqual(keys.sort(), [modelUrl, `${modelUrl}.json`].sort());
    assert(!requests.some(url => /claude/i.test(url)));

    requests.length = 0;
    await context.route("**/models/laura/**", route => route.abort());
    await page.reload();
    await page.getByRole("region", { name: "Contenido del documento" }).waitFor();
    const warm = await playAndMeasure();
    assert(!requests.some(url => url.includes("/models/laura/") || url.startsWith("https://huggingface.co/")), requests.join("\n"));
    assert(!logs.some(message => /Error, usando voz/.test(message)), logs.join("\n"));
    console.log("LAURA_REAL_BROWSER", JSON.stringify({ cold, reloadedWithModelNetworkBlocked: warm }));

    await page.getByRole("button", { name: "Pegar texto", exact: true }).click();
    await page.getByRole("textbox", { name: "Texto para escuchar" }).fill(`Una muestra diferente permite cancelar la generacion sin reutilizar audio anterior. ${source}`);
    await page.getByRole("button", { name: "Preparar texto", exact: true }).click();
    await page.evaluate(() => { window.__lauraGenerating = false; window.__lauraAudio = null; });
    await page.getByRole("button", { name: "Reproducir", exact: true }).click();
    await page.waitForFunction(() => window.__lauraGenerating, {}, { timeout: 30_000 });
    await page.waitForTimeout(100);
    const cancelStart = performance.now();
    await page.getByRole("button", { name: "Cancelar", exact: true }).click({ timeout: 3000 });
    await page.getByText("Preparación de voz cancelada.", { exact: true }).first().waitFor({ timeout: 3000 });
    const cancelMs = performance.now() - cancelStart;
    assert(cancelMs < 3000, `Cancellation blocked for ${cancelMs} ms`);
    assert.equal(await page.evaluate(() => window.__lauraAudio), null);
    console.log("LAURA_UI_CANCEL", JSON.stringify({ cancelMs, inferenceContinuesOffMainThread: true }));

    const unavailable = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
    const fallback = await unavailable.newPage();
    await unavailable.route("**/models/laura/**", route => route.abort());
    await fallback.goto(process.env.LAURA_APP_URL);
    await fallback.getByRole("button", { name: "Pegar texto", exact: true }).click();
    await fallback.getByRole("textbox", { name: "Texto para escuchar" }).fill(source);
    await fallback.getByRole("button", { name: "Preparar texto", exact: true }).click();
    await fallback.getByRole("button", { name: "Reproducir", exact: true }).click();
    await fallback.getByText("Laura no pudo iniciar. Se usó Voz estándar.", { exact: true }).first().waitFor({ timeout: 30_000 });
    console.log("LAURA_BROWSER_FALLBACK", "PASS at 390x844; native voice availability not asserted");
    await unavailable.close();
    await context.close();
  } finally {
    await browser.close();
  }
});
