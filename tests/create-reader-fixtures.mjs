import { mkdir, writeFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";

const destination = new URL("./fixtures/reader/", import.meta.url);
await mkdir(destination, { recursive: true });

function pdfBytes(objects) {
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    length += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  return Buffer.concat(chunks);
}

const canvas = createCanvas(1600, 1000);
const context = canvas.getContext("2d");
context.fillStyle = "white";
context.fillRect(0, 0, canvas.width, canvas.height);
context.fillStyle = "black";
context.font = "bold 48px Arial";
context.fillText("DOCUMENTO ESCANEADO DE PRUEBA", 80, 130);
context.font = "40px Arial";
context.fillText("Este texto se reconoce mediante OCR real.", 80, 240);
context.fillText("La imagen contiene palabras y numeros 12345.", 80, 310);
context.fillText("Segunda seccion para comprobar el texto extraido.", 80, 460);
context.fillText("El archivo no contiene ninguna capa de texto digital.", 80, 530);
const jpeg = canvas.toBuffer("image/jpeg");
const paint = "q 800 0 0 500 0 0 cm /Im1 Do Q";
await writeFile(new URL("scanned-ocr.pdf", destination), pdfBytes([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 500] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
  Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1600 /Height 1000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]),
  `<< /Length ${paint.length} >>\nstream\n${paint}\nendstream`,
]));

const zip = new JSZip();
zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
zip.file("word/_rels/document.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
zip.file("word/styles.xml", '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>');
zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Documento DOCX para QA</w:t></w:r></w:p><w:p><w:r><w:t>Este primer parrafo permite comprobar la importacion local y la conservacion de la estructura del documento.</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Segunda seccion</w:t></w:r></w:p><w:p><w:r><w:t>Este segundo parrafo debe aparecer separado del anterior, sin recurrir a OCR ni enviar el archivo a una API.</w:t></w:r></w:p></w:body></w:document>');
await writeFile(new URL("structured-document.docx", destination), await zip.generateAsync({ type: "nodebuffer" }));
console.log(new URL("scanned-ocr.pdf", destination).pathname);
console.log(new URL("structured-document.docx", destination).pathname);
