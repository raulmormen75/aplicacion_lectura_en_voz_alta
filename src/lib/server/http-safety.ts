import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export class SafeHttpError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const MAX_REQUEST_BYTES = 4_000_000;
export const MAX_TEXT_CHARS = 300_000;

export async function readBoundedBody(request: Request, limit = MAX_REQUEST_BYTES) {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw new SafeHttpError("La solicitud supera el tamaño permitido.", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SafeHttpError("Se agotó el tiempo de la solicitud.", 408));
      void reader.cancel().catch(() => {});
    }, 15_000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new SafeHttpError("La solicitud supera el tamaño permitido.", 413);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
    const signal = controller.signal;
    const aborted = () => new SafeHttpError("Se agotó el tiempo de conexión.", 504);
    const abortable = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const onAbort = () => reject(aborted());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      if (signal.aborted) onAbort();
    });
    try {
      let url = validateRemoteUrl(input);
      for (let hop = 0; ; hop++) {
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
    }
  };
}

export const readRemote = createRemoteReader();
