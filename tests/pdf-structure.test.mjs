import assert from "node:assert/strict";
import test from "node:test";
import { PdfStructureLimitError, reconstructPdfPage } from "../src/lib/reader/pdf-structure.ts";
import { columnsExpectation, digitalExpectation, digitalPdf, taggedExpectation, taggedPdf, twoColumnPdf } from "./fixtures/pdf-documents.mjs";

// All documents and item arrays below are synthetic, with no personal PDF data.
const item = (str, y, { x = 50, size = 12, height = size, width = str.length * size * 0.45, ...extra } = {}) =>
  ({ str, transform: [size, 0, 0, size, x, y], height, width, ...extra });
const ref = (id) => ({ type: "content", id });
const node = (role, ...children) => ({ role, children });
const marked = (id, ...text) => [{ type: "beginMarkedContentProps", id, tag: "Span" }, ...text, { type: "endMarkedContent" }];
const prose = ["Las plataformas abarcan", "telecomunicaciones, las finanzas, el trabajo y el consumo.",
  "Una estructura de intermediacion reorganiza el acceso a los usuarios.", "La demanda y la oferta mantienen su contenido original."];
const paragraph = (top = 720, leading = 20, extra = {}) => prose.map((text, index) => item(text, top - index * leading, extra));

async function pageResult(bytes, pageNumber = 1) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ includeMarkedContent: true });
    const structure = await page.getStructTree();
    const viewport = page.getViewport({ scale: 1 });
    return reconstructPdfPage(content.items, { styles: content.styles, structure, pageWidth: viewport.width, pageHeight: viewport.height });
  } finally { await task.destroy(); }
}

function pdfWithNarrowFontChangeSpace() {
  const content = "BT /F1 12 Tf 80 Tz 1 0 0 1 50 720 Tm (Hola ) Tj /F2 12 Tf (mundo.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

test("real PDF.js narrow spaces survive a horizontally scaled font change", async () => {
  const result = await pageResult(pdfWithNarrowFontChangeSpace());
  assert.equal(result.text, "Hola mundo.");
  assert.deepEqual(result.blocks, [{ kind: "paragraph", text: "Hola mundo." }]);
});

test("explicit narrow space items survive geometric and tagged reconstruction", () => {
  const items = [
    { str: "Hola", width: 19.7376, height: 12, transform: [9.6, 0, 0, 12, 50, 720] },
    { str: " ", width: 2.6688, height: 0, transform: [9.6, 0, 0, 12, 69.7376, 720] },
    { str: "mundo.", width: 34.6656, height: 12, transform: [9.6, 0, 0, 12, 72.4064, 720] },
  ];
  assert.equal(reconstructPdfPage(items).text, "Hola mundo.");
  assert.equal(reconstructPdfPage([...items].reverse()).text, "Hola mundo.");
  assert.equal(reconstructPdfPage(marked("body", ...items), { structure: node("P", ref("body")) }).text, "Hola mundo.");
  assert.equal(reconstructPdfPage([...marked("a", items[0], items[1]), ...marked("b", items[2])],
    { structure: node("P", ref("a"), ref("b")) }).text, "Hola mundo.");
});

test("spaces at a text item's edges survive when boxes touch", () => {
  const first = item("Hola ", 720, { width: 24 });
  const second = item("mundo.", 720, { x: 74 });
  assert.equal(reconstructPdfPage([first, second]).text, "Hola mundo.");
  assert.equal(reconstructPdfPage([item("Hola", 720, { width: 24 }), { ...second, str: " mundo." }]).text, "Hola mundo.");
});

test("real PDF.js tags preserve same-font headings, paragraphs and one block per LI", async () => {
  const result = await pageResult(taggedPdf());
  assert.equal(result.usedTags, true);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.blocks.map((block) => block.kind), ["heading", "paragraph", "subheading", "bullet", "bullet", "paragraph"]);
  assert.equal(result.blocks[0].text, taggedExpectation.heading);
  assert.equal(result.blocks[1].text, taggedExpectation.paragraph);
  assert.equal(result.blocks[2].text, taggedExpectation.subheading);
  assert.deepEqual(result.blocks.slice(3, 5).map((block) => block.text), taggedExpectation.bullets.map((text) => `- ${text}`));
  assert.equal(result.blocks[5].text, taggedExpectation.finalParagraph);
  assert.ok(!result.text.includes(taggedExpectation.artifact));
});

