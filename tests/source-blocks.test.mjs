import assert from "node:assert/strict";
import test from "node:test";
import { countWords, createDocumentFromText, prepareTextForReading } from "../src/lib/reader/text.ts";

test("recovered PDF semantics survive text cleanup instead of short-line guesses", () => {
  const source = [
    { kind: "heading", text: "Informe" },
    { kind: "subheading", text: "Marco conceptual" },
    { kind: "paragraph", text: "Introducción" },
    { kind: "paragraph", text: "Un párrafo dividido\nen dos líneas conserva todo el contenido." },
    { kind: "bullet", text: "- Primera medida" },
    { kind: "bullet", text: "2. Segunda medida" },
  ];
  const prepared = prepareTextForReading(source.map(block => block.text).join("\n\n"), source);
  assert.deepEqual(prepared.blocks.map(block => block.kind), source.map(block => block.kind));
  assert.equal(prepared.blocks[2].text, "Introducción");
  assert.equal(prepared.blocks[3].text, "Un párrafo dividido en dos líneas conserva todo el contenido.");
  assert.equal(prepared.blocks[4].text, "Primera medida");
  assert.equal(prepared.blocks[5].text, "2. Segunda medida");
});

test("structured document offsets and audio chunks address the same prepared text", () => {
  const source = [
    { kind: "heading", text: "Estudio local" },
    { kind: "paragraph", text: "Un documento conserva cifras 25 y 2026, nombres y palabras completas." },
    { kind: "bullet", text: "1. Una lista numerada" },
    { kind: "subheading", text: "Resultados" },
    { kind: "paragraph", text: "Otro párrafo mantiene la estructura al guardarse." },
  ];
  const document = createDocumentFromText({ title: "Ejemplo PDF", source: "file", sourceLabel: "PDF",
    text: source.map(block => block.text).join("\n\n"), sourceBlocks: source });
  let words = 0;
  for (const block of document.blocks) {
    assert.equal(document.cleanText.slice(block.start, block.end), block.text);
    assert.equal(block.startWord, words);
    assert.equal(block.wordCount, countWords(block.text));
    words += block.wordCount;
  }
  assert.equal(words, document.wordCount);
  let spokenWords = 0;
  for (const chunk of document.chunks) {
    assert.equal(chunk.startWord, spokenWords);
    assert.ok(document.cleanText.includes(chunk.text));
    assert.equal(chunk.wordCount, countWords(chunk.text));
    spokenWords += chunk.wordCount;
  }
  assert.equal(spokenWords, words);
  assert.equal(document.chunks.map(chunk => chunk.text).join("\n\n"), document.cleanText);
});

test("empty recovered blocks use the ordinary text parser", () => {
  assert.deepEqual(prepareTextForReading("Texto de prueba.", []), prepareTextForReading("Texto de prueba."));
});

test("local cleanup retains PDF semantic blocks, numbering and original text", () => {
  const params = { title: "PDF", source: "file", sourceLabel: "PDF", text: "# Informe\n\n### Alcance\n\nIntroducción\n\n2. Segunda medida",
    sourceBlocks: [{ kind: "heading", text: "Informe" }, { kind: "subheading", text: "Alcance" },
      { kind: "paragraph", text: "Introducción" }, { kind: "bullet", text: "2. Segunda medida" }] };
  const imported = createDocumentFromText(params);
  const cleaned = createDocumentFromText({ ...params, sourceBlocks: imported.blocks });
  assert.equal(cleaned.originalText, imported.originalText);
  assert.equal(cleaned.cleanText, imported.cleanText);
  assert.deepEqual(cleaned.blocks, imported.blocks);
});
