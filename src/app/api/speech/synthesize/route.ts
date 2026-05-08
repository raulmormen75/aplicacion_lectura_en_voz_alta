import { createSign } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  DEFAULT_AZURE_TTS_MONTHLY_LIMIT,
  DEFAULT_GOOGLE_TTS_MONTHLY_LIMIT,
} from "@/lib/reader/cloudSpeechUsage";
import { DEFAULT_VOICE_ID, getVoiceById } from "@/lib/reader/voices";
import { countWords, estimateRemainingSeconds } from "@/lib/reader/text";
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
      googleCharacters: z.number().nonnegative().optional(),
    })
    .optional(),
});

type ProviderResult =
  | {
      provider: "azure" | "google";
      audioBuffer: Buffer;
      mimeType: "audio/mpeg";
    }
  | {
      provider: "browser";
      reason: string;
    };

type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

let azureTokenCache: { token: string; expiresAt: number } | null = null;
let googleTokenCache: { token: string; expiresAt: number } | null = null;

export async function POST(request: Request) {
  const payload = speechSchema.parse(await request.json());
  const voice = getVoiceById(payload.voiceId ?? DEFAULT_VOICE_ID);
  const text = payload.text.trim();
  const characterCount = text.length;
  const wordCount = countWords(text);
  const estimatedSeconds = estimateRemainingSeconds(wordCount, 0, payload.rate);
  const wordTimings = buildEstimatedTimings(text, estimatedSeconds);

  const providerResult = await synthesizeWithFallback({
    text,
    voice,
    rate: payload.rate,
    characterCount,
    usage: {
      azureCharacters: payload.usage?.azureCharacters ?? 0,
      googleCharacters: payload.usage?.googleCharacters ?? 0,
    },
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
    });
  }

  return NextResponse.json({
    mode: "cloud-audio",
    provider: providerResult.provider,
    voice,
    characterCount,
    estimatedSeconds,
    wordTimings,
    audioBase64: providerResult.audioBuffer.toString("base64"),
    mimeType: providerResult.mimeType,
  });
}

