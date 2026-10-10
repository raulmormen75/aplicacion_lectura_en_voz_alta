import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import * as pdfStructure from "../src/lib/reader/pdf-structure.ts";
import * as ocrStructure from "../src/lib/reader/ocr-structure.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../src/lib/reader/import-file.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

// Execute the complete importer unchanged; only its PDF.js/DOM/worker adapters
// are substituted. No parsing algorithms are copied into the test harness.
function importer(pdfjs, environment = {}) {
  const compiledModule = { exports: {} };
  vm.runInNewContext(compiled, {
    module: compiledModule, exports: compiledModule.exports,
    require(name) {
      if (name === "pdfjs-dist") return pdfjs;
      if (name === "./pdf-structure.ts") return pdfStructure;
      if (name === "./ocr-structure.ts") return ocrStructure;
      throw Error(`Unexpected dependency: ${name}`);
    },
    window: { location: { href: "https://reader.invalid/" } },
    File, Blob, Uint8Array, ArrayBuffer, DataView, TextDecoder, DOMException,
    ReadableStream, DecompressionStream, URL, setTimeout, clearTimeout, queueMicrotask,
    ...environment,
  }, { filename: "import-file.ts" });
  return compiledModule.exports;
}

function textItem(str = "Este documento sintetico tiene suficiente texto para leerlo sin OCR.", y = 720, x = 50, width = 480) {
  return { str, transform: [12, 0, 0, 12, x, y], height: 12, width };
}

function pdfFixture({ pages = 1, items = () => [textItem()], viewport = { width: 612, height: 792 }, hang = false } = {}) {
  const stats = { destroyed: 0, requested: 0, streams: 0, cancelled: 0, cleaned: 0, renders: 0, canvases: [], renderDimensions: [], settings: undefined, extractionOptions: undefined };
  const pdfjs = {
    GlobalWorkerOptions: {},
    getDocument: (settings) => {
      stats.settings = settings;
      return {
      promise: Promise.resolve({
        numPages: pages,
        async getPage(number) {
          stats.requested++;
          return {
            getViewport({ scale }) { return { width: viewport.width * scale, height: viewport.height * scale }; },
            getTextContent() { throw Error("Must extract bounded chunks, not a complete page array."); },
            async getStructTree() { return null; },
            streamTextContent(options) {
              stats.streams++;
              stats.extractionOptions = options;
              return new ReadableStream({
                start(controller) {
                  if (!hang) { controller.enqueue({ items: items(number) }); controller.close(); }
                },
                cancel() { stats.cancelled++; },
              });
            },
            render({ canvas }) {
              stats.renders++; stats.canvases.push(canvas); stats.renderDimensions.push([canvas.width, canvas.height]);
              return { promise: Promise.resolve(), cancel() {} };
            },
            cleanup() { stats.cleaned++; },
          };
        },
      }),
      async destroy() { stats.destroyed++; },
      };
    },
  };
  return { pdfjs, stats };
}

function options(controller = new AbortController()) {
  return { signal: controller.signal, onStatus() {} };
}
const file = () => new File(["%PDF-synthetic"], "sample.pdf", { type: "application/pdf" });

test("PDF.js receives finite image decoding and worker canvas budgets", async () => {
  const fixture = pdfFixture();
  const compiledModule = importer(fixture.pdfjs);
  await compiledModule.importFile(file(), options());
  assert.equal(fixture.stats.settings.maxImageSize, compiledModule.IMPORT_LIMITS.pdfImagePixels);
  assert.equal(fixture.stats.settings.canvasMaxAreaInBytes, compiledModule.IMPORT_LIMITS.pdfCanvasPixels * 4);
  assert.equal(fixture.stats.extractionOptions.includeMarkedContent, true);
  assert.equal(fixture.stats.destroyed, 1);
});

test("PDF page budget is checked before the first page and still destroys its owner", async () => {
  const fixture = pdfFixture({ pages: 201 });
  await assert.rejects(importer(fixture.pdfjs).importFile(file(), options()), /200 p\u00e1ginas/);
  assert.equal(fixture.stats.requested, 0);
  assert.equal(fixture.stats.destroyed, 1);
});

test("PDF per-page fragment budget cancels extraction and releases the page", async () => {
  const fixture = pdfFixture({ items: () => Array.from({ length: 20_001 }, () => ({ str: "" })) });
  await assert.rejects(importer(fixture.pdfjs).importFile(file(), options()), /fragmentos de texto/);
  assert.equal(fixture.stats.cleaned, 1);
  assert.equal(fixture.stats.destroyed, 1);
  assert.equal(fixture.stats.renders, 0);
});

test("PDF cumulative fragment budget stops on the first excess page", async () => {
  const pageItems = [textItem(), ...Array.from({ length: 19_999 }, () => ({ str: "" }))];
  const fixture = pdfFixture({ pages: 7, items: () => pageItems });
  await assert.rejects(importer(fixture.pdfjs).importFile(file(), options()), /l\u00edmite total de.*fragmentos/);
  assert.equal(fixture.stats.requested, 6);
  assert.equal(fixture.stats.cleaned, 6);
  assert.equal(fixture.stats.destroyed, 1);
});

