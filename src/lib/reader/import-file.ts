import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { Worker as OcrWorker } from "tesseract.js";

export type ImportFileOptions = {
  signal: AbortSignal;
  onStatus: (message: string) => void;
};

export type ImportFileResult = { text: string; needsReview: boolean; usedOcr: boolean };

const MAX_BYTES = 25 * 1024 * 1024;
const ASSETS = "/reader-assets/";

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

/** Browser-only import. No document bytes are sent to a server. */
export async function importFile(file: File, options: ImportFileOptions): Promise<ImportFileResult> {
  const { signal, onStatus } = options;
  checkAbort(signal);
  if (!file.size) throw new Error("El archivo est\u00e1 vac\u00edo.");
  if (file.size > MAX_BYTES) throw new Error("El archivo supera el l\u00edmite de 25 MB.");
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
    onStatus("Extrayendo encabezados y p\u00e1rrafos del DOCX...");
    try {
      // The package's browser mapping selects browser/unzip.js; retain its official typings.
      const mammoth = await abortable(import("mammoth"), signal);
      checkAbort(signal);
      const converted = await abortable(mammoth.convertToHtml({ arrayBuffer: bytes }, {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      }), signal);
      checkAbort(signal);
      const dom = new DOMParser().parseFromString(converted.value, "text/html");
      result = {
        text: structuredHtmlText(dom.body),
        needsReview: converted.messages.length > 0 || !!dom.querySelector("img,table"),
        usedOcr: false,
      };
    } catch (error) {
      checkAbort(signal);
      throw new Error("No se pudo abrir el DOCX. Comprueba que no est\u00e9 da\u00f1ado, cifrado o sea un .doc renombrado.", { cause: error });
    }
  } else if (name.endsWith(".txt") || name.endsWith(".md") || file.type === "text/plain") {
    onStatus("Decodificando texto UTF-8...");
    try {
      result = { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), needsReview: false, usedOcr: false };
    } catch {
      throw new Error("El texto no est\u00e1 codificado en UTF-8. Gu\u00e1rdalo como UTF-8 e intenta de nuevo.");
    }
  } else {
    throw new Error("Formato no compatible. Selecciona PDF, DOCX o TXT UTF-8.");
  }
  checkAbort(signal);
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

