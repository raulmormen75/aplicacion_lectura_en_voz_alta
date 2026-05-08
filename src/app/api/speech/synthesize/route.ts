import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_VOICE_ID, getVoiceById } from "@/lib/reader/voices";
import { countWords, estimateRemainingSeconds } from "@/lib/reader/text";
import {
  getAzureMonthlyCharacterLimit,
  incrementServerAzureUsage,
  readServerAzureUsage,
} from "@/lib/reader/serverVoiceUsage";
import type { CloudSpeechUsage } from "@/lib/reader/cloudSpeechUsage";
import type { ReaderVoice } from "@/lib/reader/types";

export const runtime = "nodejs";

const speechSchema = z.object({
  text: z.string().min(1),
  voiceId: z.string().optional(),
  rate: z.union([z.literal(1), z.literal(0.75), z.literal(0.5)]),
  usage: z
    .object({
      monthKey: z.string().optional(),
      azureCharacters: z.number().nonnegative().optional(),
    })
    .optional(),
});

type ProviderResult =
  | {
      provider: "azure";
      audioBuffer: Buffer;
      mimeType: "audio/mpeg";
      usage?: CloudSpeechUsage;
      usageSource: "server" | "local";
    }
  | {
      provider: "browser";
      reason: string;
      usage?: CloudSpeechUsage;
      usageSource: "server" | "local";
    };

let azureTokenCache: { token: string; expiresAt: number } | null = null;

export async function POST(request: Request) {
  const payload = speechSchema.parse(await request.json());
  const voice = getVoiceById(payload.voiceId ?? DEFAULT_VOICE_ID);
  const text = payload.text.trim();
  const characterCount = text.length;
  const wordCount = countWords(text);
  const estimatedSeconds = estimateRemainingSeconds(wordCount, 0, payload.rate);
  const wordTimings = buildEstimatedTimings(text, estimatedSeconds);

  const providerResult = await synthesizeWithAzureLimit({
    text,
    voice,
    rate: payload.rate,
    characterCount,
    clientAzureCharacters: payload.usage?.azureCharacters ?? 0,
  });

  if (providerResult.provider === "browser") {
    return NextResponse.json({
      mode: "browser-fallback",
      provider: "browser",
      message: providerResult.reason,
      voice,
      characterCount,
      estimatedSeconds,
      wordTimings,
      usage: providerResult.usage,
      usageSource: providerResult.usageSource,
    });
  }

  return NextResponse.json({
    mode: "cloud-audio",
    provider: "azure",
    voice,
    characterCount,
    estimatedSeconds,
    wordTimings,
    audioBase64: providerResult.audioBuffer.toString("base64"),
    mimeType: providerResult.mimeType,
    usage: providerResult.usage,
    usageSource: providerResult.usageSource,
  });
}

async function synthesizeWithAzureLimit(params: {
  text: string;
  voice: ReaderVoice;
  rate: 1 | 0.75 | 0.5;
  characterCount: number;
  clientAzureCharacters: number;
}): Promise<ProviderResult> {
  const azureConfigured = Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
  const azureLimit = getAzureMonthlyCharacterLimit();
  let serverUsage: Awaited<ReturnType<typeof readServerAzureUsage>>;

  try {
    serverUsage = await readServerAzureUsage();
  } catch {
    return {
      provider: "browser",
      reason:
        "No se pudo verificar el contador mensual global de Azure. Se usará la voz del navegador para evitar consumo de pago.",
      usageSource: "server",
    };
  }

  const usageSource = serverUsage.configured ? "server" : "local";
  const currentAzureCharacters = serverUsage.configured
    ? serverUsage.usage.azureCharacters
    : params.clientAzureCharacters;
  const nextAzureCharacters = currentAzureCharacters + params.characterCount;

  if (!azureConfigured) {
    return {
      provider: "browser",
      reason: "Azure Speech no está configurado. Se usará la voz del navegador.",
      usage: serverUsage.usage,
      usageSource,
    };
  }

  if (nextAzureCharacters > azureLimit) {
    return {
      provider: "browser",
      reason: `Se alcanzó el límite mensual configurado de Azure (${azureLimit.toLocaleString(
        "es-MX",
      )} caracteres). Se usará la voz del navegador para evitar consumo de pago.`,
      usage: {
        ...serverUsage.usage,
        azureCharacters: currentAzureCharacters,
        source: usageSource,
      },
      usageSource,
    };
  }

  try {
    const audioBuffer = await synthesizeAzure(params.text, params.voice, params.rate);
    const usage = serverUsage.configured
      ? await incrementServerAzureUsage(params.characterCount)
      : {
          ...serverUsage.usage,
          azureCharacters: nextAzureCharacters,
          updatedAt: new Date().toISOString(),
          source: "local" as const,
        };

    return {
      provider: "azure",
      audioBuffer,
      mimeType: "audio/mpeg",
      usage: usage ?? undefined,
      usageSource,
    };
  } catch {
    return {
      provider: "browser",
      reason:
        "Azure Speech no respondió correctamente. Se usará la voz del navegador para continuar la lectura.",
      usage: serverUsage.usage,
      usageSource,
    };
  }
}

async function synthesizeAzure(text: string, voice: ReaderVoice, rate: 1 | 0.75 | 0.5) {
  const speechRegion = process.env.AZURE_SPEECH_REGION;
  const accessToken = await getAzureAccessToken();

  if (!speechRegion || !accessToken) {
    throw new Error("Azure Speech no está configurado.");
  }

  const ssml = buildAzureScienceSsml(text, voice.azureName, rate, voice.locale);
  const response = await fetch(
    `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "LectorDocumentalRaul",
      },
      body: ssml,
    },
  );

  if (!response.ok) {
    throw new Error(`Azure Speech respondió con ${response.status}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function getAzureAccessToken() {
  if (azureTokenCache && azureTokenCache.expiresAt > Date.now() + 60_000) {
    return azureTokenCache.token;
  }

  const speechKey = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION;

  if (!speechKey || !speechRegion) return null;

  const response = await fetch(
    `https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Ocp-Apim-Subscription-Key": speechKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`No se pudo obtener token de Azure Speech: ${response.status}.`);
  }

  const token = await response.text();
  azureTokenCache = {
    token,
    expiresAt: Date.now() + 9 * 60 * 1000,
  };

  return token;
}

function buildAzureScienceSsml(text: string, voiceName: string, rate: number, locale: string) {
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
