import assert from "node:assert/strict";
import test from "node:test";
import { IMPORT_LIMITS, importFile, pdfPageText, validateDocxArchive } from "../src/lib/reader/import-file.ts";
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

const leftColumn = ["Primera columna linea uno.", "Primera columna linea dos.", "Primera columna linea tres."];
const rightColumn = ["Segunda columna linea uno.", "Segunda columna linea dos.", "Segunda columna linea tres."];

function columns(top = 720, stagger = 0) {
  return leftColumn.flatMap((line, index) => [item(line, top - index * 24, { width: 165 }),
    item(rightColumn[index], top - index * 24 - stagger, { x: 350, width: 170 })]);
}

test("two columns are read down the left before the right, independent of item order or scale", () => {
  const expected = `${leftColumn.join(" ")}\n\n${rightColumn.join(" ")}`;
  for (const scale of [0.5, 1, 2, 4]) {
    const source = columns().reverse().map((part) => ({ ...part, height: part.height * scale,
      width: part.width * scale, transform: part.transform.map((value) => value * scale) }));
    assert.equal(pdfPageText(source), expected);
  }
});

test("staggered two-column baselines retain column reading order", () => {
  assert.equal(pdfPageText(columns(720, 10)), `${leftColumn.join(" ")}\n\n${rightColumn.join(" ")}`);
});

test("a modest 24-point gutter is sufficient when it persists down both columns", () => {
  const source = leftColumn.flatMap((line, index) => [item(line, 720 - index * 24, { width: 240 }),
    item(rightColumn[index], 720 - index * 24, { x: 314, width: 240 })]);
  assert.equal(pdfPageText(source), `${leftColumn.join(" ")}\n\n${rightColumn.join(" ")}`);
});

test("full-width headings and paragraphs divide two-column bands", () => {
  const text = pdfPageText([item("Titulo general", 770, { size: 22, width: 490 }), ...columns(),
    item("Parrafo intermedio de ancho completo.", 620, { width: 490 }), ...columns(580)]);
  assert.equal(text, ["# Titulo general", leftColumn.join(" "), rightColumn.join(" "),
    "Parrafo intermedio de ancho completo.", leftColumn.join(" "), rightColumn.join(" ")].join("\n\n"));
});

test("an isolated wide space within a line does not invent a second column", () => {
  assert.equal(pdfPageText([item("Texto de una", 720, { width: 80 }), item("sola linea.", 720, { x: 230 })]),
    "Texto de una sola linea.");
});

test("persistent three-column layouts produce a useful error instead of scrambled text", () => {
  const source = [720, 696, 672].flatMap((y) => [50, 250, 450].map((x) => item("Texto de columna.", y, { x, width: 120 })));
  assert.throws(() => pdfPageText(source), /orden de lectura fiable.*columna/);
});

test("invalid, rotated and partially missing geometry does not silently discard text", () => {
  for (const damaged of [
    { ...item("Texto.", 720), width: NaN },
    { ...item("Texto.", 720), transform: [12, 0, 0, 12, Infinity, 720] },
    { ...item("Texto.", 720), transform: [0, 12, -12, 0, 50, 720] },
  ]) assert.throws(() => pdfPageText([damaged]), /orden de lectura fiable/);
  assert.throws(() => pdfPageText([item("Texto posicionado.", 720), { str: "Texto sin posicion." }]), /orden de lectura fiable/);
});

test("per-page fragment and text budgets are enforced before reconstruction", () => {
  assert.throws(() => pdfPageText(Array.from({ length: IMPORT_LIMITS.pdfPageItems + 1 }, () => ({ str: "" }))), /fragmentos de texto/);
  assert.throws(() => pdfPageText([item("a".repeat(IMPORT_LIMITS.pdfPageChars + 1), 720, { width: 500 })]), /caracteres/);
  assert.equal(pdfPageText([item("a".repeat(IMPORT_LIMITS.pdfPageChars), 720, { width: 500 })]).length, IMPORT_LIMITS.pdfPageChars);
});

test("thousands of unordered lines with distinct font sizes retain all text", () => {
  const source = Array.from({ length: 3000 }, (_, index) => item("Palabra.", 60_000 - index * 20,
    { size: 12 + index * 0.00001, width: 45 })).reverse();
  assert.equal(pdfPageText(source).split(/\s+/).length, source.length);
});

