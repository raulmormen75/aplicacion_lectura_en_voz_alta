import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";
import { z } from "zod";
import { cleanTextForSpeech, createDocumentFromText, incoherenceScore } from "@/lib/reader/text";
import { MAX_REQUEST_BYTES, MAX_TEXT_CHARS, readBoundedBody, readBoundedJson, readRemote, SafeHttpError } from "@/lib/server/http-safety";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = MAX_REQUEST_BYTES - 64_000;

function documentResponse(value: unknown) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_REQUEST_BYTES) {
    throw new DocumentProcessError("El resultado es demasiado grande. Divide el documento en partes.", 413);
  }
  return new NextResponse(json, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function checkTextSize(text: string) {
  if (text.length > MAX_TEXT_CHARS) throw new DocumentProcessError("El texto es demasiado largo. Divide el documento en partes.", 413);
}

class DocumentProcessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const textPayloadSchema = z.object({
  source: z.enum(["pastedText", "website", "googleDoc"]),
  title: z.string().min(1).max(180).optional(),
  text: z.string().max(MAX_TEXT_CHARS).optional(),
  url: z.string().max(4096).url().optional(),
});

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const bytes = await readBoundedBody(request);
      let formData: FormData;
      try {
        formData = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
      } catch {
        throw new DocumentProcessError("El formulario no tiene un formato válido.", 400);
      }
      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new DocumentProcessError("No se recibió un archivo válido.", 400);
      }

      if (file.size <= 0) {
        throw new DocumentProcessError(
          "El archivo llegó vacío. En móvil, descarga el PDF desde Drive y vuelve a seleccionarlo.",
          400,
        );
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        throw new DocumentProcessError(
          "El archivo es demasiado grande para esta API. Usa un archivo menor a 3.9 MB.",
          413,
        );
      }

      const extracted = await extractFileText(file);
      checkTextSize(extracted.text);
      const cleanText = cleanTextForSpeech(extracted.text);
      const qualityScore = incoherenceScore(cleanText);
      const status = extracted.needsOcr || qualityScore > 0.22 ? "needs-ocr" : "ready";

      const document = createDocumentFromText({
        title: file.name || "Documento importado",
        source: "file",
        sourceLabel: file.type || "archivo local",
        text: extracted.text,
        qualityMessage:
          status === "needs-ocr"
            ? "El documento parece escaneado o poco legible. Puedes aplicar OCR gratuito y revisar el resultado."
            : "Archivo procesado y listo para escuchar.",
      });

      return documentResponse({
        document: {
          ...document,
          quality: {
            status,
            message:
              status === "needs-ocr"
                ? "Texto difícil de leer. Aplica OCR gratuito o revisa el texto antes de escuchar."
                : document.quality.message,
            ocrAvailable: true,
          },
        },
      });
    }

    const payload = textPayloadSchema.parse(await readBoundedJson(request));

    if (payload.source === "website") {
      if (!payload.url) {
        throw new DocumentProcessError("Pega una dirección web válida.", 400);
      }

      const article = await extractWebsiteText(payload.url);
      return documentResponse({
        document: createDocumentFromText({
          title: article.title || new URL(payload.url).hostname,
        source: "website",
        sourceLabel: payload.url,
        text: article.text,
        qualityStatus: "ready",
        qualityMessage: "Sitio web procesado y listo para escuchar.",
      }),
      });
    }

    if (payload.source === "googleDoc") {
      if (!payload.url) {
        throw new DocumentProcessError("Pega una liga de Google Docs válida.", 400);
      }

      const exported = await extractGoogleDocText(payload.url);
      return documentResponse({
        document: createDocumentFromText({
          title: exported.title,
          source: "googleDoc",
          sourceLabel: payload.url,
          text: exported.text,
          qualityStatus: "ready",
          qualityMessage: "Documento de Google importado y listo para escuchar.",
        }),
      });
    }

    if (!payload.text?.trim()) {
      throw new DocumentProcessError("Pega texto antes de iniciar la lectura.", 400);
    }

    return documentResponse({
      document: createDocumentFromText({
        title: payload.title || "Texto pegado",
        source: "pastedText",
        sourceLabel: "Texto pegado",
        text: payload.text,
        qualityStatus: "ready",
        qualityMessage: "Limpieza local aplicada y lista para escuchar.",
        ocrAvailable: false,
      }),
    });
  } catch (error) {
    if (error instanceof DocumentProcessError || error instanceof SafeHttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "La solicitud no tiene un formato válido o supera el límite permitido." }, { status: error.issues.some((issue) => issue.code === "too_big") ? 413 : 400 });
    }

    return NextResponse.json({ error: "No se pudo procesar el contenido. Revisa el formato e intenta nuevamente." }, { status: 500 });
  }
}