test("real untagged PDF uses type scale and retains every prose and bullet fragment", async () => {
  const result = await pageResult(digitalPdf());
  assert.equal(result.usedTags, false);
  assert.deepEqual(result.blocks.map((block) => block.kind), ["heading", "paragraph", "subheading", "bullet", "bullet", "paragraph"]);
  assert.equal(result.blocks[0].text, digitalExpectation.heading);
  assert.equal(result.blocks[1].text, digitalExpectation.paragraph);
  assert.equal(result.blocks[2].text, digitalExpectation.subheading);
  assert.deepEqual(result.blocks.slice(3, 5).map((block) => block.text), digitalExpectation.bullets.map((text) => `- ${text}`));
});

test("real two-column PDF retains down-column order and a full-width heading", async () => {
  const result = await pageResult(twoColumnPdf());
  assert.equal(result.needsReview, true);
  assert.equal(result.blocks[0].text, columnsExpectation.heading);
  assert.equal(result.blocks[1].text, columnsExpectation.left.join(" "));
  assert.equal(result.blocks[2].text, columnsExpectation.right.join(" "));
});

test("tree order supersedes painting order while spans inherit their marked ID", () => {
  const items = [
    ...marked("paragraph", item("El parrafo aparece primero en el flujo pintado.", 680)),
    ...marked("title", { type: "beginMarkedContent", tag: "Span" }, item("Titulo verdadero", 740), { type: "endMarkedContent" }),
  ];
  const result = reconstructPdfPage(items, { structure: node("Document", node("H1", ref("title")), node("P", ref("paragraph"))) });
  assert.equal(result.usedTags, true);
  assert.deepEqual(result.blocks, [{ kind: "heading", text: "Titulo verdadero" },
    { kind: "paragraph", text: "El parrafo aparece primero en el flujo pintado." }]);
});

test("interleaved parent and child block content falls back without rearranging or losing text", () => {
  const items = [...marked("before", item("Antes.", 720)), ...marked("inside", item("Interior.", 696)),
    ...marked("after", item("Despues.", 672))];
  const structure = node("BlockQuote", ref("before"), node("P", ref("inside")), ref("after"));
  const result = reconstructPdfPage(items, { structure });
  assert.equal(result.usedTags, false);
  assert.equal(result.needsReview, true);
  assert.equal(result.text, "Antes. Interior. Despues.");
});

test("a parent with content only after a child emits that content after the child", () => {
  const items = [...marked("inside", item("Interior.", 720)), ...marked("after", item("Despues.", 696))];
  const result = reconstructPdfPage(items, { structure: node("BlockQuote", node("P", ref("inside")), ref("after")) });
  assert.equal(result.usedTags, true);
  assert.deepEqual(result.blocks, [{ kind: "paragraph", text: "Interior." }, { kind: "paragraph", text: "Despues." }]);
});

test("logical reference order within a paragraph takes precedence over vertical geometry", () => {
  const items = [...marked("a", item("Primero", 720)), ...marked("b", item("Segundo", 696))];
  const result = reconstructPdfPage(items, { structure: node("P", ref("b"), ref("a")) });
  assert.equal(result.usedTags, true);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.blocks, [{ kind: "paragraph", text: "Segundo Primero" }]);
});

test("geometry orders fragments only inside each MCID while retaining tree reference sequence", () => {
  const items = [...marked("a", item("Final.", 650)), ...marked("b", item("dos.", 700), item("Inicio", 720))];
  const result = reconstructPdfPage(items, { structure: node("P", ref("a"), ref("b")) });
  assert.equal(result.usedTags, true);
  assert.equal(result.text, "Final. Inicio dos.");
});

test("H2 through H6 are subheadings even when all visual sizes are identical", () => {
  const items = [1, 2, 3, 4, 5, 6].flatMap((level) => marked(`h${level}`, item(`Nivel ${level}`, 770 - level * 40)));
  const structure = node("Document", ...[1, 2, 3, 4, 5, 6].map((level) => node(`H${level}`, ref(`h${level}`))));
  const result = reconstructPdfPage(items, { structure });
  assert.deepEqual(result.blocks.map((block) => block.kind), ["heading", "subheading", "subheading", "subheading", "subheading", "subheading"]);
});

