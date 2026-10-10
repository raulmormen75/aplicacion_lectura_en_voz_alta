import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanTextForSpeech,
  cleanTextWithoutInventing,
  countWords,
  createDocumentFromText,
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
  "(García, **2020**)",
  "[García, **2020**]",
  "(Organización **Mundial** de la Salud, 2020)",
  "(Smith, de la Cruz & Jones et al., 2019, 2020a, págs. 12–15)",
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
  ["10/2=5", "10 dividido entre 2 igual a 5"],
  ["x^2", "x elevado a 2"],
  ["x^(-2)", "x elevado a (-2)"],
  ["2*3=6", "2 por 3 igual a 6"],
  ["(x - y)/2", "(x - y) dividido entre 2"],
  ["x<y", "x menor que y"],
  ["10 <= 20", "10 menor o igual que 20"],
  ["x > y", "x mayor que y"],
  ["x>=2", "x mayor o igual que 2"],
  ["x≤2; y≥3; z≠4", "x menor o igual que 2; y mayor o igual que 3; z distinto de 4"],
  ["2×3=6; 10÷2=5", "2 por 3 igual a 6; 10 dividido entre 2 igual a 5"],
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

test("document chunks, blocks and progress use the same once-prepared text", () => {
  const original = "## Resultados\n\nLa evidencia (García, **2020**) registra 3.14 unidades. " +
    "El Dr. García explica 10/2 y x^2 con claridad. ".repeat(30) + "¿Cuál es la conclusión final?";
  const document = createDocumentFromText({ title: "Ejemplo", source: "pastedText", sourceLabel: "Prueba", text: original });
  assert.equal(document.originalText, original);
  assert.ok(!document.cleanText.includes("García, 2020"));
  const tokens = tokenizeWords(document.cleanText);
  assert.equal(document.wordCount, tokens.length);
  assert.deepEqual(document.chunks.flatMap((chunk) => tokenizeWords(chunk.cleanText).map((token) => token.text)),
    tokens.map((token) => token.text));
  let nextWord = 0;
  for (const chunk of document.chunks) {
    assert.equal(chunk.startWord, nextWord);
    assert.equal(chunk.wordCount, countWords(chunk.cleanText));
    assert.equal(chunk.text, chunk.cleanText);
    nextWord += chunk.wordCount;
  }
  assert.equal(nextWord, document.wordCount);
  let blockWord = 0;
  for (const block of document.blocks) {
    assert.equal(document.cleanText.slice(block.start, block.end), block.text);
    assert.equal(block.startWord, blockWord);
    blockWord += block.wordCount;
  }
  assert.equal(blockWord, document.wordCount);
  assert.equal(document.chunks.map((chunk) => chunk.text).join(" ").replace(/\s+/g, " "),
    document.cleanText.replace(/\s+/g, " "));
});

test("long blocks retain decimals, abbreviations and opening punctuation across actual chunk boundaries", () => {
  const original = "El Dr. García mide 3.14 unidades; p. ej. usa 1.25 litros. ".repeat(12) +
    "¿Por qué son útiles esas medidas? ¡Conservan la precisión!";
  const prepared = prepareTextForReading(original);
  const chunks = splitIntoChunks(original, 8);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.map((chunk) => chunk.text).join(" ").replace(/\s+/g, " "),
    prepared.cleanText.replace(/\s+/g, " "));
  assert.deepEqual(chunks.flatMap((chunk) => tokenizeWords(chunk.text).map((token) => token.text)),
    tokenizeWords(prepared.cleanText).map((token) => token.text));
  assert.equal(chunks.filter((chunk) => chunk.text.includes("3.14")).length, 12);
  assert.equal(chunks.filter((chunk) => chunk.text.includes("1.25")).length, 12);
  assert.ok(chunks.every((chunk) => !/\b(?:Dr\.|p\.|ej\.)$/.test(chunk.text)));
  assert.ok(chunks.some((chunk) => chunk.text.includes("¿Por")));
  assert.ok(chunks.some((chunk) => chunk.text.includes("¡Conservan")));
});

test("small chunk budgets keep numeric and abbreviation units whole", () => {
  const chunks = splitIntoChunks("El Dr. García usa 3.14 unidades y p. ej. 1.25 litros.", 1);
  assert.ok(chunks.some((chunk) => chunk.text.includes("Dr. García")));
  assert.ok(chunks.some((chunk) => chunk.text.includes("p. ej. 1.25")));
  assert.ok(chunks.some((chunk) => chunk.text === "3.14"));
  assert.ok(chunks.every((chunk) => chunk.wordCount === countWords(chunk.text)));
});

test("clean-only retains separate variables and subtraction while repairing explicit word wraps", () => {
  assert.equal(cleanTextWithoutInventing("Las variables x y z son independientes."),
    "Las variables x y z son independientes.");
  assert.equal(cleanTextWithoutInventing("x - y; x-\ny; teleco-\nmunicaciones."),
    "x - y; x- y; telecomunicaciones.");
  assert.equal(cleanTextWithoutInventing("a y b; i o u."), "a y b; i o u.");
});

test("citation parsing keeps malformed references and semantic suffixes", () => {
  for (const reference of [
    "(García, 2020xx)", "(García, 2020, resultado)", "(Smith & & Jones, 2020)",
    "(García, 2020; vigente desde 2020)", "(and García, 2020)", "(García, 2020, pp. sin datos)",
  ]) {
    const original = `La descripción ${reference} sigue siendo necesaria.`;
    assert.equal(cleanTextForSpeech(original), original);
  }
});

test("a URL and compound unit retain their slashes", () => {
  assert.equal(cleanTextForSpeech("Consulta https://example.com/path a 10 km/h y/o toma notas."),
    "Consulta https://example.com/path a 10 km/h y/o toma notas.");
});
