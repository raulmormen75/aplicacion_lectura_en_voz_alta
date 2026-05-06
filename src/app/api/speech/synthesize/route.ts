import { NextResponse } from "next/server";
import { z } from "zod";
import { getVoiceById } from "@/lib/reader/voices";
import { countWords, estimateRemainingSeconds } from "@/lib/reader/text";

export const runtime = "nodejs";

const speechSchema = z.object({
  text: z.string().min(1),
  voiceId: z.string(),
  rate: z.union([z.literal(1), z.literal(0.75), z.literal(0.5)]),
});

export async function POST(request: Request) {
  const payload = speechSchema.parse(await request.json());
  const voice = getVoiceById(payload.voiceId);
  const wordCount = countWords(payload.text);
  const estimatedSeconds = estimateRemainingSeconds(wordCount, 0, payload.rate);
  const wordTimings = buildEstimatedTimings(payload.text, estimatedSeconds);

  const speechKey = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION;

  if (!speechKey || !speechRegion) {
    return NextResponse.json({
      mode: "browser-fallback",
      message:
        "Azure Speech no está configurado. La app usará la voz disponible en el navegador para esta prueba.",
      voice,
      estimatedSeconds,
      wordTimings,
    });
  }

  const ssml = buildScienceSsml(payload.text, voice.azureName, payload.rate, voice.locale);
  const response = await fetch(
    `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": speechKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "LectorDocumentalRaul",
      },
      body: ssml,
    },
  );

  if (!response.ok) {
    return NextResponse.json(
      {
        mode: "browser-fallback",
        message: "Azure Speech no respondió correctamente. Se usará la lectura del navegador.",
        voice,
        estimatedSeconds,
        wordTimings,
      },
      { status: 200 },
    );
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  return NextResponse.json({
    mode: "azure",
    voice,
    estimatedSeconds,
    wordTimings,
    audioBase64: audioBuffer.toString("base64"),
    mimeType: "audio/mpeg",
  });
}

function buildScienceSsml(text: string, voiceName: string, rate: number, locale: string) {
  const ratePercent = rate === 1 ? "0%" : rate === 0.75 ? "-25%" : "-50%";
  return `
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">
  <voice name="${escapeXml(voiceName)}">
    <prosody rate="${ratePercent}" pitch="+0%" volume="+0%">
      <mstts:express-as xmlns:mstts="https://www.w3.org/2001/mstts" style="chat">
        ${escapeXml(text)}
      </mstts:express-as>
    </prosody>
  </voice>
</speak>`.trim();
}

function buildEstimatedTimings(text: string, estimatedSeconds: number) {
  const words = text.match(/[\p{L}\p{M}\p{N}]+(?:['’´-][\p{L}\p{M}\p{N}]+)*/gu) ?? [];
  const average = words.length > 0 ? estimatedSeconds / words.length : 0;
  let current = 0;

  return words.map((word, index) => {
    const start = current;
    const duration = Math.max(0.18, Math.min(1.2, average * (word.length > 9 ? 1.18 : 1)));
    current += duration;
    return {
      word,
      index,
      startSeconds: Number(start.toFixed(2)),
      durationSeconds: Number(duration.toFixed(2)),
    };
  });
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