async function importPdf(bytes: ArrayBuffer, { signal, onStatus }: ImportFileOptions): Promise<ImportFileResult> {
  let loadingTask: PDFDocumentLoadingTask | undefined;
  let pdf: PDFDocumentProxy | undefined;
  let renderTask: RenderTask | undefined;
  let ocr: ReturnType<typeof createOcrHost> | undefined;
  let destruction: Promise<void> | undefined;
  const dispose = () => {
    renderTask?.cancel();
    ocr?.terminate();
    // Destroy the owner once: PDFDocumentProxy.destroy also destroys its loading task.
    destruction ??= (pdf ? pdf.destroy() : loadingTask?.destroy())?.catch(() => {});
  };
  signal.addEventListener("abort", dispose, { once: true });
  let currentPage = 0;
  let usedOcr = false;
  let needsReview = false;
  try {
    const pdfjs = await abortable(import("pdfjs-dist"), signal);
    checkAbort(signal);
    pdfjs.GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.min.mjs`;
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    // Never leave an unresolved password prompt holding the worker alive.
    loadingTask.onPassword = () => { throw new Error("El PDF requiere contrase\u00f1a. Importa una copia sin protecci\u00f3n."); };
    pdf = await abortable(loadingTask.promise, signal);
    checkAbort(signal);
    const pages: string[] = [];
    for (currentPage = 1; currentPage <= pdf.numPages; currentPage++) {
      checkAbort(signal);
      onStatus(`PDF: p\u00e1gina ${currentPage} de ${pdf.numPages}. Extrayendo texto...`);
      const page = await abortable(pdf.getPage(currentPage), signal);
      let canvas: HTMLCanvasElement | undefined;
      try {
        const content = await abortable(page.getTextContent(), signal);
        let text = pdfPageText(content.items);
        if (needsPageOcr(text)) {
          checkAbort(signal);
          onStatus(`OCR: p\u00e1gina ${currentPage} de ${pdf.numPages}. Preparando imagen...`);
          checkAbort(signal);
          const base = page.getViewport({ scale: 1 });
          // Bound canvas memory, especially on mobile and unusually large PDF pages.
          const scale = Math.min(2.5, 4096 / Math.max(base.width, base.height), Math.sqrt(8_000_000 / (base.width * base.height)));
          const viewport = page.getViewport({ scale });
          canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("No se pudo preparar la imagen para OCR.");
          renderTask = page.render({ canvas, canvasContext: context, viewport, background: "white" });
          await abortable(renderTask.promise, signal);
          renderTask = undefined;
          checkAbort(signal);
          ocr ??= createOcrHost(signal, (progress) => {
            onStatus(`OCR: p\u00e1gina ${currentPage} de ${pdf!.numPages}. ${progress}`);
          });
          const image = await abortable(new Promise<Blob>((resolve, reject) => {
            canvas!.toBlob((blob) => blob ? resolve(blob) : reject(new Error("No se pudo convertir la p\u00e1gina para OCR.")), "image/png");
          }), signal);
          const recognized = await ocr.recognize(image);
          usedOcr = true;
          needsReview = true;
          // Keep a short valid digital title if OCR finds nothing on that page.
          if (recognized.trim()) text = recognized.trim();
        }
        if (text.trim()) pages.push(text.trim());
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
type PdfLine = { y: number; height: number; parts: { x: number; width: number; height: number; text: string }[] };

// Exported for geometry and downstream block-classification regression tests.
export function pdfPageText(items: unknown[]) {
  const valid = items.filter((item): item is PdfItem => typeof item === "object" && item !== null && "str" in item && typeof item.str === "string");
  const lines: PdfLine[] = [];
  for (const item of valid) {
    const text = item.str.trim();
    if (!text || !item.transform || item.transform.length < 6) continue;
    const [x, y] = item.transform.slice(4, 6);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const height = Math.max(Math.abs(item.height ?? 0), Math.hypot(item.transform[2], item.transform[3]), 1);
    if (!Number.isFinite(height)) continue;
    let line = lines.find((candidate) => Math.abs(candidate.y - y) <= Math.max(2, height * 0.35));
    if (!line) { line = { y, height, parts: [] }; lines.push(line); }
    line.height = Math.max(line.height, height);
    line.parts.push({ x, width: Math.max(item.width ?? text.length * height * 0.45, 0), height, text });
  }
  if (!lines.length) {
    return valid.map((item) => item.str + (item.hasEOL ? "\n" : "")).join("").trim();
  }
  const weightedHeight = (values: { height: number; text: string }[]) => {
    let remaining = values.reduce((sum, value) => sum + value.text.length, 0) / 2;
    for (const value of [...values].sort((a, b) => a.height - b.height)) {
      remaining -= value.text.length;
      if (remaining <= 0) return value.height;
    }
    return 12;
  };
  const ordered = lines.sort((a, b) => b.y - a.y).map((line) => {
    // A short superscript or bullet glyph must not determine the line's font size.
    const height = weightedHeight(line.parts);
    let text = "";
    let previousEnd = -Infinity;
    line.parts.sort((a, b) => a.x - b.x).forEach((part, index) => {
      if (index && part.x - previousEnd > height * 0.24 && !text.endsWith(" ")) text += " ";
      text += part.text;
      previousEnd = Math.max(previousEnd, part.x + part.width);
    });
    text = text.replace(/\s+/g, " ").trim().replace(/^[\u2022\u00b7\u25aa\u25ab\u25a0\u25a1\u25c6\u25c7\u25cb\u25cf\u25e6]\s*/, "- ");
    const marker = text.match(/^(?:[-*]|(?:\d+(?:\.\d+)*|[a-zA-Z])[.)])\s+/);
    const x = line.parts[0].x;
    const firstPartIsMarker = /^(?:[-*\u2022\u00b7\u25aa\u25ab\u25a0\u25a1\u25c6\u25c7\u25cb\u25cf\u25e6]|(?:\d+(?:\.\d+)*|[a-zA-Z])[.)])$/.test(line.parts[0].text);
    const contentX = firstPartIsMarker && line.parts.length > 1 ? line.parts[1].x
      : x + (marker?.[0].length ?? 0) * height * 0.45;
    return { y: line.y, x, height, text, bullet: !!marker, contentX };
  });
  const bodyHeight = weightedHeight(ordered);
  // Estimate baseline spacing from comparable fonts, not glyph bounding-box height.
  // The lower-middle sample tolerates paragraph gaps and small baseline jitter.
  const spacingSamples = ordered.flatMap((line, index) => {
    const previous = ordered[index - 1];
    if (!previous || Math.max(previous.height, line.height) / Math.min(previous.height, line.height) > 1.15) return [];
    const gap = previous.y - line.y;
    return gap >= line.height * 0.5 && gap <= line.height * 4 ? [{ height: line.height, gap }] : [];
  });
  const leadingFor = (height: number) => {
    const gaps = spacingSamples.filter((sample) => Math.max(sample.height, height) / Math.min(sample.height, height) <= 1.15)
      .map((sample) => sample.gap).sort((a, b) => a - b);
    return gaps.length ? gaps[Math.floor((gaps.length - 1) * 0.35)] : height * 1.5;
  };
  const blocks: { text: string; heading: boolean; bullet: boolean; contentX: number }[] = [];
  ordered.forEach((line, index) => {
    const previous = ordered[index - 1];
    const block = blocks[blocks.length - 1];
    const heading = !line.bullet && line.height >= bodyHeight * 1.2 && line.text.length <= 180;
    const leading = previous ? Math.max(leadingFor(previous.height), leadingFor(line.height)) : 0;
    const paragraphGap = !!previous && previous.y - line.y > Math.max(leading * 1.35, leading + line.height * 0.4);
    const fontChange = !!previous && Math.max(previous.height, line.height) / Math.min(previous.height, line.height) > 1.25;
    const indentation = !!previous && !block?.bullet && /[.!?]$/.test(previous.text) && line.x - previous.x > line.height * 0.8;
    const listEnded = !!block?.bullet && line.x < block.contentX - line.height * 0.4;
    const headingContinuation = heading && block?.heading && !!previous && !paragraphGap
      && Math.max(previous.height, line.height) / Math.min(previous.height, line.height) <= 1.15;
    if (!block || ((heading || block.heading) && !headingContinuation) || line.bullet || paragraphGap || fontChange || indentation || listEnded) {
      const prefix = heading ? (line.height >= bodyHeight * 1.5 ? "# " : "### ") : "";
      blocks.push({ text: prefix + line.text, heading, bullet: line.bullet, contentX: line.contentX });
    } else {
      // Join before text.ts sees individual short prose lines as possible headings.
      block.text = block.text.endsWith("-") && /^[\p{Ll}\p{M}]/u.test(line.text)
        ? block.text.slice(0, -1) + line.text : `${block.text} ${line.text}`;
    }
  });
  return blocks.map((block) => block.text).join("\n\n");
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