test("Lbl and LBody become one numbered item with a hanging, dehyphenated continuation", () => {
  const items = [...marked("label", item("1.", 720, { width: 8 })),
    ...marked("body", item("Las telecomunica-", 720, { x: 68 }), item("ciones conservan el texto.", 700, { x: 68 })),
    ...marked("after", ...paragraph(650))];
  const structure = node("Document", node("L", node("LI", node("Lbl", ref("label")), node("LBody", node("P", ref("body"))))), node("P", ref("after")));
  const result = reconstructPdfPage(items, { structure });
  assert.equal(result.usedTags, true);
  assert.equal(result.blocks[0].kind, "bullet");
  assert.equal(result.blocks[0].text, "1. Las telecomunicaciones conservan el texto.");
  assert.equal(result.blocks.length, 2);
});

test("partial tags fall back to geometry and preserve unmarked paragraphs", () => {
  const items = [...marked("title", item("Encabezado principal", 770, { size: 22 })), ...paragraph()];
  const result = reconstructPdfPage(items, { structure: node("Document", node("H1", ref("title"))) });
  assert.equal(result.usedTags, false);
  assert.equal(result.needsReview, true);
  assert.equal(result.blocks[0].text, "Encabezado principal");
  assert.equal(result.blocks[1].text, prose.join(" "));
});

test("a tree covering only some MCIDs cannot discard the remaining marked text", () => {
  const items = [...marked("one", ...paragraph(720)), ...marked("two", ...paragraph(610))];
  const result = reconstructPdfPage(items, { structure: node("Document", node("P", ref("one"))) });
  assert.equal(result.usedTags, false);
  assert.equal(result.needsReview, true);
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[1].text, prose.join(" "));
});

test("IDs must match the exact PDF.js marked-content ID", () => {
  const items = marked("p3R_mc0", ...paragraph());
  for (const wrongId of ["0", "p3R_mcid0", "mc0"]) {
    const result = reconstructPdfPage(items, { structure: node("P", ref(wrongId)) });
    assert.equal(result.usedTags, false);
    assert.equal(result.blocks[0].text, prose.join(" "));
  }
});

test("explicit Artifact markers are excluded without treating arbitrary header text as decoration", () => {
  const items = [{ type: "beginMarkedContent", tag: "Artifact" }, item("Decoracion explicita", 780), { type: "endMarkedContent" },
    item("Encabezado original sin etiqueta Artifact", 745), ...paragraph(700)];
  const result = reconstructPdfPage(items);
  assert.ok(!result.text.includes("Decoracion explicita"));
  assert.ok(result.text.includes("Encabezado original sin etiqueta Artifact"));
});

test("complete tree Artifact roles exclude only the explicitly referenced fragment", () => {
  const items = [...marked("artifact", item("Decoracion", 770)), ...marked("body", ...paragraph())];
  const result = reconstructPdfPage(items, { structure: node("Document", node("Artifact", ref("artifact")), node("P", ref("body"))) });
  assert.equal(result.usedTags, true);
  assert.equal(result.text, prose.join(" "));
});

test("duplicate semantic references never duplicate a fragment", () => {
  const items = marked("body", ...paragraph());
  const result = reconstructPdfPage(items, { structure: node("Document", node("P", ref("body")), node("P", ref("body"))) });
  assert.equal(result.usedTags, false);
  assert.equal(result.text, prose.join(" "));
});

test("cyclic, deep, broad, malformed and throwing trees safely fall back", () => {
  const items = marked("body", ...paragraph());
  const cycle = node("Document"); cycle.children.push(cycle);
  let deep = node("P", ref("body"));
  for (let index = 0; index < 80; index++) deep = node("Sect", deep);
  const broad = node("Document", ...Array.from({ length: 40_001 }, () => node("Span")));
  const throwing = Object.defineProperty({}, "role", { get() { throw new Error("untrusted getter"); } });
  for (const structure of [cycle, deep, broad, { role: "P", children: "bad" }, throwing, node("UnknownRole", ref("body"))]) {
    const result = reconstructPdfPage(items, { structure });
    assert.equal(result.usedTags, false);
    assert.equal(result.needsReview, true);
    assert.equal(result.text, prose.join(" "));
  }
});

test("unbalanced marked-content events fall back without discarding useful text", () => {
  const items = [{ type: "beginMarkedContentProps", id: "body", tag: "P" }, ...paragraph()];
  const result = reconstructPdfPage(items, { structure: node("P", ref("body")) });
  assert.equal(result.usedTags, false);
  assert.equal(result.needsReview, true);
  assert.equal(result.text, prose.join(" "));
});