async function synthesizeWithFallback(params: {
  text: string;
  voice: ReaderVoice;
  rate: 1 | 0.75 | 0.5;
  characterCount: number;
  usage: {
    azureCharacters: number;
    googleCharacters: number;
  };
}): Promise<ProviderResult> {
  const azureConfigured = Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
  const googleConfigured = Boolean(getGoogleServiceAccount());
  const azureLimit = readLimit("AZURE_TTS_MONTHLY_CHARACTER_LIMIT", DEFAULT_AZURE_TTS_MONTHLY_LIMIT);
  const googleLimit = readLimit(
    "GOOGLE_TTS_MONTHLY_CHARACTER_LIMIT",
    DEFAULT_GOOGLE_TTS_MONTHLY_LIMIT,
  );
  const azureBudgetAvailable =
    azureConfigured && params.usage.azureCharacters + params.characterCount <= azureLimit;
  const googleBudgetAvailable =
    googleConfigured && params.usage.googleCharacters + params.characterCount <= googleLimit;
  const fallbackContext = {
    azureConfigured,
    googleConfigured,
    azureLimit,
    googleLimit,
    azureLimitReached: azureConfigured && !azureBudgetAvailable,
    googleLimitReached: googleConfigured && !googleBudgetAvailable,
  };

  if (azureBudgetAvailable) {
    try {
      const audioBuffer = await synthesizeAzure(params.text, params.voice, params.rate);
      return { provider: "azure", audioBuffer, mimeType: "audio/mpeg" };
    } catch {
      if (googleBudgetAvailable) {
        try {
          const audioBuffer = await synthesizeGoogle(params.text, params.voice, params.rate);
          return { provider: "google", audioBuffer, mimeType: "audio/mpeg" };
        } catch {
          return browserFallbackReason(fallbackContext);
        }
      }

      return browserFallbackReason(fallbackContext);
    }
  }

  if (googleBudgetAvailable) {
    try {
      const audioBuffer = await synthesizeGoogle(params.text, params.voice, params.rate);
      return { provider: "google", audioBuffer, mimeType: "audio/mpeg" };
    } catch {
      return browserFallbackReason(fallbackContext);
    }
  }

  return browserFallbackReason(fallbackContext);
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

async function synthesizeGoogle(text: string, voice: ReaderVoice, rate: 1 | 0.75 | 0.5) {
  const accessToken = await getGoogleAccessToken();

  if (!accessToken) {
    throw new Error("Google Cloud Text-to-Speech no está configurado.");
  }

  const response = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        text,
      },
      voice: {
        languageCode: voice.googleLocale,
        name: voice.googleName,
      },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: rate,
        pitch: 0,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Google Cloud Text-to-Speech respondió con ${response.status}.`);
  }

  const data = (await response.json()) as { audioContent?: string };
  if (!data.audioContent) {
    throw new Error("Google Cloud Text-to-Speech no devolvió audio.");
  }

  return Buffer.from(data.audioContent, "base64");
}

async function getGoogleAccessToken() {
  if (googleTokenCache && googleTokenCache.expiresAt > Date.now() + 60_000) {
    return googleTokenCache.token;
  }

  const serviceAccount = getGoogleServiceAccount();
  if (!serviceAccount) return null;

  const tokenUri = serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const assertion = signGoogleJwt(
    {
      alg: "RS256",
      typ: "JWT",
    },
    {
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    },
    serviceAccount.private_key,
  );

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`No se pudo obtener token de Google Cloud: ${response.status}.`);
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Google Cloud no devolvió access_token.");
  }

  googleTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, (data.expires_in ?? 3600) - 60) * 1000,
  };

  return data.access_token;
}

function getGoogleServiceAccount() {
  const rawJson =
    process.env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON ??
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ??
    null;

  if (!rawJson) return null;

  try {
    const normalized = rawJson.trim().startsWith("{")
      ? rawJson
      : Buffer.from(rawJson, "base64").toString("utf8");
    const parsed = JSON.parse(normalized) as Partial<GoogleServiceAccount>;

    if (!parsed.client_email || !parsed.private_key) return null;

    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key.replace(/\\n/g, "\n"),
      token_uri: parsed.token_uri,
    } satisfies GoogleServiceAccount;
  } catch {
    return null;
  }
}

function signGoogleJwt(
  header: Record<string, string>,
  payload: Record<string, string | number>,
  privateKey: string,
) {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const sign = createSign("RSA-SHA256");
  sign.update(`${encodedHeader}.${encodedPayload}`);
  sign.end();
  const signature = sign.sign(privateKey);

  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
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

function browserFallbackReason(context: {
  azureConfigured: boolean;
  googleConfigured: boolean;
  azureLimit: number;
  googleLimit: number;
  azureLimitReached: boolean;
  googleLimitReached: boolean;
}) {
  if (!context.azureConfigured && !context.googleConfigured) {
    return {
      provider: "browser",
      reason:
        "No hay credenciales de Azure Speech ni Google Cloud Text-to-Speech. Se usará la voz del navegador.",
    } satisfies ProviderResult;
  }

  if (context.azureLimitReached && context.googleLimitReached) {
    return {
      provider: "browser",
      reason: `Se alcanzó el presupuesto mensual configurado de Azure (${context.azureLimit.toLocaleString(
        "es-MX",
      )} caracteres) y Google (${context.googleLimit.toLocaleString(
        "es-MX",
      )} caracteres). Se usará la voz del navegador.`,
    } satisfies ProviderResult;
  }

  if (context.azureLimitReached && !context.googleConfigured) {
    return {
      provider: "browser",
      reason:
        "Se alcanzó el presupuesto mensual configurado de Azure y Google Cloud no está configurado. Se usará la voz del navegador.",
    } satisfies ProviderResult;
  }

  if (!context.azureConfigured && context.googleLimitReached) {
    return {
      provider: "browser",
      reason:
        "Google Cloud llegó al presupuesto mensual configurado y Azure Speech no está configurado. Se usará la voz del navegador.",
    } satisfies ProviderResult;
  }

  return {
    provider: "browser",
    reason:
      "La síntesis cloud no respondió correctamente. Se usará la voz del navegador para continuar la lectura.",
  } satisfies ProviderResult;
}

function readLimit(envName: string, fallback: number) {
  const value = Number(process.env[envName]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