test("PDF cumulative text budget stops without returning a partial document", async () => {
  const fixture = pdfFixture({ pages: 5, items: () => [textItem("a".repeat(90_000))] });
  await assert.rejects(importer(fixture.pdfjs).importFile(file(), options()), /300.000 caracteres/);
  assert.equal(fixture.stats.requested, 4);
  assert.equal(fixture.stats.cleaned, 4);
  assert.equal(fixture.stats.destroyed, 1);
});

test("PDF raw per-page text budget is applied while consuming chunks", async () => {
  const fixture = pdfFixture({ items: () => [textItem("a".repeat(100_001))] });
  await assert.rejects(importer(fixture.pdfjs).importFile(file(), options()), /100.000 caracteres/);
  assert.equal(fixture.stats.renders, 0);
  assert.equal(fixture.stats.cleaned, 1);
  assert.equal(fixture.stats.destroyed, 1);
});

test("non-finite or oversized PDF viewports fail before extraction and canvas allocation", async () => {
  for (const viewport of [{ width: Infinity, height: 792 }, { width: 612, height: 0 }, { width: 14_401, height: 792 }]) {
    const fixture = pdfFixture({ viewport });
    await assert.rejects(importer(fixture.pdfjs).importFile(file(), options()), /dimensiones no compatibles/);
    assert.equal(fixture.stats.streams, 0);
    assert.equal(fixture.stats.renders, 0);
    assert.equal(fixture.stats.cleaned, 1);
    assert.equal(fixture.stats.destroyed, 1);
  }
});

test("PDF cancellation while a stream is pending closes the stream and worker", async () => {
  const fixture = pdfFixture({ hang: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5);
  try {
    await assert.rejects(importer(fixture.pdfjs).importFile(file(), options(controller)), { name: "AbortError" });
    assert.equal(fixture.stats.cancelled, 1);
    assert.equal(fixture.stats.cleaned, 1);
    assert.equal(fixture.stats.destroyed, 1);
  } finally { clearTimeout(timer); }
});

test("PDF operation deadlines release a stalled stream and document", async () => {
  const fixture = pdfFixture({ hang: true });
  const compiledModule = importer(fixture.pdfjs, { setTimeout: (callback) => setTimeout(callback, 5) });
  await assert.rejects(compiledModule.importFile(file(), options()), /tard\u00f3 demasiado/);
  assert.equal(fixture.stats.cancelled, 1);
  assert.equal(fixture.stats.cleaned, 1);
  assert.equal(fixture.stats.destroyed, 1);
});

test("a two-column PDF returns column order with a review flag", async () => {
  const left = ["Primera columna linea uno.", "Primera columna linea dos."];
  const right = ["Segunda columna linea uno.", "Segunda columna linea dos."];
  const fixture = pdfFixture({ items: () => left.flatMap((text, index) => [textItem(text, 720 - index * 24, 50, 165),
    textItem(right[index], 720 - index * 24, 350, 165)]) });
  const result = await importer(fixture.pdfjs).importFile(file(), options());
  assert.equal(result.text, `${left.join(" ")}\n\n${right.join(" ")}`);
  assert.equal(result.needsReview, true);
  assert.equal(result.usedOcr, false);
  assert.equal(fixture.stats.cleaned, 1);
  assert.equal(fixture.stats.destroyed, 1);
});

function ocrEnvironment({ onInitialize } = {}) {
  const stats = { terminated: 0, recognized: 0 };
  class Worker {
    postMessage(message) {
      if (message.assets) {
        if (onInitialize) { onInitialize(); return; }
        queueMicrotask(() => this.onmessage({ data: { ready: true } }));
      } else if (message.image) {
        stats.recognized++;
        queueMicrotask(() => this.onmessage({ data: { text: "Texto reconocido de una pagina escaneada para comprobar el flujo OCR." } }));
      }
    }
    terminate() { stats.terminated++; }
  }
  const document = {
    createElement() {
      return { width: 0, height: 0, getContext: () => ({}), toBlob: (callback) => callback(new Blob(["synthetic-image"])) };
    },
  };
  return { stats, environment: { Worker, document } };
}

test("OCR page budget preserves bounded rendering and terminates its worker", async () => {
  const fixture = pdfFixture({ pages: 21, items: () => [], viewport: { width: 12_000, height: 14_000 } });
  const ocr = ocrEnvironment();
  await assert.rejects(importer(fixture.pdfjs, ocr.environment).importFile(file(), options()), /OCR en m\u00e1s de 20 p\u00e1ginas/);
  assert.equal(fixture.stats.renders, 20);
  assert.equal(ocr.stats.recognized, 20);
  assert.equal(ocr.stats.terminated, 1);
  assert.equal(fixture.stats.cleaned, 21);
  assert.equal(fixture.stats.destroyed, 1);
  assert.ok(fixture.stats.renderDimensions.every(([width, height]) => width <= 4096 && height <= 4096 && width * height <= 8_000_000));
  assert.ok(fixture.stats.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});

test("cancellation during OCR initialization terminates the OCR owner and PDF", async () => {
  const fixture = pdfFixture({ items: () => [] });
  const controller = new AbortController();
  const ocr = ocrEnvironment({ onInitialize: () => queueMicrotask(() => controller.abort()) });
  await assert.rejects(importer(fixture.pdfjs, ocr.environment).importFile(file(), options(controller)), { name: "AbortError" });
  assert.equal(ocr.stats.terminated, 1);
  assert.equal(fixture.stats.cleaned, 1);
  assert.equal(fixture.stats.destroyed, 1);
  assert.ok(fixture.stats.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});
