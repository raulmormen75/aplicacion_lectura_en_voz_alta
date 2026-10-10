import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  taggedPdf, taggedExpectation, digitalPdf, digitalExpectation,
  twoColumnPdf, columnsExpectation, imageOnlyPdf, imageExpectation, structuredDocx,
} from "./fixtures/pdf-documents.mjs";

// These checks run only in a fresh, isolated local test browser. They never read
// a personal profile. PDF.js and its actual worker parse all digital fixtures.
// Only File.arrayBuffer timing and the OCR dependency are controlled below.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supplied = process.argv[2];
const appUrl = supplied ?? "http://127.0.0.1:3019/";
const url = new URL(appUrl);
const uiOnly = process.argv.includes("--ui-only");
if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
  throw new Error("PDF integration checks require the isolated local application.");
}
if (uiOnly && !supplied) throw new Error("UI-only checks require an explicit local development URL.");

let server, browser, activePage, activeErrors, activeFailedRequests;
let serverLog = "";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const uploadName = "Subir archivo";
const documentName = "Contenido del documento";

function testTransport() {
  // Hold only the selected synthetic fixture, not the PDF parser or its output.
  const read = File.prototype.arrayBuffer;
  window.__pdfFileReads = [];
  window.__pdfHeldReads = new Map();
  window.__pdfRelease = name => { window.__pdfHeldReads.get(name)?.(); window.__pdfHeldReads.delete(name); };
  File.prototype.arrayBuffer = async function (...args) {
    const bytes = await read.apply(this, args);
    window.__pdfFileReads.push(this.name);
    if (this.name.startsWith("held-")) await new Promise(resolve => window.__pdfHeldReads.set(this.name, resolve));
    return bytes;
  };
  window.__pdfDialogStatuses = [];
  window.__pdfDialogOpenings = 0;
  let wasOpen = false;
  const observer = new MutationObserver(() => {
    const dialog = document.querySelector(".pdf-import-dialog[open]");
    if (dialog && !wasOpen) window.__pdfDialogOpenings++;
    wasOpen = !!dialog;
    const status = dialog?.querySelector("[role=status]")?.textContent?.trim();
    if (status && status !== window.__pdfDialogStatuses.at(-1)) window.__pdfDialogStatuses.push(status);
  });
  const observe = () => observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  if (document.documentElement) observe(); else document.addEventListener("DOMContentLoaded", observe, { once: true });
}

async function launchBrowser() {
  const executablePath = process.env.READER_CHROMIUM_EXECUTABLE;
  return chromium.launch({ headless: true, ...(executablePath ? {
    executablePath,
    args: JSON.parse(process.env.READER_CHROMIUM_ARGS ?? "[]")
      .filter(arg => !["--disable-web-security", "--allow-running-insecure-content"].includes(arg)),
  } : {}) });
}

async function savedState(page) {
  // Inspect only documents created by this test context, through the public
  // browser storage API, to verify the real automatic-save/import boundary.
  return page.evaluate(async () => {
    const checkpoint = JSON.parse(localStorage.getItem("lector-documental-raul:v2") ?? "null");
    if (!checkpoint?.documentKey) return { checkpoint, document: null };
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("lector-documental-raul");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const doc = await new Promise((resolve, reject) => {
        const request = db.transaction("documents", "readonly").objectStore("documents").get(checkpoint.documentKey);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return { checkpoint, document: doc };
    } finally { db.close(); }
  });
}

async function waitForSaved(page, title, { qualityStatus } = {}) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const saved = await savedState(page);
    if (saved.document?.title === title && (!qualityStatus || saved.document.quality.status === qualityStatus)) return saved;
    if (Date.now() > deadline) throw new Error(`The imported document was not saved: ${title}; ${JSON.stringify(saved)}`);
    await wait(80);
  }
}

async function preparePreviousDocument(page) {
  await page.getByRole("button", { name: "Pegar texto", exact: true }).click();
  await page.getByRole("textbox", { name: "Texto para escuchar" }).fill(
    "# Documento anterior\n\nEste primer parrafo ya estaba disponible antes de importar un nuevo PDF.\n\nEste segundo parrafo mantiene el avance guardado en el dispositivo.");
  await page.getByRole("button", { name: "Preparar texto", exact: true }).click();
  await page.getByRole("region", { name: documentName }).waitFor();
  await page.getByRole("button", { name: "Siguiente párrafo", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("lector-documental-raul:v2") ?? "{}").progress?.currentWord > 0);
  return waitForSaved(page, "Texto pegado");
}