async function extractFileText(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const fileName = file.name.toLowerCase();
  const mime = file.type;
  const isPdf = isPdfFile(buffer, mime, fileName);

  if (isPdf) {
    const text = await extractPdfText(arrayBuffer);
    if (!text.trim()) {
      throw new DocumentProcessError(
        "No se encontró texto legible en el PDF. Si es escaneado, prueba con OCR o un PDF con texto seleccionable.",
        422,
      );
    }

    return {
      text,
      needsOcr: text.trim().length < 80,
    };
  }

  if (
    mime.includes("wordprocessingml") ||
    mime.includes("msword") ||
    fileName.endsWith(".docx")
  ) {
    if (buffer.subarray(0, 2).toString("ascii") !== "PK") {
      throw new DocumentProcessError("Convierte el archivo Word al formato DOCX antes de importarlo.", 415);
    }
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ buffer });
    return {
      text: await extractStructuredTextFromHtml(result.value),
      needsOcr: false,
    };
  }

  if (mime.startsWith("text/") || fileName.endsWith(".txt") || fileName.endsWith(".md")) {
    return {
      text: buffer.toString("utf8"),
      needsOcr: false,
    };
  }

  throw new DocumentProcessError("Formato no compatible. Sube PDF, Word o texto.", 415);
}

function isPdfFile(buffer: Buffer, mime: string, fileName: string) {
  const signature = buffer.subarray(0, 5).toString("latin1");
  return signature === "%PDF-" || mime.includes("pdf") || fileName.endsWith(".pdf");
}

async function extractPdfText(arrayBuffer: ArrayBuffer) {
  ensurePdfRuntimePolyfills();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
  ).href;

  const documentInit: DocumentInitParameters = {
    data: new Uint8Array(arrayBuffer),
  };

  const loadingTask = pdfjs.getDocument(documentInit);
  const pages: string[] = [];

  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages > 200) throw new DocumentProcessError("El PDF supera el límite de 200 páginas de esta API.", 413);
    let textLength = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = extractPdfPageText(content.items).trim();
        textLength += pageText.length;
        if (textLength > MAX_TEXT_CHARS) throw new DocumentProcessError("El PDF contiene demasiado texto. Divídelo en partes.", 413);
        if (pageText) pages.push(pageText);
      } finally { page.cleanup(); }
    }
    return pages.join("\n\n");
  } finally { await loadingTask.destroy(); }
}

function ensurePdfRuntimePolyfills() {
  type PdfGlobal = typeof globalThis & {
    DOMMatrix?: typeof DOMMatrix;
    ImageData?: typeof ImageData;
    Path2D?: typeof Path2D;
  };

  const pdfGlobal = globalThis as PdfGlobal;

  if (!pdfGlobal.DOMMatrix) {
    class BasicDOMMatrix {
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;

      constructor(init?: number[]) {
        if (Array.isArray(init) && init.length >= 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
        }
      }

      multiplySelf() {
        return this;
      }

      preMultiplySelf() {
        return this;
      }

      translate() {
        return this;
      }

      scale() {
        return this;
      }

      invertSelf() {
        return this;
      }
    }

    pdfGlobal.DOMMatrix = BasicDOMMatrix as unknown as typeof DOMMatrix;
  }

  if (!pdfGlobal.ImageData) {
    class BasicImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;

      constructor(data: Uint8ClampedArray, width: number, height = 1) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    }

    pdfGlobal.ImageData = BasicImageData as unknown as typeof ImageData;
  }

  if (!pdfGlobal.Path2D) {
    class BasicPath2D {
      addPath() {}
      rect() {}
    }

    pdfGlobal.Path2D = BasicPath2D as unknown as typeof Path2D;
  }
}

async function extractWebsiteText(url: string) {
  const [{ Readability }, { JSDOM }] = await Promise.all([
    import("@mozilla/readability"),
    import("jsdom"),
  ]);
  const response = await readRemote(url, { allowedContentTypes: ["text/html", "application/xhtml+xml", "text/plain"] });

  if (response.status < 200 || response.status >= 300) {
    throw new DocumentProcessError("No se pudo obtener el sitio web.", 502);
  }

  const html = response.body.toString("utf8");
  const dom = new JSDOM(html, { url: response.url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  const text = article?.content
    ? await extractStructuredTextFromHtml(article.content, url)
    : extractStructuredTextFromElement(dom.window.document.body);

  if (!text) {
    throw new Error("No se encontró texto legible en el sitio web.");
  }
  checkTextSize(text);

  return {
    title: article?.title ?? dom.window.document.title,
    text,
  };
}

async function extractGoogleDocText(url: string) {
  const docId = getGoogleDocId(url);
  if (!docId) {
    throw new DocumentProcessError("La liga de Google Docs no tiene un identificador válido.", 400);
  }

  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const response = await readRemote(exportUrl, { maxBytes: 1_200_000, allowedContentTypes: ["text/plain"] });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      "No se pudo exportar el documento de Google. Debe estar compartido o conectarse con Google Drive.",
    );
  }

  const text = response.body.toString("utf8");
  checkTextSize(text);
  return {
    title: "Documento de Google",
    text,
  };
}

