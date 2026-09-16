import { NextResponse } from "next/server";
import { z } from "zod";
import { cleanTextWithoutInventing, createLegibleReconstructionPrompt } from "@/lib/reader/text";
import { readBoundedJson, readRemote, SafeHttpError } from "@/lib/server/http-safety";

export const runtime = "nodejs";

const reconstructSchema = z.object({ text: z.string().trim().min(1).max(24_000) });
const outputSchema = z.object({
  text: z.string().optional(),
  output: z.string().optional(),
  finish_reason: z.string().nullable().optional(),
  choices: z.array(z.object({
    text: z.string().optional(),
    message: z.object({ content: z.string().nullable().optional() }).optional(),
    finish_reason: z.string().nullable().optional(),
  })).optional(),
});

export async function POST(request: Request) {
  let text: string;
  try {
    ({ text } = reconstructSchema.parse(await readBoundedJson(request, 100_000)));
  } catch (error) {
    return NextResponse.json({ error: error instanceof SafeHttpError ? error.message : "Envía texto válido de hasta 24,000 caracteres." },
      { status: error instanceof SafeHttpError ? error.status : error instanceof z.ZodError && error.issues.some((issue) => issue.code === "too_big") ? 413 : 400 });
  }
  const fallback = (message: string) => NextResponse.json({
    mode: "clean-only", message, text: cleanTextWithoutInventing(text),
  }, { headers: { "cache-control": "no-store" } });
  const endpoint = process.env.GPT_OSS_ENDPOINT;
  if (!endpoint) return fallback("No hay IA configurada. Se aplicó limpieza local.");

  try {
    const response = await readRemote(endpoint, {
      method: "POST", trustedEndpoint: true, maxRedirects: 0,
      timeoutMs: 20_000, maxBytes: 200_000,
      allowedContentTypes: ["application/json"],
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: createLegibleReconstructionPrompt(text), temperature: 0.1, max_tokens: 4096 }),
    });
    if (response.status < 200 || response.status >= 300) throw new Error("upstream");
    const data = outputSchema.parse(JSON.parse(response.body.toString("utf8")));
    const reason = data.choices?.[0]?.finish_reason ?? data.finish_reason;
    if (reason && !["stop", "eos", "end_turn"].includes(reason)) throw new Error("incomplete");
    const reconstructed = (data.text ?? data.output ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? "").trim();
    if (!reconstructed || reconstructed.length > 48_000) throw new Error("invalid output");
    return NextResponse.json({ mode: "reconstructed", message: "Texto reconstruido con IA configurada. Revisa el resultado.", text: reconstructed },
      { headers: { "cache-control": "no-store" } });
  } catch {
    return fallback("La IA no devolvió un resultado completo y válido. Se aplicó limpieza local.");
  }
}