async function selectFile(page, name, buffer, mimeType = "application/pdf") {
  await page.getByRole("button", { name: uploadName, exact: true }).click();
  const input = page.locator('input[type="file"]');
  await input.focus();
  await input.setInputFiles({ name, mimeType, buffer });
}

const pdfDialog = page => page.getByRole("dialog", { name: "Preparando tu PDF", exact: true });

async function inspectModal(page, screenshotName) {
  const dialog = pdfDialog(page);
  await dialog.waitFor({ state: "visible" });
  assert.equal(await dialog.getAttribute("aria-modal"), "true");
  const details = await dialog.evaluate(el => {
    const descriptions = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.textContent ?? "").join(" ");
    const backdrop = getComputedStyle(el, "::backdrop");
    const box = el.getBoundingClientRect();
    let statusParent = el.querySelector("[role=status]");
    let liveSuppressed = false;
    while (statusParent) {
      liveSuppressed ||= statusParent.getAttribute("aria-busy") === "true";
      statusParent = statusParent.parentElement;
    }
    return {
      modal: el.matches(":modal"), descriptions,
      backdropFilter: backdrop.backdropFilter || backdrop.webkitBackdropFilter,
      background: backdrop.backgroundColor,
      focusInside: el.contains(document.activeElement),
      live: el.querySelector("[role=status]")?.getAttribute("aria-live"),
      liveSuppressed,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      viewport: { width: innerWidth, height: innerHeight },
      status: el.querySelector("[role=status]")?.textContent?.trim(),
    };
  });
  assert.equal(details.modal, true, "The native modal must block the background.");
  assert.equal(details.focusInside, true, "Focus must enter the PDF notice.");
  assert.match(details.descriptions, /títulos|subtítulos|párrafos|viñetas/i);
  assert.match(details.descriptions, /fidelidad|diferencias|errores|no.*exact|puede.*variar/i);
  assert.match(details.backdropFilter, /blur\([1-9]/);
  assert.notEqual(details.background, "rgba(0, 0, 0, 0)");
  assert.ok(details.status, "The dialog needs a changing, accessible status.");
  assert.equal(details.live, "polite");
  assert.equal(details.liveSuppressed, false, "A busy ancestor must not suppress the import status announcements.");
  assert.ok(details.box.x >= -1 && details.box.x + details.box.width <= details.viewport.width + 1);
  assert.ok(details.box.y >= -1 && details.box.y + details.box.height <= details.viewport.height + 1);
  assert.ok(Math.abs(details.box.y + details.box.height / 2 - details.viewport.height / 2) <= 3);
  await page.keyboard.press("Tab");
  assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
  await page.keyboard.press("Shift+Tab");
  // Native dialog navigation may visit the browser chrome (activeElement is
  // then BODY), but it must never focus a control in the blocked application.
  assert.equal(await dialog.evaluate(el => el.contains(document.activeElement) || document.activeElement === document.body), true);
  await page.keyboard.press("Tab");
  assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
  // An actual pointer click over a background action must hit the native modal
  // backdrop, rather than change the import panel behind it.
  const backgroundAction = page.locator(".source-navigation button").filter({ hasText: "Pegar texto" });
  const box = await backgroundAction.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.getByRole("textbox", { name: "Texto para escuchar" }).count(), 0);
  await page.getByRole("button", { name: "Cancelar importación", exact: true }).focus();
  if (screenshotName) await page.screenshot({ path: resolve(root, "output/playwright", screenshotName), fullPage: false });
  return details;
}

async function assertFocusRestored(page) {
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && active.type === "file" && !active.disabled
      || active instanceof HTMLButtonElement && !active.disabled && /Subir archivo/.test(active.textContent ?? "");
  });
}

async function assertPreviousSaved(page, previous) {
  const current = await savedState(page);
  assert.equal(current.document?.id, previous.document.id);
  assert.equal(current.document?.cleanText, previous.document.cleanText);
  assert.equal(current.checkpoint?.progress.currentWord, previous.checkpoint.progress.currentWord);
}