function getGoogleDocId(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "docs.google.com" || parsed.username || parsed.password || parsed.port) return null;
  const match = parsed.pathname.match(/^\/document\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

type PdfTextContentItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
};

type PdfLine = {
  y: number;
  height: number;
  parts: Array<{
    x: number;
    width: number;
    text: string;
  }>;
};

function extractPdfPageText(items: unknown[]) {
  const positionedText = extractPdfTextFromPositions(items);
  if (positionedText) return positionedText;

  const lines: string[] = [];
  let buffer = "";

  for (const item of items) {
    if (!isPdfTextContentItem(item)) continue;
    buffer += item.str ?? "";

    if (item.hasEOL) {
      const cleanLine = buffer.replace(/\s+/g, " ").trim();
      if (cleanLine) lines.push(cleanLine);
      buffer = "";
    }
  }

  const cleanLine = buffer.replace(/\s+/g, " ").trim();
  if (cleanLine) lines.push(cleanLine);

  return lines.join("\n");
}

function extractPdfTextFromPositions(items: unknown[]) {
  const lines: PdfLine[] = [];

  for (const item of items) {
    if (!isPdfTextContentItem(item)) continue;
    const text = (item.str ?? "").trim();
    const transform = item.transform;
    if (!text || !transform || transform.length < 6) continue;

    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    const height = Math.max(Math.abs(item.height ?? transform[3] ?? 10), 1);
    const tolerance = Math.max(2, height * 0.35);
    let line = lines.find((candidate) => Math.abs(candidate.y - y) <= tolerance);

    if (!line) {
      line = { y, height, parts: [] };
      lines.push(line);
    }

    line.height = Math.max(line.height, height);
    line.parts.push({
      x,
      width: Math.max(item.width ?? text.length * height * 0.45, 0),
      text,
    });
  }

  if (!lines.length) return "";

  const orderedLines = lines
    .sort((a, b) => b.y - a.y)
    .map((line) => ({
      ...line,
      text: joinPdfLineParts(line),
    }))
    .filter((line) => line.text);
  const pageLines: string[] = [];

  orderedLines.forEach((line, index) => {
    const previous = orderedLines[index - 1];
    if (previous) {
      const verticalGap = Math.abs(previous.y - line.y);
      const lineHeight = Math.max(previous.height, line.height, 1);
      if (verticalGap > lineHeight * 1.65) pageLines.push("");
    }

    pageLines.push(line.text);
  });

  return pageLines.join("\n");
}

function joinPdfLineParts(line: PdfLine) {
  const parts = line.parts.sort((a, b) => a.x - b.x);
  let output = "";
  let previousEnd = 0;

  parts.forEach((part, index) => {
    if (index > 0) {
      const gap = part.x - previousEnd;
      if (gap > line.height * 0.24 && !output.endsWith(" ")) output += " ";
    }

    output += part.text;
    previousEnd = Math.max(previousEnd, part.x + part.width);
  });

  return output.replace(/\s+/g, " ").trim();
}

function isPdfTextContentItem(item: unknown): item is PdfTextContentItem {
  return typeof item === "object" && item !== null && "str" in item;
}

async function extractStructuredTextFromHtml(html: string, url?: string) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(html, url ? { url } : undefined);
  return extractStructuredTextFromElement(dom.window.document.body);
}

function extractStructuredTextFromElement(root: Element | null) {
  if (!root) return "";

  const blocks: string[] = [];
  const blockTags = new Set([
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "blockquote",
    "figcaption",
    "td",
    "th",
  ]);

  const visit = (element: Element) => {
    const tag = element.tagName.toLowerCase();

    if (blockTags.has(tag)) {
      const text = collapseElementText(element.textContent ?? "");
      if (!text) return;

      if (tag.startsWith("h")) {
        const level = Math.min(Number(tag.slice(1)) || 2, 6);
        blocks.push(`${"#".repeat(level)} ${text}`);
        return;
      }

      if (tag === "li") {
        blocks.push(`- ${text}`);
        return;
      }

      blocks.push(text);
      return;
    }

    Array.from(element.children).forEach(visit);
  };

  Array.from(root.children).forEach(visit);

  if (!blocks.length) return collapseElementText(root.textContent ?? "");

  return blocks.join("\n\n");
}

function collapseElementText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