async function docxZip(extra = {}) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Texto de prueba.</w:t></w:r></w:p></w:body></w:document>');
  for (const [name, value] of Object.entries(extra)) zip.file(name, value);
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

function editCentralDirectory(bytes, edit) {
  const view = new DataView(bytes);
  const end = bytes.byteLength - 22;
  let cursor = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  while (cursor < end) {
    const nameLength = view.getUint16(cursor + 28, true);
    const name = decoder.decode(new Uint8Array(bytes, cursor + 46, nameLength));
    edit(view, cursor, name);
    cursor += 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  return bytes;
}

test("DOCX preflight accepts ordinary stored and deflated archives", async () => {
  await validateDocxArchive(await docxZip(), new AbortController().signal);
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await docxZip());
  await validateDocxArchive(await zip.generateAsync({ type: "arraybuffer", compression: "STORE" }), new AbortController().signal);
});

test("DOCX declared XML, expanded-total and entry-count budgets fail before conversion", async () => {
  const xml = editCentralDirectory(await docxZip(), (view, cursor, name) => {
    if (name === "word/document.xml") view.setUint32(cursor + 24, IMPORT_LIMITS.docxXmlBytes + 1, true);
  });
  await assert.rejects(validateDocxArchive(xml, new AbortController().signal), /4 MB descomprimidos/);
  const total = editCentralDirectory(await docxZip(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`media/image${i}.bin`, "x"]))), (view, cursor, name) => {
    if (name.endsWith(".bin")) view.setUint32(cursor + 24, IMPORT_LIMITS.docxEntryBytes, true);
  });
  await assert.rejects(validateDocxArchive(total, new AbortController().signal), /32 MB descomprimidos/);
  const many = await docxZip(Object.fromEntries(Array.from({ length: IMPORT_LIMITS.docxEntries }, (_, i) => [`part${i}.bin`, "x"])));
  await assert.rejects(validateDocxArchive(many, new AbortController().signal), /archivos internos/);
});

test("DOCX counts actual inflation and rejects a dishonest small declared size", async () => {
  const compressed = editCentralDirectory(await docxZip({ "word/document.xml": "a".repeat(200_000) }), (view, cursor, name) => {
    if (name === "word/document.xml") view.setUint32(cursor + 24, 1, true);
  });
  await assert.rejects(validateDocxArchive(compressed, new AbortController().signal), /descompresi\u00f3n real/);
});

test("DOCX malformed archives, missing document and ZIP64 are rejected", async () => {
  await assert.rejects(validateDocxArchive(new ArrayBuffer(8), new AbortController().signal), /ZIP/);
  const missing = editCentralDirectory(await docxZip(), (view, cursor, name) => {
    if (name === "word/document.xml") new Uint8Array(view.buffer, cursor + 46, name.length).set(new TextEncoder().encode("word/xxxxxxxx.xml"));
  });
  await assert.rejects(validateDocxArchive(missing, new AbortController().signal), /ZIP/);
  const zip64 = await docxZip();
  new DataView(zip64).setUint16(zip64.byteLength - 22 + 10, 0xffff, true);
  await assert.rejects(validateDocxArchive(zip64, new AbortController().signal), /ZIP/);
});

test("DOCX validation remains cancellable during inflation", async () => {
  const bytes = await docxZip({ "word/document.xml": "a".repeat(1_000_000) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 0);
  try { await assert.rejects(validateDocxArchive(bytes, controller.signal), { name: "AbortError" }); }
  finally { clearTimeout(timer); }
});

test("UTF-8 text respects the total character budget and keeps cancellation", async () => {
  const priorWindow = globalThis.window;
  globalThis.window = {};
  try {
    await assert.rejects(importFile(new File(["a".repeat(IMPORT_LIMITS.textChars + 1)], "large.txt"), {
      signal: new AbortController().signal, onStatus() {},
    }), /300.000 caracteres/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(importFile(new File(["Texto."], "normal.txt"), { signal: controller.signal, onStatus() {} }), { name: "AbortError" });
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
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

test("real PDF.js text fragments preserve two-column reading order", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({ data: makePdfFixture(columns()), useSystemFonts: true });
  try {
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    assert.equal(pdfPageText(content.items), `${leftColumn.join(" ")}\n\n${rightColumn.join(" ")}`);
    page.cleanup();
  } finally { await loadingTask.destroy(); }
});
