import { NextResponse } from "next/server";
import { z } from "zod";
import { cleanTextWithoutInventing, createLegibleReconstructionPrompt } from "@/lib/reader/text";

export const runtime = "nodejs";

const reconstructSchema = z.object({
  text: z.string().min(1),
});

export async function POST(request: Request) {
  const { text } = reconstructSchema.parse(await request.json());
  const endpoint = process.env.GPT_OSS_ENDPOINT;
  const prompt = createLegibleReconstructionPrompt(text);

  if (!endpoint) {
    return NextResponse.json({
      mode: "clean-only",
      message:
        "No hay IA ligera configurada. Se aplicó limpieza local sin inventar contenido.",
      text: cleanTextWithoutInventing(text),
    });
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    return NextResponse.json({
      mode: "clean-only",
      message:
        "La IA ligera no respondió. Se aplicó limpieza local sin inventar contenido.",
      text: cleanTextWithoutInventing(text),
    });
  }

  const data = (await response.json()) as {
    text?: string;
    output?: string;
    choices?: Array<{ text?: string; message?: { content?: string } }>;
  };
  const reconstructed =
    data.text ??
    data.output ??
    data.choices?.[0]?.message?.content ??
    data.choices?.[0]?.text ??
    "";

  return NextResponse.json({
    mode: "reconstructed",
    message: "Texto reconstruido con IA ligera configurada.",
    text: reconstructed.trim() || cleanTextWithoutInventing(text),
  });
}
