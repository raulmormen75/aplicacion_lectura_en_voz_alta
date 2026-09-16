import assert from "node:assert/strict";
import test from "node:test";
import { pdfPageText } from "../src/lib/reader/import-file.ts";
import { prepareTextForReading } from "../src/lib/reader/text.ts";

// Synthetic PDF.js TextItems; these fixtures never read or write a user's PDF.
function item(str, y, { x = 50, size = 12, height = size, width = str.length * size * 0.45 } = {}) {
  return { str, transform: [size, 0, 0, size, x, y], height, width };
}

const prose = [
  "Las plataformas abarcan",
  "telecomunicaciones, las finanzas, el trabajo y el consumo. En los hechos, funcionan",
  "como una estructura de intermediacion que reorganiza el acceso a usuarios, la",
  "demanda y la oferta.",
];

const reportedTitle = ["M\u00f3dulo 2. Econom\u00eda Digital y Mercados", "Emergentes"];
const reportedSummary = [
  "La econom\u00eda digital ya no puede estudiarse como un \u00e1mbito separado de las",
  "telecomunicaciones, las finanzas, el trabajo y el consumo. En los hechos, funciona",
];

test("reported two-line title is one heading and the summary remains one paragraph", () => {
  const items = [...reportedTitle.map((line, i) => item(line, 770 - i * 26, { size: 20 })),
    ...reportedSummary.map((line, i) => item(line, 704 - i * 24))];
  const text = pdfPageText(items);
  assert.equal(text, `# ${reportedTitle.join(" ")}\n\n${reportedSummary.join(" ")}`);
  const { blocks } = prepareTextForReading(text);
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph"]);
  assert.equal(blocks[0].text, reportedTitle.join(" "));
  assert.equal(blocks[1].text, reportedSummary.join(" "));
});

for (const leading of [14, 20, 24, 30]) {
  test(`normal leading ${leading} stays one prose paragraph, not headings`, () => {
    const text = pdfPageText(prose.map((line, i) => item(line, 720 - i * leading)));
    assert.equal(text, prose.join(" "));
    const { blocks } = prepareTextForReading(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, "paragraph");
    assert.equal(blocks[0].text, prose.join(" "));
  });
}

test("small reported glyph heights use the font transform and tolerate baseline jitter", () => {
  const text = pdfPageText(prose.map((line, i) => item(line, [720, 700.3, 679.9, 660][i], { height: 3 })));
  assert.equal(text, prose.join(" "));
});

test("larger-font titles and subtitles remain separate from body paragraphs", () => {
  const items = [item("Informe de plataformas", 770, { size: 22 }),
    ...prose.map((line, i) => item(line, 730 - i * 20)),
    item("Alcance del estudio", 635, { size: 16 }),
    ...prose.map((line, i) => item(line, 605 - i * 20))];
  const { blocks } = prepareTextForReading(pdfPageText(items));
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph", "subheading", "paragraph"]);
  assert.equal(blocks[0].text, "Informe de plataformas");
  assert.equal(blocks[2].text, "Alcance del estudio");
  assert.equal(blocks[1].text, prose.join(" "));
});

test("extra baseline spacing separates real paragraphs with double-spaced body text", () => {
  const items = [...prose.map((line, i) => item(line, 720 - i * 24)),
    ...prose.map((line, i) => item(line, 606 - i * 24))];
  const text = pdfPageText(items);
  assert.equal(text, `${prose.join(" ")}\n\n${prose.join(" ")}`);
  assert.deepEqual(prepareTextForReading(text).blocks.map((block) => block.kind), ["paragraph", "paragraph"]);
});

test("first-line indentation separates paragraphs without an extra vertical gap", () => {
  const items = [...prose.map((line, i) => item(line, 720 - i * 20)),
    ...prose.map((line, i) => item(line, 640 - i * 20, { x: i === 0 ? 68 : 50 }))];
  assert.equal(pdfPageText(items), `${prose.join(" ")}\n\n${prose.join(" ")}`);
});

test("bullet markers and hanging continuations form complete list entries", () => {
  const items = [item("\u2022", 720, { width: 5 }), item("Primera medida para mejorar", 720, { x: 66 }),
    item("el acceso de toda la comunidad.", 700, { x: 66 }),
    item("\u2022 Segunda medida.", 680),
    item("Texto posterior que conserva su estructura de parrafo.", 660)];
  const text = pdfPageText(items);
  assert.equal(text, "- Primera medida para mejorar el acceso de toda la comunidad.\n\n- Segunda medida.\n\nTexto posterior que conserva su estructura de parrafo.");
  assert.deepEqual(prepareTextForReading(text).blocks.map((block) => block.kind), ["bullet", "bullet", "paragraph"]);
});