test("image and annotation references with no text do not invalidate otherwise complete tags", () => {
  const items = marked("body", ...paragraph());
  const result = reconstructPdfPage(items, { structure: node("Document", node("Figure", ref("image")), { type: "object", id: "annotation" }, node("P", ref("body"))) });
  assert.equal(result.usedTags, true);
  assert.equal(result.text, prose.join(" "));
});

test("tags with no geometry retain explicit line breaks and flag the uncertainty", () => {
  const result = reconstructPdfPage(marked("body", { str: "Primer renglon", hasEOL: true }, { str: "Segundo renglon" }),
    { structure: node("P", ref("body")) });
  assert.equal(result.usedTags, true);
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.blocks, [{ kind: "paragraph", text: "Primer renglon Segundo renglon" }]);
});

test("a trustworthy table tag produces the existing useful error instead of invented prose", () => {
  const items = marked("cell", item("100", 720));
  const structure = node("Document", node("Table", node("TR", node("TD", ref("cell")))));
  assert.throws(() => reconstructPdfPage(items, { structure }), /orden de lectura fiable.*tabla/u);
  assert.throws(() => reconstructPdfPage([...items, ...paragraph(670)], { structure }), /orden de lectura fiable.*tabla/u);
});

test("whitespace fragments and empty EOL items are preserved when no geometry exists", () => {
  const items = [{ str: "Uno" }, { str: " " }, { str: "dos" }, { str: "", hasEOL: true }, { str: "Tres" }];
  const plain = reconstructPdfPage(items);
  assert.equal(plain.text, "Uno dos\nTres");
  const tagged = reconstructPdfPage(marked("body", ...items), { structure: node("P", ref("body")) });
  assert.equal(tagged.usedTags, true);
  assert.equal(tagged.text, "Uno dos Tres");
});

test("a tagged list label remains separate even when its width overlaps the body box", () => {
  const items = [...marked("label", item("•", 720, { width: 30 })), ...marked("body", item("Texto de la lista.", 720, { x: 65 }))];
  const result = reconstructPdfPage(items, { structure: node("L", node("LI", node("Lbl", ref("label")), node("LBody", ref("body")))) });
  assert.equal(result.usedTags, true);
  assert.equal(result.blocks[0].text, "- Texto de la lista.");
});

test("complete tags cannot bypass invalid, rotated or partially missing geometry", () => {
  for (const bad of [{ ...item("Texto", 720), width: NaN }, { ...item("Texto", 720), transform: [0, 12, -12, 0, 50, 720] }]) {
    assert.throws(() => reconstructPdfPage(marked("body", bad), { structure: node("P", ref("body")) }), /orden de lectura fiable/u);
  }
  assert.throws(() => reconstructPdfPage(marked("body", item("Texto posicionado", 720), { str: "Texto sin posicion" }),
    { structure: node("P", ref("body")) }), /orden de lectura fiable/u);
});

test("type hierarchy differentiates a 24pt title from an 18pt subtitle", () => {
  const result = reconstructPdfPage([item("Titulo principal", 780, { size: 24 }), ...paragraph(),
    item("Subtitulo secundario", 630, { size: 18 }), ...paragraph(590)]);
  assert.deepEqual(result.blocks.map((block) => block.kind), ["heading", "paragraph", "subheading", "paragraph"]);
});

test("numbered sections use their typography while ordinary numbered lists stay lists", () => {
  const result = reconstructPdfPage([item("1. Introduccion general", 780, { size: 24 }), ...paragraph(),
    item("1.1. Datos principales", 630, { size: 18 }), ...paragraph(590),
    item("1. Primera medida.", 490), item("2. Segunda medida.", 470)]);
  assert.deepEqual(result.blocks.map((block) => block.kind), ["heading", "paragraph", "subheading", "paragraph", "bullet", "bullet"]);
  assert.equal(result.blocks[0].text, "1. Introduccion general");
  assert.equal(result.blocks[2].text, "1.1. Datos principales");
});

test("a short prose line never becomes a heading solely because it is short", () => {
  const result = reconstructPdfPage([item("Una frase breve", 770), ...paragraph(720)]);
  assert.equal(result.blocks[0].kind, "paragraph");
  assert.ok(result.blocks.every((block) => block.kind === "paragraph"));
});

test("bold metadata plus visual isolation can identify a same-size subtitle", () => {
  const result = reconstructPdfPage([...paragraph(780), item("Marco conceptual", 685, { fontName: "body-bold" }), ...paragraph(650)],
    { styles: { "body-bold": { fontFamily: "Helvetica-Bold" } } });
  assert.deepEqual(result.blocks.map((block) => block.kind), ["paragraph", "subheading", "paragraph"]);
});

