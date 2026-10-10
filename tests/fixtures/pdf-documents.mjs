import { deflateSync } from "node:zlib";

// Synthetic, public test documents. No personal file or third-party PDF is used.
// The parser receives real PDF bytes, including an xref, marked content and a
// structure parent tree; none of PDF.js's parsing methods are mocked.
class PdfWriter {
  objects = [];
  reserve() { this.objects.push(null); return this.objects.length; }
  set(id, value) { this.objects[id - 1] = Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1"); }
  add(value) { const id = this.reserve(); this.set(id, value); return id; }
  bytes(root) {
    const chunks = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
    const offsets = [0];
    let length = chunks[0].length;
    this.objects.forEach((object, index) => {
      if (!object) throw new Error(`Unset PDF object ${index + 1}`);
      offsets.push(length);
      const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
      chunks.push(chunk);
      length += chunk.length;
    });
    chunks.push(Buffer.from(`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`
      + offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
      + `trailer\n<< /Size ${this.objects.length + 1} /Root ${root} 0 R >>\nstartxref\n${length}\n%%EOF\n`));
    return Buffer.concat(chunks);
  }
}

function stream(bytes, entries = "") {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "latin1");
  return Buffer.concat([Buffer.from(`<< ${entries} /Length ${data.length} >>\nstream\n`), data, Buffer.from("\nendstream")]);
}

