import { readBoundedJson, SafeHttpError } from "@/lib/server/http-safety";
import { acquireApiRequest, RequestGuardError, requestErrorHeaders } from "@/lib/server/request-guard";
import { HF_VOICES, huggingFaceSpeech } from "@/lib/server/huggingface-speech";
import type { RemoteVoiceId } from "@/lib/reader/speech-buffer";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    release = acquireApiRequest(request, {
      scope: "speech", contentTypes: ["application/json"], maxBodyBytes: 5000,
      maxRequests: 24, windowMs: 60_000, maxConcurrent: 4, maxGlobalRequests: 72,
    });
    const input = await readBoundedJson(request, 5000) as { voice?: unknown; text?: unknown } | null;
    if (!input || (input.voice !== "hf-mexico" && input.voice !== "hf-dora") || typeof input.text !== "string" ||
      !input.text.trim() || input.text.length > HF_VOICES[input.voice].maxChars) {
      throw new SafeHttpError("Selecciona una voz válida y un fragmento breve.", 400);
    }
    const audio = await huggingFaceSpeech(input.voice as RemoteVoiceId, input.text, request.signal);
    return new Response(new Uint8Array(audio), { headers: {
      "content-type": "audio/wav", "cache-control": "no-store", "x-content-type-options": "nosniff",
    } });
  } catch (error) {
    const status = error instanceof SafeHttpError || error instanceof RequestGuardError ? error.status : 503;
    const message = error instanceof SafeHttpError || error instanceof RequestGuardError
      ? error.message : "La demo de Hugging Face no está disponible. Puedes continuar con una voz del dispositivo.";
    return Response.json({ error: message }, { status, headers: requestErrorHeaders(error) });
  } finally { release?.(); }
}
