import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const destination = join(root, "public", "reader-assets");
const assets = [
  ["pdfjs-dist", "build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["tesseract.js", "dist/tesseract.min.js", "tesseract.min.js"],
  ["tesseract.js", "dist/worker.min.js", "tesseract.worker.min.js"],
];

await mkdir(destination, { recursive: true });
for (const [packageName, source, filename] of assets) {
  const packageRoot = dirname(require.resolve(`${packageName}/package.json`));
  await copyFile(join(packageRoot, source), join(destination, filename));
  console.log(`Reader asset: ${filename}`);
}
// OCR downloads its WASM runtime and spa/eng language data on demand, not into the repo.