function literal(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function line(text, y, { size = 12, x = 48, font = "F1" } = {}) {
  return `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${literal(text)}) Tj ET\n`;
}

const paragraphLines = [
  "Este primer parrafo conserva su contenido original y su orden.",
  "La segunda linea pertenece al mismo parrafo del documento.",
];
const bulletTexts = ["Primer elemento con detalle completo.", "Segundo elemento con sus palabras originales."];

export const taggedExpectation = Object.freeze({
  heading: "Documento etiquetado",
  subheading: "Detalles principales",
  paragraph: paragraphLines.join(" "),
  bullets: bulletTexts,
  finalParagraph: "El cierre permite comprobar que el texto no se pierde al importar.",
  artifact: "CABECERA DECORATIVA",
});

/** Tags deliberately use the SAME size and font as body text. */
export function taggedPdf() {
  const pdf = new PdfWriter();
  const catalog = pdf.reserve(), pages = pdf.reserve(), page = pdf.reserve();
  const font = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const content = pdf.reserve(), root = pdf.reserve(), document = pdf.reserve(), parents = pdf.reserve();
  const heading = pdf.reserve(), paragraph = pdf.reserve(), subheading = pdf.reserve(), list = pdf.reserve();
  const firstItem = pdf.reserve(), firstLabel = pdf.reserve(), firstBody = pdf.reserve();
  const secondItem = pdf.reserve(), secondLabel = pdf.reserve(), secondBody = pdf.reserve(), final = pdf.reserve();
  const marked = (role, mcid, contents) => `/${role} << /MCID ${mcid} >> BDC\n${contents}EMC\n`;
  const painted = "/Artifact BMC\n" + line(taggedExpectation.artifact, 778) + "EMC\n"
    + marked("H1", 0, line(taggedExpectation.heading, 744))
    + marked("P", 1, paragraphLines.map((text, index) => line(text, 714 - index * 17)).join(""))
    + marked("H2", 2, line(taggedExpectation.subheading, 659))
    + marked("Lbl", 3, line("\x95", 629))
    + marked("LBody", 4, line(bulletTexts[0], 629, { x: 64 }))
    + marked("Lbl", 5, line("\x95", 608))
    + marked("LBody", 6, line(bulletTexts[1], 608, { x: 64 }))
    + marked("P", 7, line(taggedExpectation.finalParagraph, 567));
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R /StructTreeRoot ${root} 0 R /MarkInfo << /Marked true >> /Lang (es-MX) >>`);
  pdf.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  pdf.set(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /StructParents 0 /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  pdf.set(content, stream(painted));
  pdf.set(root, `<< /Type /StructTreeRoot /K ${document} 0 R /ParentTree ${parents} 0 R /ParentTreeNextKey 1 >>`);
  pdf.set(document, `<< /Type /StructElem /S /Document /P ${root} 0 R /K [${heading} 0 R ${paragraph} 0 R ${subheading} 0 R ${list} 0 R ${final} 0 R] >>`);
  const semantic = (id, role, parent, kids) => pdf.set(id, `<< /Type /StructElem /S /${role} /P ${parent} 0 R /Pg ${page} 0 R /K ${kids} >>`);
  semantic(heading, "H1", document, "0");
  semantic(paragraph, "P", document, "1");
  semantic(subheading, "H2", document, "2");
  semantic(list, "L", document, `[${firstItem} 0 R ${secondItem} 0 R]`);
  semantic(firstItem, "LI", list, `[${firstLabel} 0 R ${firstBody} 0 R]`);
  semantic(firstLabel, "Lbl", firstItem, "3");
  semantic(firstBody, "LBody", firstItem, "4");
  semantic(secondItem, "LI", list, `[${secondLabel} 0 R ${secondBody} 0 R]`);
  semantic(secondLabel, "Lbl", secondItem, "5");
  semantic(secondBody, "LBody", secondItem, "6");
  semantic(final, "P", document, "7");
  pdf.set(parents, `<< /Nums [0 [${[heading, paragraph, subheading, firstLabel, firstBody, secondLabel, secondBody, final].map(id => `${id} 0 R`).join(" ")}]] >>`);
  return pdf.bytes(catalog);
}

export const digitalExpectation = Object.freeze({
  heading: "Documento digital sin etiquetas",
  subheading: "Organizacion del contenido",
  paragraph: paragraphLines.join(" "),
  bullets: bulletTexts,
  finalParagraph: "La segunda pagina conserva tambien el contenido final del archivo.",
});

function untaggedPages(contents) {
  const pdf = new PdfWriter();
  const catalog = pdf.reserve(), pages = pdf.reserve();
  const normal = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const bold = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pageIds = contents.map(content => {
    const page = pdf.reserve();
    const painted = pdf.add(stream(content));
    pdf.set(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${normal} 0 R /F2 ${bold} 0 R >> >> /Contents ${painted} 0 R >>`);
    return page;
  });
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R /Lang (es-MX) >>`);
  pdf.set(pages, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  return pdf.bytes(catalog);
}

export function digitalPdf() {
  return untaggedPages([
    line(digitalExpectation.heading, 744, { size: 24, font: "F2" })
      + paragraphLines.map((text, index) => line(text, 705 - index * 17)).join("")
      + line(digitalExpectation.subheading, 648, { size: 16, font: "F2" })
      + line("\x95", 615) + line(bulletTexts[0], 615, { x: 64 })
      + line("\x95", 594) + line(bulletTexts[1], 594, { x: 64 })
      + line("Un parrafo adicional mantiene la altura habitual del texto.", 553)
      + line("Sus palabras permiten distinguir los tamanos de los encabezados.", 536),
    line("Continuacion del documento", 744, { size: 16, font: "F2" })
      + line(digitalExpectation.finalParagraph, 705)
      + line("Ninguna palabra del documento debe enviarse a un servidor externo.", 688),
  ]);
}

export const columnsExpectation = Object.freeze({
  heading: "Documento con dos columnas",
  left: ["Izquierda: inicio de columna.", "El primer bloque mantiene su orden.", "Izquierda: cierre de columna."],
  right: ["Derecha: inicio de columna.", "El segundo bloque sigue al primero.", "Derecha: cierre de columna."],
});

export function twoColumnPdf() {
  return untaggedPages([line(columnsExpectation.heading, 744, { size: 24, font: "F2" })
    + columnsExpectation.left.map((text, index) => line(text, 699 - index * 18)).join("")
    + columnsExpectation.right.map((text, index) => line(text, 699 - index * 18, { x: 337 })).join("")]);
}

// A 5x7 bitmap alphabet builds a genuine image-only PDF without image libraries.
const bitmap = {
  " ": [0,0,0,0,0,0,0], A:[14,17,17,31,17,17,17], B:[30,17,17,30,17,17,30],
  C:[14,17,16,16,16,17,14], D:[30,17,17,17,17,17,30], E:[31,16,16,30,16,16,31],
  F:[31,16,16,30,16,16,16], G:[14,17,16,23,17,17,14], H:[17,17,17,31,17,17,17],
  I:[14,4,4,4,4,4,14], J:[7,2,2,2,2,18,12], K:[17,18,20,24,20,18,17],
  L:[16,16,16,16,16,16,31], M:[17,27,21,21,17,17,17], N:[17,25,21,19,17,17,17],
  O:[14,17,17,17,17,17,14], P:[30,17,17,30,16,16,16], Q:[14,17,17,17,21,18,13],
  R:[30,17,17,30,20,18,17], S:[15,16,16,14,1,1,30], T:[31,4,4,4,4,4,4],
  U:[17,17,17,17,17,17,14], V:[17,17,17,17,17,10,4], W:[17,17,17,21,21,21,10],
  X:[17,17,10,4,10,17,17], Y:[17,17,10,4,4,4,4], Z:[31,1,2,4,8,16,31],
  "1":[4,12,4,4,4,4,14], "2":[14,17,1,2,4,8,31], "3":[30,1,1,14,1,1,30],
  "-":[0,0,0,31,0,0,0], ".":[0,0,0,0,0,12,12],
};
export const imageExpectation = Object.freeze({
  heading: "Documento escaneado",
  paragraph: "Este texto pertenece a una imagen. Conserva su contenido completo.",
  bullets: ["Primer elemento reconocido.", "Segundo elemento reconocido."],
});

export function imageOnlyPdf() {
  const width = 1400, height = 800;
  const pixels = Buffer.alloc(width * height, 255);
  const paint = (text, x, y, scale) => {
    for (const character of text.toUpperCase()) {
      const glyph = bitmap[character];
      if (!glyph) throw new Error(`No bitmap glyph for ${character}`);
      for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) {
        if (!(glyph[row] & (1 << (4 - column)))) continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          pixels[(y + row * scale + sy) * width + x + column * scale + sx] = 0;
        }
      }
      x += scale * 6;
    }
  };
  paint("DOCUMENTO ESCANEADO", 60, 60, 8);
  paint("ESTE TEXTO PERTENECE A UNA IMAGEN.", 60, 200, 5);
  paint("CONSERVA SU CONTENIDO COMPLETO.", 60, 255, 5);
  paint("- PRIMER ELEMENTO RECONOCIDO.", 60, 370, 5);
  paint("- SEGUNDO ELEMENTO RECONOCIDO.", 60, 435, 5);
  const pdf = new PdfWriter();
  const catalog = pdf.reserve(), pages = pdf.reserve(), page = pdf.reserve();
  const image = pdf.add(stream(deflateSync(pixels), `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`));
  const content = pdf.add(stream("q 700 0 0 400 0 0 cm /Scan Do Q\n"));
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
  pdf.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  pdf.set(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 700 400] /Resources << /XObject << /Scan ${image} 0 R >> >> /Contents ${content} 0 R >>`);
  return pdf.bytes(catalog);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function structuredDocx() {
  const files = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Documento Word de comprobacion.</w:t></w:r></w:p><w:p><w:r><w:t>Este contenido sigue disponible sin mostrar el aviso de PDF.</w:t></w:r></w:p></w:body></w:document>',
  };
  const local = [], central = [];
  let position = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(text), checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(position, 42);
    central.push(entry, filename);
    position += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(position, 16);
  return Buffer.concat([...local, directory, end]);
}
