import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { Worker as OcrWorker } from "tesseract.js";

export type ImportFileOptions = {
  signal: AbortSignal;
  onStatus: (message: string) => void;
};

export type ImportFileResult = { text: string; needsReview: boolean; usedOcr: boolean };

export const IMPORT_LIMITS = Object.freeze({
  fileBytes: 25 * 1024 * 1024,
  textChars: 300_000,
  pdfPages: 200,
  pdfPageChars: 100_000,
  pdfPageItems: 20_000,
  pdfTotalItems: 100_000,
  pdfOcrPages: 20,
  pdfOperationMs: 30_000,
  pdfMaxDimension: 14_400,
  pdfImagePixels: 32_000_000,
  pdfCanvasPixels: 8_000_000,
  pdfCanvasSide: 4096,
  docxEntries: 512,
  docxExpandedBytes: 32 * 1024 * 1024,
  docxEntryBytes: 8 * 1024 * 1024,
  docxXmlBytes: 4 * 1024 * 1024,
});
const ASSETS = "/reader-assets/";

class ImportLimitError extends Error {}

function limit(message: string): never {
  throw new ImportLimitError(`${message} Divide el documento en archivos m\u00e1s peque\u00f1os e intenta de nuevo.`);
}

function checkTextSize(length: number, maximum: number = IMPORT_LIMITS.textChars) {
  if (length > maximum) limit(`El texto supera el l\u00edmite de ${maximum.toLocaleString("es-MX")} caracteres.`);
}

function abortError() {
  return new DOMException("Importaci\u00f3n cancelada.", "AbortError");
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function pdfOperation<T>(promise: Promise<T>, signal: AbortSignal, maximumMs: number = IMPORT_LIMITS.pdfOperationMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await abortable(Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ImportLimitError("El PDF tard\u00f3 demasiado en procesarse. Usa una copia m\u00e1s sencilla o divide sus p\u00e1ginas.")), maximumMs);
    })]), signal);
  } finally {
    clearTimeout(timer);
  }
}

