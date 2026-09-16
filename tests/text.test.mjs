import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanTextForSpeech,
  prepareTextForReading,
  splitIntoChunks,
  tokenizeWords,
} from "../src/lib/reader/text.ts";

for (const fragment of [
  "telecomunicaciones, las finanzas, el trabajo y el consumo. En los hechos, funciona",
  "como una estructura de intermediación que reorganiza el acceso a usuarios, la",
  "como una estructura de intermediación",
  "Telecomunicaciones y finanzas,",
  "TELECOMUNICACIONES Y FINANZAS,",
  "Las plataformas reorganizan el acceso;",
  "«como una estructura de intermediación»",
]) {
  test(`does not promote isolated prose to a heading: ${fragment}`, () => {
    for (const input of [fragment, `\n\n${fragment}\n\n`, `Antes.\n\n${fragment}\n\nDespués.`]) {
      const { blocks } = prepareTextForReading(input);
      const block = blocks.find((candidate) => candidate.text === fragment);
      assert.ok(block);
      assert.equal(block.kind, "paragraph");
    }
  });
}

for (const [input, kind, text] of [
  ["## telecomunicaciones,", "heading", "telecomunicaciones,"],
  ["### como una estructura de intermediación", "subheading", "como una estructura de intermediación"],
  ["1. Introducción", "subheading", "Introducción"],
  ["1. introducción", "subheading", "introducción"],
  ["2.1. Marco conceptual", "subheading", "Marco conceptual"],
  ["2.1 Marco conceptual", "heading", "2.1 Marco conceptual"],
  ["- como una estructura de intermediación", "bullet", "como una estructura de intermediación"],
  ["* Telecomunicaciones y finanzas,", "bullet", "Telecomunicaciones y finanzas,"],
  ["1. La demanda aumentó.", "bullet", "La demanda aumentó."],
  ["Marco conceptual", "heading", "Marco conceptual"],
  ["TELECOMUNICACIONES Y FINANZAS", "heading", "TELECOMUNICACIONES Y FINANZAS"],
]) {
  test(`preserves heading and list classification: ${input}`, () => {
    const { blocks } = prepareTextForReading(`\n\n${input}\n\n`);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, kind);
    assert.equal(blocks[0].text, text);
  });
}

test("joins adjacent prose fragments without creating heading blocks", () => {
  const input = "El análisis continúa.\nLas plataformas abarcan\ntelecomunicaciones, las finanzas, el trabajo y el consumo. En los hechos, funciona\ncomo una estructura de intermediación que reorganiza el acceso a usuarios, la\ndemanda y la oferta.";
  const { blocks, cleanText } = prepareTextForReading(input);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "paragraph");
  assert.equal(cleanText, input.replaceAll("\n", " "));
  for (const block of blocks) {
    assert.equal(cleanText.slice(block.start, block.end), block.text);
  }
});

for (const parenthesis of [
  "(vigente desde 2020)",
  "(2020 fue un año excepcional)",
  "(en 2020, aumentó la demanda)",
  "(2019 y 2020)",
  "(2020)",
  "(México, 2020 fue un año excepcional)",
  "(El programa, vigente desde 2020)",
  "(consultado en 2020)",
  "(el ISBN identifica la edición)",
  "(la variable doi no cambia)",
  "(García, 2020; vigente desde 2020)",
]) {
  test(`preserves semantic context: ${parenthesis}`, () => {
    const original = `La descripción ${parenthesis} sigue siendo necesaria.`;
    assert.equal(cleanTextForSpeech(original), original);
  });
}

for (const citation of [
  "(García, 2020)",
  "(García y López, 2020)",
  "(Smith & Jones, 2020a, pp. 12-15)",
  "(García et al., 2020)",
  "(Organización Mundial de la Salud, 2020)",
  "(de la Cruz, 2020)",
  "(García, 2019, 2020; López, 2021)",
  "(García, s. f.)",
  "(García,\n2020)",
  "(ibid.)",
  "[García, 2020]",
  "[1, 3-5]",
]) {
  test(`removes complete academic reference: ${citation}`, () => {
    assert.equal(cleanTextForSpeech(`La evidencia ${citation} respalda el resultado.`),
      "La evidencia respalda el resultado.");
  });
}

for (const [original, expected] of [
  ["2+2=4", "2 más 2 igual a 4"],
  ["2 + 2 = 4", "2 más 2 igual a 4"],
  ["x+y=z", "x más y igual a z"],
  ["(2+3)=5", "(2 más 3) igual a 5"],
  ["+2=2", "más 2 igual a 2"],
  ["+ 2 = 2", "más 2 igual a 2"],
  ["+ x = x", "más x igual a x"],
  ["+ x", "más x"],
  ["2+(3+4)=9", "2 más (3 más 4) igual a 9"],
]) {
  test(`retains audible operators: ${original}`, () => {
    assert.equal(cleanTextForSpeech(original), expected);
  });
}

test("removes markdown and graphical emoji sequences without audible debris", () => {
  assert.equal(cleanTextForSpeech("## **Resultado** 😀 👩🏽‍🔬 🇲🇽 1️⃣\n\n===\n\n- _Dato_ ✔️\n+ Otro dato"),
    "Resultado\n\nDato\n\nOtro dato");
});

test("citation removal preserves paragraph boundaries", () => {
  assert.equal(cleanTextForSpeech("Primera oración.\n\n(García, 2020) Segunda oración."),
    "Primera oración.\n\nSegunda oración.");
});

test("mixed content remains stable through blocks, tokens and chunks", () => {
  const original = "## Resultado\n\nLa regla (vigente desde 2020) establece 2+2=4 (García, 2020).";
  const expected = "Resultado\n\nLa regla (vigente desde 2020) establece 2 más 2 igual a 4.";
  const prepared = prepareTextForReading(original);
  assert.equal(prepared.cleanText, expected);
  assert.equal(cleanTextForSpeech(expected), expected);
  for (const block of prepared.blocks) {
    assert.equal(expected.slice(block.start, block.end), block.text);
  }
  assert.deepEqual(tokenizeWords(expected).map((token) => token.text),
    ["Resultado", "La", "regla", "vigente", "desde", "2020", "establece", "2", "más", "2", "igual", "a", "4"]);
  assert.equal(splitIntoChunks(original).map((chunk) => chunk.text).join("\n\n"), expected);
});