test("numbered list continuations do not lose their numbering", () => {
  const items = [item("1. Primera medida para mejorar", 720), item("el acceso de toda la comunidad.", 700, { x: 66 }),
    item("2. Segunda medida.", 680)];
  const text = pdfPageText(items);
  assert.equal(text, "1. Primera medida para mejorar el acceso de toda la comunidad.\n\n2. Segunda medida.");
  assert.deepEqual(prepareTextForReading(text).blocks.map((block) => block.kind), ["bullet", "bullet"]);
});

test("horizontal fragments sort correctly and wrap hyphenation is rejoined", () => {
  const items = [item("ciones permiten una comunicacion clara y continua.", 700),
    item("telecomunica-", 720, { x: 73 }), item("Las", 720, { width: 18 })];
  assert.equal(pdfPageText(items), "Las telecomunicaciones permiten una comunicacion clara y continua.");
});

test("font changes in notes do not redefine body leading", () => {
  const items = [...prose.map((line, i) => item(line, 720 - i * 24)),
    item("Nota con informacion complementaria sobre el documento.", 560, { size: 8 }),
    item("Esta informacion no sustituye los resultados principales.", 548, { size: 8 })];
  const text = pdfPageText(items);
  assert.equal(text.split("\n\n")[0], prose.join(" "));
  assert.equal(text.split("\n\n").length, 2);
});

test("fallback retains explicit line endings when there are no usable positions", () => {
  assert.equal(pdfPageText([{ str: "Uno", hasEOL: true }, { str: "Dos", hasEOL: true }, {}]), "Uno\nDos");
  assert.equal(pdfPageText([]), "");
});

test("isolated same-size titles preserve their surrounding paragraph boundaries", () => {
  const items = [...prose.map((line, i) => item(line, 760 - i * 20)),
    item("Marco conceptual", 666),
    ...prose.map((line, i) => item(line, 632 - i * 20))];
  const { blocks } = prepareTextForReading(pdfPageText(items));
  assert.deepEqual(blocks.map((block) => block.kind), ["paragraph", "heading", "paragraph"]);
  assert.equal(blocks[1].text, "Marco conceptual");
});

test("page scale and extraction order do not change paragraph reconstruction", () => {
  const source = [...prose.map((line, i) => item(line, 720 - i * 24)),
    ...prose.map((line, i) => item(line, 606 - i * 24))];
  const expected = `${prose.join(" ")}\n\n${prose.join(" ")}`;
  for (const scale of [0.5, 1, 2, 4]) {
    const scaled = source.map((line) => ({ ...line, height: line.height * scale,
      width: line.width * scale, transform: line.transform.map((value) => value * scale) })).reverse();
    assert.equal(pdfPageText(scaled), expected);
  }
});

// Complete PDF bytes, including xref, held only in memory. No on-disk fixture exists.
function makePdfFixture(items) {
  const content = items.map(({ str, transform }) => {
    const escaped = str.replace(/[\\()]/g, "\\$&");
    return `BT /F1 ${transform[3]} Tf 1 0 0 1 ${transform[4]} ${transform[5]} Tm (${escaped}) Tj ET`;
  }).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

test("real PDF.js extraction feeds geometry and unchanged text.ts without prose headings", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const input = [item("Informe de plataformas", 770, { size: 22 }),
    ...prose.map((line, i) => item(line, 730 - i * 24)),
    ...prose.map((line, i) => item(line, 616 - i * 24)),
    item("- Primera medida para mejorar", 502), item("el acceso de toda la comunidad.", 478, { x: 66 }),
    item("- Segunda medida.", 454)];
  const loadingTask = getDocument({ data: makePdfFixture(input), useSystemFonts: true });
  try {
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text = pdfPageText(content.items);
    const { blocks } = prepareTextForReading(text);
    assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph", "paragraph", "bullet", "bullet"]);
    assert.equal(blocks[1].text, prose.join(" "));
    assert.equal(blocks[2].text, prose.join(" "));
    assert.equal(blocks[3].text, "Primera medida para mejorar el acceso de toda la comunidad.");
    page.cleanup();
  } finally {
    await loadingTask.destroy();
  }
});

test("real PDF.js preserves the reported accented multiline title as a single heading", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const input = [...reportedTitle.map((line, i) => item(line, 770 - i * 26, { size: 20 })),
    ...reportedSummary.map((line, i) => item(line, 704 - i * 24))];
  const loadingTask = getDocument({ data: makePdfFixture(input), useSystemFonts: true });
  try {
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const { blocks } = prepareTextForReading(pdfPageText(content.items));
    assert.deepEqual(blocks.map((block) => ({ kind: block.kind, text: block.text })), [
      { kind: "heading", text: reportedTitle.join(" ") },
      { kind: "paragraph", text: reportedSummary.join(" ") },
    ]);
    page.cleanup();
  } finally {
    await loadingTask.destroy();
  }
});