function assertStructured(saved, expected, { artifact } = {}) {
  const blocks = saved.document.blocks;
  for (const [kind, text] of [["heading", expected.heading], ["subheading", expected.subheading], ["paragraph", expected.paragraph]]) {
    if (text) assert.ok(blocks.some(block => block.kind === kind && block.text === text), JSON.stringify({ expected: { kind, text }, blocks }));
  }
  for (const text of expected.bullets ?? []) {
    assert.equal(blocks.filter(block => block.kind === "bullet" && block.text === text).length, 1, JSON.stringify(blocks));
  }
  if (expected.finalParagraph) assert.ok(saved.document.cleanText.includes(expected.finalParagraph), JSON.stringify(blocks));
  if (artifact) assert.ok(!saved.document.cleanText.includes(artifact), "Tagged artifacts must not become document content.");
  assert.equal(blocks.map(block => block.text).join("\n\n"), saved.document.cleanText);
  assert.equal(blocks.reduce((sum, block) => sum + block.wordCount, 0), saved.document.wordCount);
}

async function importAndSave(page, name, bytes, mimeType = "application/pdf") {
  const before = await page.evaluate(() => window.__pdfDialogOpenings);
  await selectFile(page, name, bytes, mimeType);
  const saved = await waitForSaved(page, name);
  await page.locator(".pdf-import-dialog[open]").waitFor({ state: "hidden" });
  if (mimeType === "application/pdf" || name.endsWith(".pdf") || bytes.subarray(0, 5).toString() === "%PDF-") {
    assert.ok(await page.evaluate(count => window.__pdfDialogOpenings > count, before), "A PDF must announce structural adaptation before completion.");
  }
  return saved;
}

// Real PDF.js rasterization feeds the app's real OCR owner worker. The OCR
// library alone is replaced with deterministic, documented layout output so CI
// tests block transport without downloading WASM/models or claiming OCR quality.
function syntheticOcrScript() {
  const ocrLine = (text, y, height = 18) => ({ text, confidence: 98, bbox: { x0: 48, y0: y, x1: 800, y1: y + height },
    words: text.split(/\s+/).map(word => ({ text: word, confidence: 98, font_size: height, bbox: { x0: 48, y0: y, x1: 100, y1: y + height } })) });
  const paragraphs = [
    { text: imageExpectation.heading, lines: [ocrLine(imageExpectation.heading, 48, 36)] },
    { text: imageExpectation.paragraph, lines: [ocrLine("Este texto pertenece a una imagen.", 112), ocrLine("Conserva su contenido completo.", 136)] },
    ...imageExpectation.bullets.map((text, index) => ({ text: `- ${text}`, lines: [ocrLine(`- ${text}`, 198 + index * 30)] })),
  ].map(paragraph => ({ ...paragraph, bbox: { x0: 48, y0: paragraph.lines[0].bbox.y0, x1: 800, y1: paragraph.lines.at(-1).bbox.y1 } }));
  const result = { text: paragraphs.map(paragraph => paragraph.text).join("\n\n"), confidence: 98,
    blocks: [{ text: paragraphs.map(paragraph => paragraph.text).join("\n\n"), bbox: { x0: 48, y0: 48, x1: 800, y1: 246 }, paragraphs }] };
  return `self.Tesseract={PSM:{AUTO:3},async createWorker(languages,oem,options){
    options.logger({status:'loading language traineddata',progress:0.5});
    return {async setParameters(){},async recognize(image,options2,output){
      if(!(image instanceof Blob)||!image.size)throw new Error('Expected a real rendered PDF image');
      options.logger({status:'recognizing text',progress:0.5});
      await new Promise(resolve=>setTimeout(resolve,1800));
      const data=${JSON.stringify(result)};
      if(!output?.blocks)data.blocks=null;
      options.logger({status:'recognizing text',progress:1});
      return {data};
    },async terminate(){}};
  }};`;
}

