import { readRemote, SafeHttpError } from "@/lib/server/http-safety";
import type { RemoteVoiceId } from "@/lib/reader/speech-buffer";

export const HF_VOICES = {
  "hf-mexico": { origin: "https://resembleai-chatterbox-multilingual-tts-es-mx-latam.hf.space", endpoint: "generate_tts_audio", maxChars: 280 },
  "hf-dora": { origin: "https://leonelhs-kokoro-tts-spanish.hf.space", endpoint: "predict", maxChars: 720 },
} as const;

export function parseGradioResult(sse: string): unknown[] {
  for (const event of sse.replace(/\r\n/g, "\n").split("\n\n")) {
    const lines = event.split("\n");
    const name = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    if (name === "error") throw new SafeHttpError("La demo de voz no pudo generar el fragmento. Prueba una voz del dispositivo.", 503);
    if (name !== "complete") continue;
    const data = JSON.parse(lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"));
    if (Array.isArray(data)) return data;
  }
  throw new SafeHttpError("La demo no terminó de preparar el audio. Prueba una voz del dispositivo.", 503);
}

export function validateAudioUrl(value: unknown, origin: string): string {
  if (typeof value !== "string" || value.length > 2048) throw new SafeHttpError("La demo no devolvió un archivo de audio válido.", 502);
  const url = new URL(value, origin);
  if (url.origin !== origin || url.username || url.password || !url.pathname.startsWith("/gradio_api/file=")) {
    throw new SafeHttpError("La dirección del audio no está permitida.", 502);
  }
  return url.href;
}

export function validateSpeechWav(bytes: Buffer): void {
  const invalid = () => new SafeHttpError("La demo no devolvió audio WAV completo y compatible.", 502);
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
  let blockAlign = 0;
  let dataSize = 0;
  let chunks = 0;
  for (let cursor = 12; cursor < bytes.length;) {
    if (++chunks > 128 || cursor + 8 > bytes.length) throw invalid();
    const id = bytes.toString("ascii", cursor, cursor + 4);
    const size = bytes.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    const end = start + size;
    if (end + (size % 2) > bytes.length) throw invalid();
    if (id === "fmt ") {
      if (blockAlign || size < 16) throw invalid();
      const format = bytes.readUInt16LE(start);
      const channels = bytes.readUInt16LE(start + 2);
      const sampleRate = bytes.readUInt32LE(start + 4);
      const byteRate = bytes.readUInt32LE(start + 8);
      blockAlign = bytes.readUInt16LE(start + 12);
      const bits = bytes.readUInt16LE(start + 14);
      if (format !== 1 || (channels !== 1 && channels !== 2) || bits !== 16 ||
        sampleRate < 8000 || sampleRate > 96000 || blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign) throw invalid();
    }
    if (id === "data") {
      if (dataSize || !size) throw invalid();
      dataSize = size;
    }
    cursor = end + size % 2;
  }
  if (!blockAlign || !dataSize || dataSize % blockAlign !== 0) throw invalid();
}

// No text or audio is retained on this server. Only public reference metadata is reused.
export function createHuggingFaceSpeech(reader = readRemote) {
  let reference: { value: Record<string, unknown>; expires: number } | undefined;
  return async (voice: RemoteVoiceId, text: string, signal?: AbortSignal) => {
    const config = HF_VOICES[voice];
    if (!config || !text.trim() || text.length > config.maxChars) throw new SafeHttpError("El fragmento supera el límite de esta voz.", 400);
    const deadline = Date.now() + 42_000;
    const get = (url: string, options: Parameters<typeof readRemote>[1] = {}) => {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw new SafeHttpError("La demo tardó demasiado. Prueba una voz del dispositivo.", 504);
      return reader(url, { ...options, maxRedirects: 0, timeoutMs, signal });
    };
    let data: unknown[] = [text, "ef_dora", 1];
    if (voice === "hf-mexico") {
      if (!reference || reference.expires < Date.now()) {
        const response = await get(`${config.origin}/config`, { maxBytes: 500_000, allowedContentTypes: ["application/json"] });
        const parsed = JSON.parse(response.body.toString("utf8")) as { components?: Array<{ type?: string; props?: { label?: string; value?: Record<string, unknown> } }> };
        const value = parsed.components?.find(item => item.type === "audio" && item.props?.label === "Reference Audio File (Optional)")?.props?.value;
        if (!value || value.meta && (value.meta as { _type?: string })._type !== "gradio.FileData") {
          throw new SafeHttpError("La referencia mexicana de la demo no está disponible.", 503);
        }
        validateAudioUrl(value.url, config.origin);
        reference = { value, expires: Date.now() + 30 * 60_000 };
      }
      data = [text, reference.value, 0.5, 0.8, 0, 0.5];
    }
    const base = `${config.origin}/gradio_api/call/${config.endpoint}`;
    const started = await get(base, {
      method: "POST", body: JSON.stringify({ data }), headers: { "content-type": "application/json" },
      maxBytes: 8192, allowedContentTypes: ["application/json"],
    });
    const event = JSON.parse(started.body.toString("utf8")) as { event_id?: string };
    if (typeof event.event_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.event_id)) {
      throw new SafeHttpError("La demo rechazó la solicitud de audio.", 503);
    }
    const completed = await get(`${base}/${event.event_id}`, { maxBytes: 128_000, allowedContentTypes: ["text/event-stream"] });
    const output = parseGradioResult(completed.body.toString("utf8"))[0] as { url?: unknown; is_stream?: boolean } | null;
    if (!output || output.is_stream) throw new SafeHttpError("La demo devolvió un formato inesperado.", 502);
    const audio = await get(validateAudioUrl(output.url, config.origin), {
      maxBytes: 5 * 1024 * 1024, allowedContentTypes: ["application/octet-stream", "audio/wav", "audio/x-wav"],
    });
    validateSpeechWav(audio.body);
    return audio.body;
  };
}

export const huggingFaceSpeech = createHuggingFaceSpeech();
