import { PdfStructureLimitError, reconstructPdfPage, type PdfSourceBlock } from "./pdf-structure.ts";

export type OcrLine = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence?: number;
};

/** Only transferable text and boxes; never Tesseract's circular Page references. */
export type OcrPageResult = { text: string; paragraphs?: { lines: OcrLine[] }[] };

function plainBlocks(text: string): PdfSourceBlock[] {
  const blocks: PdfSourceBlock[] = [];
  for (const paragraph of text.replace(/\r\n?/gu, "\n").split(/\n\s*\n/gu)) {
    let current: PdfSourceBlock | undefined;
    for (const line of paragraph.split("\n").map(value => value.trim()).filter(Boolean)) {
      const bullet = /^(?:[-*\u2022\u00b7\u25aa\u25e6]|(?:\d+(?:\.\d+)*|[a-zA-Z])[.)])\s+/u.test(line);
      if (!current || bullet) {
        current = { kind: bullet ? "bullet" : "paragraph", text: line };
        blocks.push(current);
      } else current.text += ` ${line}`;
    }
  }
  return blocks;
}

export function reconstructOcrPage(page: OcrPageResult, size: { width: number; height: number }) {
  const fallback = () => ({ text: page.text.trim(), blocks: plainBlocks(page.text), needsReview: true });
  if (page.text.length > 100_000) throw new PdfStructureLimitError("El texto OCR supera el límite de 100,000 caracteres por página.");
  if (!page.paragraphs?.length || page.paragraphs.length > 20_000
    || ![size.width, size.height].every(value => Number.isFinite(value) && value > 0 && value <= 4096)) return fallback();
  const items: { str: string; transform: number[]; width: number; height: number; paragraphId: number }[] = [];
  let chars = 0;
  let count = 0;
  for (let paragraphId = 0; paragraphId < page.paragraphs.length; paragraphId++) {
    const paragraph = page.paragraphs[paragraphId];
    if (!Array.isArray(paragraph.lines)) return fallback();
    for (const line of paragraph.lines) {
      if (++count > 20_000) throw new PdfStructureLimitError("El OCR supera el límite de 20,000 líneas por página.");
      if (typeof line.text !== "string") return fallback();
      chars += line.text.length;
      if (chars > 100_000) throw new PdfStructureLimitError("El texto OCR supera el límite de 100,000 caracteres por página.");
      const text = line.text.replace(/\s+/gu, " ").trim();
      if (!text) continue;
      const box = line.bbox;
      if (!box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
        || box.x0 < 0 || box.y0 < 0 || box.x1 > size.width || box.y1 > size.height
        || box.x1 <= box.x0 || box.y1 <= box.y0) return fallback();
      const height = box.y1 - box.y0;
      // Convert image coordinates (downwards) to the PDF engine's upwards axis.
      items.push({ str: text, transform: [height, 0, 0, height, box.x0, -box.y1],
        width: box.x1 - box.x0, height, paragraphId });
    }
  }
  // An incomplete layout must not silently drop any recognized text.
  const compact = (value: string) => value.replace(/\s+/gu, "");
  if (compact(items.map(item => item.str).join("")) !== compact(page.text)) return fallback();
  try {
    const result = reconstructPdfPage(items);
    return { text: result.text, blocks: result.blocks, needsReview: true };
  } catch (error) {
    if (error instanceof PdfStructureLimitError) throw error;
    // Tables, ambiguous columns or boxes retain all OCR text for review.
    return fallback();
  }
}
