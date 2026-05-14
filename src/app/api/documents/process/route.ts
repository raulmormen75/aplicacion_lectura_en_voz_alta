import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";
import { z } from "zod";
import { cleanTextForSpeech, createDocumentFromText, incoherenceScore } from "@/lib/reader/text";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

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
  text: z.string().optional(),
  url: z.string().url().optional(),
});

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
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
          "El archivo es demasiado grande para procesarlo en línea. Prueba con un PDF menor a 25 MB.",
          413,
        );
      }

      const extracted = await extractFileText(file);
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

      return NextResponse.json({
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

    const payload = textPayloadSchema.parse(await request.json());

    if (payload.source === "website") {
      if (!payload.url) {
        throw new DocumentProcessError("Pega una dirección web válida.", 400);
      }

      const article = await extractWebsiteText(payload.url);
      return NextResponse.json({
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
      return NextResponse.json({
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

    return NextResponse.json({
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
    if (error instanceof DocumentProcessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "La solicitud no tiene un formato válido." }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "No se pudo procesar el contenido.";
    return NextResponse.json({ error: message }, { status: 500 });
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
  const pdf = await loadingTask.promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = extractPdfPageText(content.items).trim();
    if (pageText) pages.push(pageText);
  }

  return pages.join("\n\n");
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
  const response = await fetch(url, {
    headers: {
      "user-agent": "Lector Documental Raul/1.0",
    },
  });

  if (!response.ok) {
    throw new Error("No se pudo leer el sitio web. Revisa la liga o intenta con otra página.");
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  const text = article?.content
    ? await extractStructuredTextFromHtml(article.content, url)
    : extractStructuredTextFromElement(dom.window.document.body);

  if (!text) {
    throw new Error("No se encontró texto legible en el sitio web.");
  }

  return {
    title: article?.title ?? dom.window.document.title,
    text,
  };
}

async function extractGoogleDocText(url: string) {
  const docId = getGoogleDocId(url);
  if (!docId) {
    throw new Error("La liga de Google Docs no tiene un identificador válido.");
  }

  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const response = await fetch(exportUrl);
  if (!response.ok) {
    throw new Error(
      "No se pudo exportar el documento de Google. Debe estar compartido o conectarse con Google Drive.",
    );
  }

  return {
    title: "Documento de Google",
    text: await response.text(),
  };
}

function getGoogleDocId(url: string) {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
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