test("OCR paragraph IDs preserve distinct paragraphs with normal line spacing", () => {
  const items = [item("Documento escaneado", -60, { size: 24, paragraphId: 0 }),
    ...paragraph(-110, 20, { paragraphId: 1 }), ...paragraph(-190, 20, { paragraphId: 2 })];
  const result = reconstructPdfPage(items);
  assert.deepEqual(result.blocks.map((block) => block.kind), ["heading", "paragraph", "paragraph"]);
  assert.equal(result.blocks[1].text, prose.join(" "));
  assert.equal(result.blocks[2].text, prose.join(" "));
  assert.throws(() => reconstructPdfPage([item("Texto", 720, { paragraphId: NaN })]), /orden de lectura fiable/u);
});

test("OCR paragraph IDs remain distinct within a reliable two-column layout", () => {
  const source = ["Primer renglon completo.", "Segundo renglon completo.", "Tercer renglon completo."].flatMap((text, index) =>
    [item(`Izquierda ${text}`, 720 - index * 24, { width: 165, paragraphId: 1 }),
      item(`Derecha ${text}`, 720 - index * 24, { x: 350, width: 170, paragraphId: 2 })]);
  const result = reconstructPdfPage(source.reverse());
  assert.equal(result.needsReview, true);
  assert.equal(result.blocks.length, 2);
  assert.ok(result.blocks[0].text.startsWith("Izquierda"));
  assert.ok(result.blocks[1].text.startsWith("Derecha"));
});

test("large font transforms, baseline jitter, hyphens and hanging bullets remain intact", () => {
  const result = reconstructPdfPage([item("Informe principal", 780, { size: 22 }),
    ...paragraph(740, 24, { height: 3 }), item("•", 618, { width: 5 }), item("Las telecomunica-", 618, { x: 66 }),
    item("ciones conservan el contenido.", 598.1, { x: 66 }), item("• Segunda medida.", 578)]);
  assert.equal(result.blocks[0].kind, "heading");
  assert.equal(result.blocks[1].text, prose.join(" "));
  assert.equal(result.blocks[2].text, "- Las telecomunicaciones conservan el contenido.");
  assert.equal(result.blocks[3].text, "- Segunda medida.");
});

test("page scale and out-of-sequence fragments retain complete prose paragraphs", () => {
  const source = [...paragraph(720, 24), ...paragraph(606, 24)];
  for (const scale of [0.5, 1, 2, 4]) {
    const scaled = source.map((part) => ({ ...part, height: part.height * scale, width: part.width * scale,
      transform: part.transform.map((value) => value * scale) })).reverse();
    assert.equal(reconstructPdfPage(scaled).text, `${prose.join(" ")}\n\n${prose.join(" ")}`);
  }
});

test("three columns and aligned numeric tables are rejected without dropping cells", () => {
  const columns = [720, 696, 672].flatMap((y) => [50, 250, 450].map((x) => item("Texto de columna.", y, { x, width: 120 })));
  assert.throws(() => reconstructPdfPage(columns), /orden de lectura fiable/u);
  const table = [720, 696, 672].flatMap((y, index) => [item(`Categoria ${index}`, y, { width: 120 }), item(`${100 + index}`, y, { x: 350, width: 40 })]);
  assert.throws(() => reconstructPdfPage(table), /orden de lectura fiable/u);
});

test("input budgets include discarded artifacts and never create a partial result", () => {
  assert.throws(() => reconstructPdfPage(Array.from({ length: 20_001 }, () => ({ str: "" }))), PdfStructureLimitError);
  assert.throws(() => reconstructPdfPage([item("a".repeat(100_001), 720, { width: 500 })]), PdfStructureLimitError);
  assert.throws(() => reconstructPdfPage([{ type: "beginMarkedContent", tag: "Artifact" }, { str: "a".repeat(100_001) },
    { type: "endMarkedContent" }]), PdfStructureLimitError);
  assert.equal(reconstructPdfPage([item("a".repeat(100_000), 720, { width: 500 })]).text.length, 100_000);
});

test("thousands of distinct font sizes preserve all fragments without quadratic scans", () => {
  const source = Array.from({ length: 3000 }, (_, index) => item("Palabra.", 60_000 - index * 20,
    { size: 12 + index * 0.00001, width: 45 })).reverse();
  assert.equal(reconstructPdfPage(source).text.split(/\s+/u).length, source.length);
});