try {
  if (!supplied) {
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3019", "--hostname", "127.0.0.1"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-12000); });
    const deadline = Date.now() + 30000;
    for (;;) {
      try { if ((await fetch(appUrl)).ok) break; } catch { /* Wait for the compiled local application. */ }
      if (server.exitCode !== null || Date.now() > deadline) throw new Error(`App startup failed: ${serverLog}`);
      await wait(200);
    }
  }
  await mkdir(resolve(root, "output/playwright"), { recursive: true });
  browser = await launchBrowser();
  for (const viewport of [{ width: 914, height: 677 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await context.addInitScript(testTransport);
    const page = await context.newPage();
    activePage = page;
    const errors = [], uploads = [], requests = [], failedRequests = [];
    activeErrors = errors;
    activeFailedRequests = failedRequests;
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text()); });
    context.on("request", request => { requests.push(request.url()); if (request.method() === "POST") uploads.push(request.url()); });
    context.on("requestfailed", request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    await page.goto(appUrl, { waitUntil: "networkidle" });
    const previous = await preparePreviousDocument(page);

    for (const cancelMethod of ["button", "Escape"]) {
      const filename = `held-cancel-${cancelMethod}.pdf`;
      await selectFile(page, filename, taggedPdf());
      await inspectModal(page, cancelMethod === "button" ? `pdf-import-notice-${viewport.width}.png` : null);
      await page.waitForFunction(name => window.__pdfHeldReads.has(name), filename);
      if (cancelMethod === "button") await page.getByRole("button", { name: "Cancelar importación", exact: true }).click();
      else await page.keyboard.press("Escape");
      await page.locator(".pdf-import-dialog[open]").waitFor({ state: "hidden" });
      await assertFocusRestored(page);
      await assertPreviousSaved(page, previous);
      await page.evaluate(name => window.__pdfRelease(name), filename);
      await page.waitForFunction(() => !document.querySelector("input[type=file]")?.disabled);
      await assertPreviousSaved(page, previous);
    }

    const taggedName = "held-tagged-document.pdf";
    await selectFile(page, taggedName, taggedPdf());
    await inspectModal(page);
    await page.waitForFunction(name => window.__pdfHeldReads.has(name), taggedName);
    await page.evaluate(name => window.__pdfRelease(name), taggedName);
    const tagged = await waitForSaved(page, taggedName);
    await page.locator(".pdf-import-dialog[open]").waitFor({ state: "hidden" });
    assertStructured(tagged, taggedExpectation, { artifact: taggedExpectation.artifact });
    await page.locator(".text-block-heading").filter({ hasText: taggedExpectation.heading }).waitFor();
    await page.locator(".text-block-subheading").filter({ hasText: taggedExpectation.subheading }).waitFor();
    assert.equal(await page.locator(".text-block-bullet").count(), 2);
    assert.ok((await page.getByRole("region", { name: documentName }).textContent()).includes(taggedExpectation.finalParagraph), "The closing paragraph must remain in the rendered document, including below the scroll position.");
    await page.screenshot({ path: resolve(root, "output/playwright", `pdf-tagged-document-${viewport.width}.png`), fullPage: true });

    await page.getByRole("button", { name: "Siguiente párrafo", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("lector-documental-raul:v2") ?? "{}").progress?.currentWord > 0);
    const beforeReload = await savedState(page);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("region", { name: documentName }).waitFor();
    const restored = await savedState(page);
    assert.deepEqual(restored.document.blocks, tagged.document.blocks);
    assert.equal(restored.checkpoint.progress.currentWord, beforeReload.checkpoint.progress.currentWord);
    assert.equal(await page.locator(".pdf-import-dialog[open]").count(), 0);

    if (viewport.width === 914) {
      const digital = await importAndSave(page, "digital-document.pdf", digitalPdf());
      assertStructured(digital, digitalExpectation);
      const statuses = await page.evaluate(() => window.__pdfDialogStatuses);
      assert.ok(statuses.some(status => /página\s+1\s+de\s+2/i.test(status)), JSON.stringify(statuses));
      assert.ok(statuses.some(status => /página\s+2\s+de\s+2/i.test(status)), JSON.stringify(statuses));

      const columns = await importAndSave(page, "two-columns.pdf", twoColumnPdf());
      const clean = columns.document.cleanText;
      for (const text of [...columnsExpectation.left, ...columnsExpectation.right]) assert.ok(clean.includes(text), clean);
      assert.ok(clean.indexOf(columnsExpectation.left.at(-1)) < clean.indexOf(columnsExpectation.right[0]), "Columns must be read top to bottom, left then right.");
      assert.ok(columns.document.blocks.some(block => block.kind === "heading" && block.text === columnsExpectation.heading));

      // A PDF signature is authoritative even if the selected name/type is TXT.
      const disguised = await importAndSave(page, "pdf-signature.txt", taggedPdf(), "text/plain");
      assertStructured(disguised, taggedExpectation, { artifact: taggedExpectation.artifact });

      for (const [name, bytes, message] of [["empty.pdf", Buffer.alloc(0), /vacío/i], ["malformed.pdf", Buffer.from("%PDF-1.7\nThis synthetic file has no valid PDF objects.\n"), /PDF|dañado|procesar/i]]) {
        const previousError = await savedState(page);
        await selectFile(page, name, bytes);
        await page.getByRole("alert").filter({ hasText: message }).waitFor();
        await page.locator(".pdf-import-dialog[open]").waitFor({ state: "hidden" });
        await assertFocusRestored(page);
        await assertPreviousSaved(page, previousError);
      }

      const beforeOtherImports = await page.evaluate(() => window.__pdfDialogOpenings);
      const docx = await importAndSave(page, "synthetic-document.docx", structuredDocx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      assert.match(docx.document.cleanText, /Documento Word de comprobacion/);
      const txt = await importAndSave(page, "synthetic-text.txt", Buffer.from("Texto publico independiente.\n\nConserva sus palabras al importar."), "text/plain");
      assert.match(txt.document.cleanText, /Conserva sus palabras al importar/);
      await page.getByRole("button", { name: /^Voz:/ }).click();
      await page.getByRole("menu", { name: "Voces", exact: true }).waitFor();
      assert.equal(await page.locator(".pdf-import-dialog[open]").count(), 0);
      assert.equal(await page.evaluate(() => window.__pdfDialogOpenings), beforeOtherImports);
      await page.keyboard.press("Escape");

      await context.route("**/reader-assets/tesseract.min.js", route => route.fulfill({ status: 200, contentType: "application/javascript", body: syntheticOcrScript() }));
      const beforeOcrCancel = await savedState(page);
      await selectFile(page, "cancel-scanned.pdf", imageOnlyPdf());
      await pdfDialog(page).getByRole("status").filter({ hasText: /Reconociendo.*50%/i }).waitFor();
      await page.getByRole("button", { name: "Cancelar importación", exact: true }).click();
      await page.locator(".pdf-import-dialog[open]").waitFor({ state: "hidden" });
      await assertFocusRestored(page);
      await assertPreviousSaved(page, beforeOcrCancel);
      const scanned = await importAndSave(page, "synthetic-scanned.pdf", imageOnlyPdf());
      assertStructured(scanned, imageExpectation);
      assert.equal(scanned.document.quality.status, "needs-review");
      assert.ok((await page.evaluate(() => window.__pdfDialogStatuses)).some(status => /OCR|Reconociendo/i.test(status)));
      assert.ok(!requests.some(request => /tessdata|traineddata|tesseract-core/i.test(request)), "OCR test must remain deterministic and must not download models.");
      await page.getByRole("button", { name: "Limpiar sin inventar", exact: true }).click();
      const cleaned = await waitForSaved(page, scanned.document.title, { qualityStatus: "ready" });
      assert.equal(cleaned.document.cleanText, scanned.document.cleanText, "Cleaning an already reconstructed PDF must preserve its complete text.");
      assert.deepEqual(cleaned.document.blocks.map(block => ({ kind: block.kind, text: block.text })), scanned.document.blocks.map(block => ({ kind: block.kind, text: block.text })), "Cleaning must preserve the recovered headings and list entries.");
      console.log(JSON.stringify({ ocrIntegration: "PASS", evidence: "Real PDF.js image rasterization and real app-owned worker, cancellation during recognition, and block transport; only Tesseract recognition output is synthetic. This does not verify OCR accuracy." }));
    }
    assert.deepEqual(uploads, [], "Local PDF/DOCX/TXT import must not send any document to an API.");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, status: "PASS", checks: "native modal and centered notice, fidelity description, blur and dimming, keyboard focus/background blocking, button and Escape cancellation with previous document/progress intact, real tagged-PDF structure, complete text, automatic save and reload" }));
    await context.close();
    activePage = undefined;
  }
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: resolve(root, "output/playwright/pdf-import-error.png"), fullPage: true }).catch(() => {});
    console.error(JSON.stringify({ pageErrors: activeErrors, failedRequests: activeFailedRequests, statuses: await activePage.evaluate(() => window.__pdfDialogStatuses).catch(() => []), alerts: await activePage.getByRole("alert").allTextContents().catch(() => []), phase: await activePage.locator("body").innerText().catch(() => "") }));
  }
  if (serverLog) console.error(serverLog);
  throw error;
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
}
