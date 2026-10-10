import assert from "node:assert/strict";
import test from "node:test";
import { reconstructOcrPage } from "../src/lib/reader/ocr-structure.ts";
import { PdfStructureLimitError } from "../src/lib/reader/pdf-structure.ts";

const line = (text, y, height = 18, x = 48) => ({ text, confidence: 90,
  bbox: { x0: x, y0: y, x1: x + Math.min(680, text.length * 8), y1: y + height } });
const size = { width: 900, height: 1200 };
const page = paragraphs => ({ text: paragraphs.map(lines => lines.map(line => line.text).join("\n")).join("\n\n"),
  paragraphs: paragraphs.map(lines => ({ lines })) });

test("OCR geometry recovers headings, complete paragraphs and lists", () => {
  const result = reconstructOcrPage(page([
    [line("Informe comunitario", 48, 36)],
    [line("Este párrafo contiene suficiente texto para establecer el tamaño normal", 112),
      line("del documento y unir estas dos líneas sin perder palabras ni cifras 2026.", 136)],
    [line("• Primera propuesta", 198)], [line("2. Segunda propuesta", 228)],
  ]), size);
  assert.deepEqual(result.blocks.map(block => block.kind), ["heading", "paragraph", "bullet", "bullet"]);
  assert.match(result.blocks[1].text, /normal del documento/);
  assert.match(result.blocks[3].text, /^2\./);
  assert.equal(result.needsReview, true);
});

test("OCR paragraph boundaries survive closely spaced same-font prose", () => {
  const result = reconstructOcrPage(page([[line("Primer párrafo completo.", 100)], [line("Segundo párrafo completo.", 123)]]), size);
  assert.deepEqual(result.blocks, [
    { kind: "paragraph", text: "Primer párrafo completo." },
    { kind: "paragraph", text: "Segundo párrafo completo." },
  ]);
});

test("incomplete OCR boxes retain every recognized word in the fallback", () => {
  const input = page([[line("Primer párrafo completo.", 100)]]);
  input.text += "\n\nUna línea que falta en la geometría.";
  const result = reconstructOcrPage(input, size);
  assert.equal(result.text, input.text);
  assert.equal(result.blocks.map(block => block.text).join("\n\n"), input.text);
  assert.equal(result.needsReview, true);
});

for (const box of [undefined, { x0: NaN, y0: 0, x1: 60, y1: 20 }, { x0: 0, y0: 0, x1: 901, y1: 20 },
  { x0: 20, y0: 0, x1: 10, y1: 20 }]) {
  test("invalid OCR geometry falls back without dropping the text", () => {
    const input = page([[{ ...line("Contenido completo.", 100), bbox: box }]]);
    assert.equal(reconstructOcrPage(input, size).text, input.text);
  });
}

test("OCR without blocks retains paragraphs and numbered list labels", () => {
  const result = reconstructOcrPage({ text: "Una introducción.\n\n1. Primera medida\ncontinuación completa.\n2. Segunda medida" }, size);
  assert.deepEqual(result.blocks.map(block => block.kind), ["paragraph", "bullet", "bullet"]);
  assert.equal(result.blocks[1].text, "1. Primera medida continuación completa.");
});

test("oversized OCR text fails before geometry allocation", () => {
  assert.throws(() => reconstructOcrPage({ text: "a".repeat(100_001) }, size), PdfStructureLimitError);
});
