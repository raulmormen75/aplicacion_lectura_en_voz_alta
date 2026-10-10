import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setImmediate as settleProducer } from "node:timers/promises";
import { inflateRawSync } from "node:zlib";

export class SafeHttpError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const MAX_REQUEST_BYTES = 4_000_000;
export const MAX_TEXT_CHARS = 300_000;

export async function readBoundedBody(request: Request, limit = MAX_REQUEST_BYTES, timeoutMs = 15_000) {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw new SafeHttpError("La solicitud supera el tamaño permitido.", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SafeHttpError("Se agotó el tiempo de la solicitud.", 408));
    }, timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > limit) throw new SafeHttpError("La solicitud supera el tamaño permitido.", 413);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    if (!complete) {
      // Undici's multipart producer finishes its current pull asynchronously.
      // Cancel after that turn, then release the lock only after cancellation.
      await settleProducer();
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

export const MAX_PDF_PAGE_ITEMS = 8_000;
export const MAX_PDF_TOTAL_ITEMS = 100_000;

// Check strings and coordinates before grouping PDF items into visual lines.
export function assertPdfTextItemLimits(items: unknown[], remainingChars = MAX_TEXT_CHARS) {
  if (items.length > MAX_PDF_PAGE_ITEMS) throw new SafeHttpError("Una página del PDF contiene demasiados elementos. Divide el documento.", 413);
  let chars = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const part = item as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
    if (typeof part.str !== "string") throw new SafeHttpError("El PDF contiene texto con un formato inválido.", 422);
    chars += part.str.length;
    if (chars > remainingChars) throw new SafeHttpError("El PDF contiene demasiado texto. Divídelo en partes.", 413);
    const validCoordinate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100_000_000;
    if ((part.transform !== undefined && (!Array.isArray(part.transform) || part.transform.length !== 6 || !part.transform.every(validCoordinate))) ||
        [part.width, part.height].some(value => value !== undefined && !validCoordinate(value))) {
      throw new SafeHttpError("El PDF contiene coordenadas de texto inválidas.", 422);
    }
  }
  return chars;
}

const MAX_DOCX_ENTRIES = 2_048;
const MAX_DOCX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_DOCX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_DOCX_COMPRESSION_RATIO = 200;

// Validate the directory and actual inflated sizes before Mammoth opens the ZIP.
// ZIP64, encrypted and multi-volume archives are outside this upload contract.
export function assertDocxArchiveLimits(buffer: Buffer) {
  const invalid = () => new SafeHttpError("El DOCX está dañado o usa un formato de archivo no compatible.", 415);
  const tooLarge = () => new SafeHttpError("El DOCX se expande demasiado al abrirlo. Divide el documento.", 413);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw invalid();
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directory = buffer.readUInt32LE(end + 16);
  if (!count || count === 0xffff || directory === 0xffffffff || directorySize === 0xffffffff ||
      buffer.readUInt16LE(end + 8) !== count || directory + directorySize !== end) throw invalid();
  if (count > MAX_DOCX_ENTRIES) throw tooLarge();
  let offset = directory;
  let expandedTotal = 0;
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const expanded = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(method) || buffer.readUInt16LE(offset + 34) ||
        local + 30 > directory || buffer.readUInt32LE(local) !== 0x04034b50 ||
        buffer.readUInt16LE(local + 8) !== method || buffer.readUInt16LE(local + 6) !== flags) throw invalid();
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (!name || names.has(name) || name.includes("\0")) throw invalid();
    names.add(name);
    expandedTotal += expanded;
    if (expanded > MAX_DOCX_ENTRY_BYTES || expandedTotal > MAX_DOCX_EXPANDED_BYTES ||
        (expanded > 0 && (!compressed || expanded / compressed > MAX_DOCX_COMPRESSION_RATIO))) throw tooLarge();
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > directory || start < local + 30) throw invalid();
    const bytes = buffer.subarray(start, start + compressed);
    let actual: Buffer;
    try {
      actual = method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: Math.max(1, Math.min(MAX_DOCX_ENTRY_BYTES, MAX_DOCX_EXPANDED_BYTES - (expandedTotal - expanded))) });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") throw tooLarge();
      throw invalid();
    }
    if (actual.length !== expanded) throw invalid();
    offset = next;
  }
  if (offset !== end || !names.has("[Content_Types].xml") || !names.has("word/document.xml")) throw invalid();
}

export async function readBoundedJson(request: Request, limit = MAX_REQUEST_BYTES): Promise<unknown> {
  const body = await readBoundedBody(request, limit);
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new SafeHttpError("La solicitud no contiene JSON válido.", 400);
  }
}