// Read the ZIP directory before Mammoth, then count actual expanded bytes without
// retaining them. Declared sizes alone do not bound a corrupt archive's expansion.
export async function validateDocxArchive(bytes: ArrayBuffer, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  const view = new DataView(bytes);
  const invalid = () => new Error("El DOCX tiene una estructura ZIP no compatible o da\u00f1ada. Guarda una copia nueva como DOCX.");
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw invalid();
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
    || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)
    || view.getUint16(end + 8, true) !== count || directoryOffset + directorySize !== end) throw invalid();
  if (count > IMPORT_LIMITS.docxEntries) limit(`El DOCX contiene m\u00e1s de ${IMPORT_LIMITS.docxEntries} archivos internos.`);
  const entries: { name: string; compressed: number; expanded: number; start: number; method: number }[] = [];
  const names = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cursor = directoryOffset;
  let declaredTotal = 0;
  for (let index = 0; index < count; index++) {
    checkAbort(signal);
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw invalid();
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const expanded = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const recordLength = 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    if (flags & 1 || (method !== 0 && method !== 8) || view.getUint16(cursor + 34, true)
      || compressed === 0xffffffff || expanded === 0xffffffff || local === 0xffffffff
      || cursor + recordLength > end || local + 30 > directoryOffset
      || view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 8, true) !== method
      || view.getUint16(local + 6, true) !== flags) throw invalid();
    const name = decoder.decode(new Uint8Array(bytes, cursor + 46, nameLength));
    if (!name || /\\|(^|\/)\.\.?($|\/)/.test(name) || names.has(name)) throw invalid();
    names.add(name);
    const localNameLength = view.getUint16(local + 26, true);
    if (local + 30 + localNameLength > directoryOffset
      || decoder.decode(new Uint8Array(bytes, local + 30, localNameLength)) !== name) throw invalid();
    const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
    if (start + compressed > directoryOffset || (method === 0 && compressed !== expanded)) throw invalid();
    const xml = /\.(?:xml|rels)$/i.test(name);
    if (expanded > (xml ? IMPORT_LIMITS.docxXmlBytes : IMPORT_LIMITS.docxEntryBytes)) {
      limit(`Un archivo interno del DOCX supera el l\u00edmite de ${xml ? 4 : 8} MB descomprimidos.`);
    }
    declaredTotal += expanded;
    if (declaredTotal > IMPORT_LIMITS.docxExpandedBytes) limit("El DOCX supera el l\u00edmite de 32 MB descomprimidos.");
    entries.push({ name, compressed, expanded, start, method });
    cursor += recordLength;
  }
  if (cursor !== end || !names.has("word/document.xml") || !names.has("[Content_Types].xml")) throw invalid();
  let total = 0;
  for (const entry of entries) {
    checkAbort(signal);
    if (entry.method === 0 || !entry.compressed) {
      if (entry.compressed !== entry.expanded) throw invalid();
      total += entry.expanded;
      continue;
    }
    let decompressor: DecompressionStream;
    try { decompressor = new DecompressionStream("deflate-raw"); } catch {
      throw new Error("Este navegador no puede comprobar la descompresi\u00f3n del DOCX. Actual\u00edzalo o exporta el documento como TXT UTF-8.");
    }
    // Small compressed input chunks bound expansion before the consumer can
    // inspect output, including a dishonest directory with a tiny declared size.
    let position = entry.start;
    const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        if (position >= entry.start + entry.compressed) { controller.close(); return; }
        const length = Math.min(1024, entry.start + entry.compressed - position);
        controller.enqueue(new Uint8Array(bytes, position, length));
        position += length;
      },
    }, { highWaterMark: 0 });
    const reader = compressed.pipeThrough(decompressor).getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    let expanded = 0;
    try {
      while (true) {
        checkAbort(signal);
        const chunk = await abortable(reader.read(), signal);
        checkAbort(signal);
        if (chunk.done) break;
        expanded += chunk.value.byteLength;
        total += chunk.value.byteLength;
        if (expanded > entry.expanded || total > IMPORT_LIMITS.docxExpandedBytes) {
          limit("La descompresi\u00f3n real del DOCX supera su tama\u00f1o permitido.");
        }
      }
      if (expanded !== entry.expanded) throw invalid();
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** Browser-only import. No document bytes are sent to a server. */
export async function importFile(file: File, options: ImportFileOptions): Promise<ImportFileResult> {
  const { signal, onStatus } = options;
  checkAbort(signal);
  if (!file.size) throw new Error("El archivo est\u00e1 vac\u00edo.");
  if (file.size > IMPORT_LIMITS.fileBytes) throw new Error("El archivo supera el l\u00edmite de 25 MB.");
  const name = file.name.toLowerCase();
  if (name.endsWith(".doc") || (file.type === "application/msword" && !name.endsWith(".docx"))) {
    throw new Error("El formato Word .doc es antiguo y no es compatible. Gu\u00e1rdalo como DOCX y vuelve a seleccionarlo.");
  }
  if (typeof window === "undefined") throw new Error("Importa el archivo desde el navegador.");
  onStatus("Abriendo archivo local...");
  const bytes = await abortable(file.arrayBuffer(), signal);
  checkAbort(signal);
  const signature = new TextDecoder("latin1").decode(bytes.slice(0, 5));
  let result: ImportFileResult;
  if (signature === "%PDF-" || name.endsWith(".pdf") || file.type === "application/pdf") {
    result = await importPdf(bytes, options);
  } else if (name.endsWith(".docx") || file.type.includes("wordprocessingml")) {
    try {
      onStatus("Comprobando tama\u00f1o y descompresi\u00f3n del DOCX...");
      await validateDocxArchive(bytes, signal);
      checkAbort(signal);
      onStatus("Extrayendo encabezados y p\u00e1rrafos del DOCX...");
      // The package's browser mapping selects browser/unzip.js; retain its official typings.
      const mammoth = await abortable(import("mammoth"), signal);
      checkAbort(signal);
      const converted = await abortable(mammoth.convertToHtml({ arrayBuffer: bytes }, {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      }), signal);
      checkAbort(signal);
      if (converted.value.length > IMPORT_LIMITS.docxXmlBytes) limit("El contenido generado del DOCX supera el l\u00edmite de 4 MB.");
      const dom = new DOMParser().parseFromString(converted.value, "text/html");
      result = {
        text: structuredHtmlText(dom.body),
        needsReview: converted.messages.length > 0 || !!dom.querySelector("img,table"),
        usedOcr: false,
      };
    } catch (error) {
      checkAbort(signal);
      if (error instanceof ImportLimitError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo abrir el DOCX. Comprueba que no est\u00e9 da\u00f1ado, cifrado o sea un .doc renombrado. ${detail}`, { cause: error });
    }
  } else if (name.endsWith(".txt") || name.endsWith(".md") || file.type === "text/plain") {
    onStatus("Decodificando texto UTF-8...");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      checkTextSize(text.length);
      result = { text, needsReview: false, usedOcr: false };
    } catch (error) {
      if (error instanceof ImportLimitError) throw error;
      throw new Error("El texto no est\u00e1 codificado en UTF-8. Gu\u00e1rdalo como UTF-8 e intenta de nuevo.");
    }
  } else {
    throw new Error("Formato no compatible. Selecciona PDF, DOCX o TXT UTF-8.");
  }
  checkAbort(signal);
  checkTextSize(result.text.length);
  result.text = result.text.replace(/\r\n?/g, "\n").trim();
  if (!result.text) throw new Error("No se encontr\u00f3 texto legible en el archivo, incluso tras OCR si fue necesario.");
  result.needsReview ||= poorText(result.text);
  onStatus(result.needsReview ? "Archivo importado. Revisa el texto extra\u00eddo." : "Archivo importado.");
  checkAbort(signal);
  return result;
}

function poorText(text: string) {
  const compact = text.replace(/\s/g, "");
  return compact.length > 0 && ((compact.match(/[\uFFFD\u0000-\u0008]/g)?.length ?? 0) / compact.length > 0.02
    || (compact.match(/[\p{L}\p{N}]/gu)?.length ?? 0) / compact.length < 0.5);
}

function needsPageOcr(text: string) {
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 40 || poorText(text);
}

async function readPdfItems(page: PDFPageProxy, signal: AbortSignal, remainingItems: number): Promise<unknown[]> {
  const reader = page.streamTextContent().getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const items: unknown[] = [];
  let chars = 0;
  const deadline = Date.now() + IMPORT_LIMITS.pdfOperationMs;
  try {
    while (true) {
      checkAbort(signal);
      if (Date.now() > deadline) limit("La extracci\u00f3n de esta p\u00e1gina PDF tard\u00f3 demasiado.");
      const chunk = await pdfOperation(reader.read(), signal, Math.max(1, deadline - Date.now()));
      checkAbort(signal);
      if (chunk.done) break;
      if (items.length + chunk.value.items.length > IMPORT_LIMITS.pdfPageItems) limit(`Una p\u00e1gina PDF supera el l\u00edmite de ${IMPORT_LIMITS.pdfPageItems.toLocaleString("es-MX")} fragmentos de texto.`);
      if (items.length + chunk.value.items.length > remainingItems) limit(`El PDF supera el l\u00edmite total de ${IMPORT_LIMITS.pdfTotalItems.toLocaleString("es-MX")} fragmentos de texto.`);
      for (const item of chunk.value.items) {
        if ("str" in item) chars += item.str.length;
        checkTextSize(chars, IMPORT_LIMITS.pdfPageChars);
        items.push(item);
      }
    }
    return items;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function importPdf(bytes: ArrayBuffer, { signal, onStatus }: ImportFileOptions): Promise<ImportFileResult> {
  let loadingTask: PDFDocumentLoadingTask | undefined;
  let pdf: PDFDocumentProxy | undefined;
  let renderTask: RenderTask | undefined;
  let ocr: ReturnType<typeof createOcrHost> | undefined;
  let destruction: Promise<void> | undefined;
  const dispose = () => {
    renderTask?.cancel();
    ocr?.terminate();
    // The loading task owns the document/worker; PDF.js 6 removed proxy.destroy.
    destruction ??= loadingTask?.destroy().catch(() => {});
  };
  signal.addEventListener("abort", dispose, { once: true });
  let currentPage = 0;
  let usedOcr = false;
  let needsReview = false;
  let totalItems = 0;
  let totalChars = 0;
  let ocrPages = 0;
  try {
    const pdfjs = await abortable(import("pdfjs-dist"), signal);
    checkAbort(signal);
    pdfjs.GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.min.mjs`;
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      maxImageSize: IMPORT_LIMITS.pdfImagePixels,
      canvasMaxAreaInBytes: IMPORT_LIMITS.pdfCanvasPixels * 4,
    });
    // Never leave an unresolved password prompt holding the worker alive.
    loadingTask.onPassword = () => { throw new Error("El PDF requiere contrase\u00f1a. Importa una copia sin protecci\u00f3n."); };
    pdf = await pdfOperation(loadingTask.promise, signal);
    checkAbort(signal);
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1) throw new Error("El PDF no contiene p\u00e1ginas v\u00e1lidas.");
    if (pdf.numPages > IMPORT_LIMITS.pdfPages) limit(`El PDF supera el l\u00edmite de ${IMPORT_LIMITS.pdfPages} p\u00e1ginas.`);
    const pages: string[] = [];
    for (currentPage = 1; currentPage <= pdf.numPages; currentPage++) {
      checkAbort(signal);
      onStatus(`PDF: p\u00e1gina ${currentPage} de ${pdf.numPages}. Extrayendo texto...`);
      const page = await pdfOperation(pdf.getPage(currentPage), signal);
      let canvas: HTMLCanvasElement | undefined;
      try {
        const base = page.getViewport({ scale: 1 });
        if (![base.width, base.height].every((size) => Number.isFinite(size) && size > 0 && size <= IMPORT_LIMITS.pdfMaxDimension)) {
          limit("Una p\u00e1gina PDF tiene dimensiones no compatibles (m\u00e1ximo 14.400 puntos por lado).");
        }
        const items = await readPdfItems(page, signal, IMPORT_LIMITS.pdfTotalItems - totalItems);
        totalItems += items.length;
        const extracted = extractPdfPage(items);
        let text = extracted.text;
        needsReview ||= extracted.needsReview;
        if (needsPageOcr(text)) {
          if (++ocrPages > IMPORT_LIMITS.pdfOcrPages) limit(`El PDF necesita OCR en m\u00e1s de ${IMPORT_LIMITS.pdfOcrPages} p\u00e1ginas.`);
          checkAbort(signal);
          onStatus(`OCR: p\u00e1gina ${currentPage} de ${pdf.numPages}. Preparando imagen...`);
          checkAbort(signal);
          // Bound canvas memory, especially on mobile and unusually large PDF pages.
          const scale = Math.min(2.5, IMPORT_LIMITS.pdfCanvasSide / Math.max(base.width, base.height),
            Math.sqrt(IMPORT_LIMITS.pdfCanvasPixels / (base.width * base.height)));
          const viewport = page.getViewport({ scale });
          canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("No se pudo preparar la imagen para OCR.");
          renderTask = page.render({ canvas, canvasContext: context, viewport, background: "white" });
          await pdfOperation(renderTask.promise, signal);
          renderTask = undefined;
          checkAbort(signal);
          ocr ??= createOcrHost(signal, (progress) => {
            onStatus(`OCR: p\u00e1gina ${currentPage} de ${pdf!.numPages}. ${progress}`);
          });
          const image = await abortable(new Promise<Blob>((resolve, reject) => {
            canvas!.toBlob((blob) => blob ? resolve(blob) : reject(new Error("No se pudo convertir la p\u00e1gina para OCR.")), "image/png");
          }), signal);
          const recognized = await ocr.recognize(image);
          checkTextSize(recognized.length, IMPORT_LIMITS.pdfPageChars);
          usedOcr = true;
          needsReview = true;
          // Keep a short valid digital title if OCR finds nothing on that page.
          if (recognized.trim()) text = recognized.trim();
        }
        text = text.trim();
        checkTextSize(text.length, IMPORT_LIMITS.pdfPageChars);
        if (text) {
          totalChars += text.length + (pages.length ? 2 : 0);
          checkTextSize(totalChars);
          pages.push(text);
        }
      } finally {
        if (renderTask) {
          renderTask.cancel();
          await renderTask.promise.catch(() => {});
          renderTask = undefined;
        }
        if (canvas) canvas.width = canvas.height = 0;
        page.cleanup();
      }
    }
    return { text: pages.join("\n\n"), needsReview, usedOcr };
  } catch (error) {
    checkAbort(signal);
    if (error instanceof ImportLimitError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo procesar el PDF${currentPage ? ` en la p\u00e1gina ${currentPage}` : ""}. Comprueba que no est\u00e9 da\u00f1ado o protegido con contrase\u00f1a. Verifica los recursos de reader-assets y la conexi\u00f3n para OCR. ${detail}`, { cause: error });
  } finally {
    signal.removeEventListener("abort", dispose);
    dispose();
    await destruction;
  }
}

// A dedicated owner makes even Tesseract's asynchronous initialization cancellable.
// Terminating it also terminates its descendant worker, including model downloads.
function ocrHostMain() {
  const scope = globalThis as unknown as {
    importScripts: (...urls: string[]) => void;
    Tesseract: typeof import("tesseract.js");
    postMessage: (value: unknown) => void;
    onmessage: (event: MessageEvent<{ assets?: string; image?: Blob }>) => void;
  };
  let worker: OcrWorker | undefined;
  const fail = (error: unknown) => scope.postMessage({ error: String(error) });
  scope.onmessage = async ({ data }) => {
    try {
      if (data.assets) {
        scope.importScripts(`${data.assets}tesseract.min.js`);
        worker = await scope.Tesseract.createWorker("spa+eng", 1, {
          workerPath: `${data.assets}tesseract.worker.min.js`,
          workerBlobURL: false,
          errorHandler: fail,
          logger: ({ status, progress }) => scope.postMessage({ status, progress }),
        });
        await worker.setParameters({ tessedit_pageseg_mode: scope.Tesseract.PSM.AUTO });
        scope.postMessage({ ready: true });
      } else if (data.image && worker) {
        const result = await worker.recognize(data.image);
        scope.postMessage({ text: result.data.text });
      }
    } catch (error) { fail(error); }
  };
}

function createOcrHost(signal: AbortSignal, onStatus: (message: string) => void) {
  checkAbort(signal);
  const url = URL.createObjectURL(new Blob([`(${ocrHostMain.toString()})()`], { type: "text/javascript" }));
  let host: Worker;
  try { host = new Worker(url); } finally { URL.revokeObjectURL(url); }
  let stopped = false;
  let settle: { resolve: (text: string) => void; reject: (error: Error) => void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (stopped) return;
    stopped = true;
    host.terminate();
    clearTimeout(timer);
    signal.removeEventListener("abort", terminate);
    settle?.reject(abortError());
    settle = undefined;
  };
  const wait = () => new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
    timer = setTimeout(() => {
      settle?.reject(new Error("OCR excedi\u00f3 el tiempo de espera. Revisa tu conexi\u00f3n o usa un PDF m\u00e1s sencillo."));
      terminate();
    }, 180_000);
  });
  host.onmessage = ({ data }: MessageEvent<{ error?: string; ready?: boolean; text?: string; status?: string; progress?: number }>) => {
    if (stopped || signal.aborted) return;
    if (data.status) {
      onStatus(data.status === "recognizing text"
        ? `Reconociendo texto: ${Math.round((data.progress ?? 0) * 100)}%.`
        : "Preparando motor e idiomas (requiere conexi\u00f3n la primera vez)...");
    } else {
      clearTimeout(timer);
      if (data.error) settle?.reject(new Error(`OCR no disponible: ${data.error}`));
      else settle?.resolve(data.text ?? "");
      settle = undefined;
    }
  };
  host.onerror = (event) => {
    event.preventDefault();
    settle?.reject(new Error("No se pudo iniciar OCR. Ejecuta prepare-reader-assets y verifica la conexi\u00f3n y los permisos de workers."));
    terminate();
  };
  signal.addEventListener("abort", terminate, { once: true });
  const ready = wait();
  host.postMessage({ assets: new URL(ASSETS, window.location.href).href });
  // Observe readiness immediately, including cancellation before recognize is called.
  void ready.catch(() => {});
  return {
    terminate,
    async recognize(image: Blob) {
      await abortable(ready, signal);
      checkAbort(signal);
      if (stopped) throw new Error("El motor OCR se detuvo.");
      const result = wait();
      host.postMessage({ image });
      return abortable(result, signal);
    },
  };
}

type PdfItem = { str: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean };
type PdfPart = { x: number; y: number; width: number; height: number; text: string };
type PdfLine = { y: number; height: number; parts: PdfPart[] };
type PdfReadingLine = { y: number; x: number; end: number; height: number; text: string; bullet: boolean; contentX: number };

function weightedHeight(values: { height: number; text: string }[]) {
  let remaining = values.reduce((sum, value) => sum + value.text.length, 0) / 2;
  for (const value of [...values].sort((a, b) => a.height - b.height)) {
    remaining -= value.text.length;
    if (remaining <= 0) return value.height;
  }
  return 12;
}

function readingLine(line: PdfLine): PdfReadingLine {
  // A short superscript or bullet glyph must not determine the line's font size.
  const height = weightedHeight(line.parts);
  const fragments: string[] = [];
  let previousEnd = -Infinity;
  for (const part of line.parts) {
    if (fragments.length && part.x - previousEnd > height * 0.24) fragments.push(" ");
    fragments.push(part.text);
    previousEnd = Math.max(previousEnd, part.x + part.width);
  }
  const text = fragments.join("").replace(/\s+/g, " ").trim().replace(/^[\u2022\u00b7\u25aa\u25ab\u25a0\u25a1\u25c6\u25c7\u25cb\u25cf\u25e6]\s*/, "- ");
  const marker = text.match(/^(?:[-*]|(?:\d+(?:\.\d+)*|[a-zA-Z])[.)])\s+/);
  const x = line.parts[0].x;
  const firstPartIsMarker = /^(?:[-*\u2022\u00b7\u25aa\u25ab\u25a0\u25a1\u25c6\u25c7\u25cb\u25cf\u25e6]|(?:\d+(?:\.\d+)*|[a-zA-Z])[.)])$/.test(line.parts[0].text);
  const contentX = firstPartIsMarker && line.parts.length > 1 ? line.parts[1].x
    : x + (marker?.[0].length ?? 0) * height * 0.45;
  return { y: line.y, x, end: previousEnd, height, text, bullet: !!marker, contentX };
}

function ambiguousPdf(): never {
  throw new Error("No se pudo establecer un orden de lectura fiable para esta p\u00e1gina PDF (columnas, tabla o texto girado). Exporta una versi\u00f3n de una columna o copia el texto en el lector para revisarlo.");
}

// Only a persistent empty gutter supports column order. Full-width headings and
// paragraphs divide vertical bands; each band's left column precedes its right.
function columnGutter(rows: PdfLine[], runs: PdfReadingLine[][], span: number, bodyHeight: number): number | undefined {
  if (runs.filter((row) => row.length > 2).length >= 2) ambiguousPdf();
  const gaps = runs.flatMap((row) => row.length === 2
    ? [{ left: row[0].end + row[0].height * 0.5, right: row[1].x - row[1].height * 0.5 }] : []);
  const events = gaps.flatMap((gap) => gap.right > gap.left ? [{ x: gap.left, delta: 1 }, { x: gap.right, delta: -1 }] : [])
    .sort((a, b) => a.x - b.x);
  const support = Math.max(2, Math.ceil(rows.length * 0.25));
  const regions: { left: number; right: number }[] = [];
  let count = 0;
  for (let index = 0; index < events.length;) {
    const x = events[index].x;
    while (index < events.length && events[index].x === x) count += events[index++].delta;
    const next = events[index]?.x;
    if (next !== undefined && next > x && count >= support) {
      const previous = regions[regions.length - 1];
      if (previous?.right === x) previous.right = next;
      else regions.push({ left: x, right: next });
    }
  }
  if (regions.length > 1) ambiguousPdf();
  if (regions.length) return (regions[0].left + regions[0].right) / 2;

  // Staggered baselines may never put both columns in the same row. In that
  // case require a global empty gutter with at least two lines on either side.
  const narrow = runs.flat().filter((line) => line.end - line.x < span * 0.65 && line.height < bodyHeight * 1.2)
    .sort((a, b) => a.x - b.x);
  const occupied: { left: number; right: number; count: number }[] = [];
  for (const line of narrow) {
    const previous = occupied[occupied.length - 1];
    if (previous && line.x <= previous.right) {
      previous.right = Math.max(previous.right, line.end);
      previous.count++;
    } else occupied.push({ left: line.x, right: line.end, count: 1 });
  }
  let leftCount = 0;
  const candidates: number[] = [];
  for (let index = 0; index < occupied.length - 1; index++) {
    leftCount += occupied[index].count;
    const gap = occupied[index + 1].left - occupied[index].right;
    if (leftCount >= 2 && narrow.length - leftCount >= 2 && gap > Math.max(bodyHeight * 1.25, span * 0.025)) {
      candidates.push((occupied[index + 1].left + occupied[index].right) / 2);
    }
  }
  if (candidates.length > 1) ambiguousPdf();
  return candidates[0];
}

function renderPdfLines(ordered: PdfReadingLine[], bodyHeight: number) {
  // Bucket comparable fonts once instead of filtering/sorting every line's full
  // page of spacing samples. This keeps adversarial unique font sizes bounded.
  const fontBucket = (height: number) => Math.round(Math.log(height) / Math.log(1.15));
  const spacing = new Map<number, number[]>();
  for (let index = 1; index < ordered.length; index++) {
    const line = ordered[index];
    const previous = ordered[index - 1];
    if (Math.max(previous.height, line.height) / Math.min(previous.height, line.height) > 1.15) continue;
    const gap = previous.y - line.y;
    if (gap >= line.height * 0.5 && gap <= line.height * 4) {
      const key = fontBucket(line.height);
      const values = spacing.get(key) ?? [];
      values.push(gap);
      spacing.set(key, values);
    }
  }
  const leading = new Map([...spacing].map(([key, gaps]) => {
    gaps.sort((a, b) => a - b);
    return [key, gaps[Math.floor((gaps.length - 1) * 0.35)]];
  }));
  const leadingFor = (height: number) => leading.get(fontBucket(height)) ?? height * 1.5;
  const blocks: { parts: string[]; heading: boolean; bullet: boolean; contentX: number }[] = [];
  ordered.forEach((line, index) => {
    const previous = ordered[index - 1];
    const block = blocks[blocks.length - 1];
    const heading = !line.bullet && line.height >= bodyHeight * 1.2 && line.text.length <= 180;
    const baseline = previous ? Math.max(leadingFor(previous.height), leadingFor(line.height)) : 0;
    const paragraphGap = !!previous && previous.y - line.y > Math.max(baseline * 1.35, baseline + line.height * 0.4);
    const fontChange = !!previous && Math.max(previous.height, line.height) / Math.min(previous.height, line.height) > 1.25;
    const indentation = !!previous && !block?.bullet && /[.!?]$/.test(previous.text) && line.x - previous.x > line.height * 0.8;
    const listEnded = !!block?.bullet && line.x < block.contentX - line.height * 0.4;
    const headingContinuation = heading && block?.heading && !!previous && !paragraphGap
      && Math.max(previous.height, line.height) / Math.min(previous.height, line.height) <= 1.15;
    if (!block || ((heading || block.heading) && !headingContinuation) || line.bullet || paragraphGap || fontChange || indentation || listEnded) {
      const prefix = heading ? (line.height >= bodyHeight * 1.5 ? "# " : "### ") : "";
      blocks.push({ parts: [prefix + line.text], heading, bullet: line.bullet, contentX: line.contentX });
    } else {
      const last = block.parts.length - 1;
      if (block.parts[last].endsWith("-") && /^[\p{Ll}\p{M}]/u.test(line.text)) {
        block.parts[last] = block.parts[last].slice(0, -1);
        block.parts.push(line.text);
      } else block.parts.push(` ${line.text}`);
    }
  });
  return blocks.map((block) => block.parts.join("")).join("\n\n");
}

// Exported for geometry and downstream block-classification regression tests.
export function pdfPageText(items: unknown[]) {
  return extractPdfPage(items).text;
}

function extractPdfPage(items: unknown[]): { text: string; needsReview: boolean } {
  if (items.length > IMPORT_LIMITS.pdfPageItems) limit(`Una p\u00e1gina PDF supera el l\u00edmite de ${IMPORT_LIMITS.pdfPageItems.toLocaleString("es-MX")} fragmentos de texto.`);
  const valid = items.filter((item): item is PdfItem => typeof item === "object" && item !== null && "str" in item && typeof item.str === "string");
  let chars = 0;
  const parts: PdfPart[] = [];
  let unpositioned = 0;
  for (const item of valid) {
    chars += item.str.length;
    checkTextSize(chars, IMPORT_LIMITS.pdfPageChars);
    const text = item.str.trim();
    if (!text) continue;
    if (!item.transform) { unpositioned++; continue; }
    if (!Array.isArray(item.transform) || item.transform.length < 6
      || item.transform.some((value) => !Number.isFinite(value) || Math.abs(value) > 1_000_000)
      || (item.width !== undefined && !Number.isFinite(item.width))
      || (item.height !== undefined && !Number.isFinite(item.height))) ambiguousPdf();
    const [a, b, c, d, x, y] = item.transform;
    if (Math.abs(b) > Math.abs(a) * 0.1 || Math.abs(c) > Math.abs(d) * 0.1) ambiguousPdf();
    const height = Math.max(Math.abs(item.height ?? 0), Math.hypot(c, d), 1);
    const width = Math.max(item.width ?? text.length * height * 0.45, 0);
    if (height > IMPORT_LIMITS.pdfMaxDimension || width > 1_000_000) ambiguousPdf();
    parts.push({ x, y, width, height, text });
  }
  if (!parts.length) {
    const text = valid.map((item) => item.str + (item.hasEOL ? "\n" : "")).join("").trim();
    checkTextSize(text.length, IMPORT_LIMITS.pdfPageChars);
    return { text, needsReview: !!text };
  }
  if (unpositioned) ambiguousPdf();
  // Sorting once replaces the former full lines.find scan per fragment.
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfLine[] = [];
  for (const part of parts) {
    let line = lines[lines.length - 1];
    if (!line || Math.abs(line.y - part.y) > Math.max(2, part.height * 0.35)) {
      line = { y: part.y, height: part.height, parts: [] };
      lines.push(line);
    }
    line.height = Math.max(line.height, part.height);
    line.parts.push(part);
  }
  for (const line of lines) line.parts.sort((a, b) => a.x - b.x);
  let minimumX = Infinity;
  let maximumX = -Infinity;
  for (const part of parts) {
    minimumX = Math.min(minimumX, part.x);
    maximumX = Math.max(maximumX, part.x + part.width);
  }
  const span = maximumX - minimumX;
  const runs = lines.map((line) => {
    const groups: PdfLine[] = [];
    let end = -Infinity;
    for (const part of line.parts) {
      let group = groups[groups.length - 1];
      if (!group || part.x - end > Math.max(line.height * 1.25, span * 0.025)) {
        group = { y: line.y, height: line.height, parts: [] };
        groups.push(group);
      }
      group.parts.push(part);
      end = Math.max(end, part.x + part.width);
    }
    return groups.map(readingLine);
  });
  const bodyHeight = weightedHeight(runs.flat());
  const gutter = columnGutter(lines, runs, span, bodyHeight);
  let text: string;
  if (gutter === undefined) {
    text = renderPdfLines(lines.map(readingLine), bodyHeight);
  } else {
    const sections: string[] = [];
    let left: PdfReadingLine[] = [];
    let right: PdfReadingLine[] = [];
    let wide: PdfReadingLine[] = [];
    const flushColumns = () => {
      if (left.length) sections.push(renderPdfLines(left, bodyHeight));
      if (right.length) sections.push(renderPdfLines(right, bodyHeight));
      left = []; right = [];
    };
    const flushWide = () => {
      if (wide.length) sections.push(renderPdfLines(wide, bodyHeight));
      wide = [];
    };
    for (const row of runs) {
      const crossing = row.some((line) => line.x < gutter && line.end > gutter);
      if (crossing) {
        if (row.length > 1) ambiguousPdf();
        flushColumns();
        wide.push(row[0]);
      } else {
        flushWide();
        for (const line of row) (line.end <= gutter ? left : right).push(line);
      }
    }
    flushWide();
    flushColumns();
    text = sections.join("\n\n");
  }
  checkTextSize(text.length, IMPORT_LIMITS.pdfPageChars);
  return { text, needsReview: gutter !== undefined };
}

function structuredHtmlText(root: Element) {
  const blocks: string[] = [];
  const blockTags = new Set(["p", "li", "blockquote", "figcaption", "td", "th"]);
  root.querySelectorAll("script,style,iframe,object").forEach((node) => node.remove());
  root.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  const visit = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading || blockTags.has(tag)) {
      const text = (element.textContent ?? "").replace(/[^\S\n]+/g, " ").trim();
      if (text) blocks.push(heading ? `${"#".repeat(Number(heading[1]))} ${text}` : tag === "li" ? `- ${text}` : text);
    } else Array.from(element.children).forEach(visit);
  };
  Array.from(root.children).forEach(visit);
  return blocks.length ? blocks.join("\n\n") : (root.textContent ?? "").trim();
}
