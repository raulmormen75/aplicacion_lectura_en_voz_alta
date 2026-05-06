import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";
import { z } from "zod";
import { cleanTextForSpeech, createDocumentFromText, incoherenceScore } from "@/lib/reader/text";

export const runtime = "nodejs";

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
        return NextResponse.json({ error: "No se recibió un archivo válido." }, { status: 400 });
      }

      const extracted = await extractFileText(file);
      const cleanText = cleanTextForSpeech(extracted.text);
      const qualityScore = incoherenceScore(cleanText);
      const status = extracted.needsOcr || qualityScore > 0.22 ? "needs-ocr" : "ready";

      const document = createDocumentFromText({
        title: file.name,
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
        return NextResponse.json({ error: "Pega una dirección web válida." }, { status: 400 });
      }

      const article = await extractWebsiteText(payload.url);
      return NextResponse.json({
        document: createDocumentFromText({
          title: article.title || new URL(payload.url).hostname,
          source: "website",
          sourceLabel: payload.url,
          text: article.text,
          qualityMessage: "Sitio web procesado y listo para escuchar.",
        }),
      });
    }

    if (payload.source === "googleDoc") {
      if (!payload.url) {
        return NextResponse.json({ error: "Pega una liga de Google Docs válida." }, { status: 400 });
      }

      const exported = await extractGoogleDocText(payload.url);
      return NextResponse.json({
        document: createDocumentFromText({
          title: exported.title,
          source: "googleDoc",
          sourceLabel: payload.url,
          text: exported.text,
          qualityMessage: "Documento de Google importado y listo para escuchar.",
        }),
      });
    }

    if (!payload.text?.trim()) {
      return NextResponse.json({ error: "Pega texto antes de iniciar la lectura." }, { status: 400 });
    }

    return NextResponse.json({
      document: createDocumentFromText({
        title: payload.title || "Texto pegado",
        source: "pastedText",
        sourceLabel: "Texto pegado",
        text: payload.text,
        qualityMessage: "Texto limpio y listo para escuchar.",
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo procesar el contenido.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function extractFileText(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const fileName = file.name.toLowerCase();
  const mime = file.type;

  if (mime.includes("pdf") || fileName.endsWith(".pdf")) {
    const text = await extractPdfText(arrayBuffer);
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
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: result.value,
      needsOcr: false,
    };
  }

  if (mime.startsWith("text/") || fileName.endsWith(".txt") || fileName.endsWith(".md")) {
    return {
      text: buffer.toString("utf8"),
      needsOcr: false,
    };
  }

  throw new Error("Formato no compatible. Sube PDF, Word o texto.");
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
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();
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
  const text = article?.textContent?.trim() || dom.window.document.body.textContent?.trim() || "";

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