// Normalize IPv6 (including mapped IPv4) before applying a public-unicast policy.
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes("%")) return false;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const halves = normalized.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = (halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left).map((part) => parseInt(part, 16));
  if (words.length !== 8) return false;
  // Reject mapped/translation/tunnel and special-purpose ranges, not just loopback.
  return words[0] >= 0x2000 && words[0] <= 0x3fff &&
    !(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) &&
    words[0] !== 0x2002 && !(words[0] === 0x3fff && words[1] < 0x1000);
}

export function validateRemoteUrl(input: string | URL) {
  let url: URL;
  try { url = new URL(input); } catch { throw new SafeHttpError("La dirección no es válida."); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new SafeHttpError("Solo se admiten direcciones HTTP o HTTPS sin credenciales.");
  }
  return url;
}

type Dependencies = {
  lookup: typeof lookup;
  httpRequest: typeof httpRequest;
  httpsRequest: typeof httpsRequest;
};
type RemoteOptions = {
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  allowedContentTypes?: string[];
  // Only for an operator-configured inference endpoint, never user URLs.
  trustedEndpoint?: boolean;
};

export function createRemoteReader(deps: Dependencies = { lookup, httpRequest, httpsRequest }) {
  return async function readRemote(input: string, options: RemoteOptions = {}) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
    const signal = controller.signal;
    const aborted = () => options.signal?.aborted
      ? new SafeHttpError("La solicitud fue cancelada.", 499)
      : new SafeHttpError("Se agotó el tiempo de conexión.", 504);
    const abortable = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const onAbort = () => reject(aborted());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      if (signal.aborted) onAbort();
    });
    try {
      if (signal.aborted) throw aborted();
      let url = validateRemoteUrl(input);
      for (let hop = 0; ; hop++) {
        if (signal.aborted) throw aborted();
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) }]
          : await abortable(deps.lookup(hostname, { all: true, verbatim: true }));
        if (!addresses.length || (!options.trustedEndpoint && addresses.some(({ address }) => !isPublicAddress(address)))) {
          throw new SafeHttpError("El destino de la dirección no está permitido.", 400);
        }
        const pinned = addresses[0];
        const result = await abortable(new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
          const transport = url.protocol === "https:" ? deps.httpsRequest : deps.httpRequest;
          const req = transport(url, {
            method: options.method ?? "GET", signal, agent: false, maxHeaderSize: 16_384,
            headers: { "user-agent": "Lector Documental Raul/1.0", ...options.headers, "accept-encoding": "identity" },
            // Pin the validated result; preserve the URL hostname for Host and TLS verification.
            lookup: (_host, lookupOptions, callback) => {
              if (lookupOptions.all) callback(null, [pinned]);
              else callback(null, pinned.address, pinned.family);
            },
          }, (response) => {
            const status = response.statusCode ?? 502;
            const headers = response.headers;
            response.on("error", reject);
            if ([301, 302, 303, 307, 308].includes(status)) {
              resolve({ status, headers, body: Buffer.alloc(0) });
              response.destroy();
              return;
            }
            const contentType = (headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
            if (status < 200 || status >= 300 || (options.allowedContentTypes && !options.allowedContentTypes.includes(contentType))) {
              reject(new SafeHttpError("El servidor remoto no devolvió un contenido compatible.", 502));
              response.destroy();
              return;
            }
            const limit = options.maxBytes ?? 2_000_000;
            if ((headers['content-encoding'] && headers['content-encoding'] !== 'identity') ||
                Number(headers['content-length'] ?? 0) > limit) {
              reject(new SafeHttpError("La respuesta remota supera los límites admitidos.", 502));
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > limit) {
                reject(new SafeHttpError("La respuesta remota es demasiado grande.", 502));
                response.destroy();
              } else chunks.push(chunk);
            });
            response.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks, size) }));
            response.on("aborted", () => reject(new SafeHttpError("La respuesta remota se interrumpió.", 502)));
          });
          req.on("error", reject);
          req.end(options.body);
        }));
        if (![301, 302, 303, 307, 308].includes(result.status)) return { ...result, url: url.href };
        // Never forward document text through an inference endpoint redirect.
        if (options.method === "POST" || hop >= (options.maxRedirects ?? 3) || !result.headers.location) {
          throw new SafeHttpError("La redirección remota no está permitida.", 502);
        }
        const next = validateRemoteUrl(new URL(result.headers.location, url));
        if (url.protocol === "https:" && next.protocol !== "https:") throw new SafeHttpError("La redirección no es segura.", 502);
        url = next;
      }
    } catch (error) {
      if (signal.aborted) throw aborted();
      if (error instanceof SafeHttpError) throw error;
      throw new SafeHttpError("No se pudo obtener el contenido remoto.", 502);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  };
}

export const readRemote = createRemoteReader();
