import {
  DEFAULT_AZURE_TTS_MONTHLY_LIMIT,
  getCloudSpeechUsageWindow,
  type CloudSpeechUsage,
} from "./cloudSpeechUsage";

type RedisClient = {
  url: string;
  token: string;
};

type RedisNumberResponse = {
  result?: number | string | null;
};

const KEY_PREFIX = "lector-documental-raul:azure-tts";

export function getAzureMonthlyCharacterLimit() {
  const value = Number(process.env.AZURE_TTS_MONTHLY_CHARACTER_LIMIT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_AZURE_TTS_MONTHLY_LIMIT;
}

export async function readServerAzureUsage(date = new Date()) {
  const client = getRedisClient();
  const usageWindow = getCloudSpeechUsageWindow(date);

  if (!client) {
    return {
      configured: false,
      usage: {
        monthKey: usageWindow.monthKey,
        azureCharacters: 0,
        updatedAt: new Date(0).toISOString(),
        source: "local",
      } satisfies CloudSpeechUsage,
    };
  }

  const value = await redisCommand<number | string | null>(client, [
    "GET",
    getAzureUsageKey(usageWindow.monthKey),
  ]);

  return {
    configured: true,
    usage: {
      monthKey: usageWindow.monthKey,
      azureCharacters: Number(value ?? 0),
      updatedAt: new Date().toISOString(),
      source: "server",
    } satisfies CloudSpeechUsage,
  };
}

export async function incrementServerAzureUsage(characters: number, date = new Date()) {
  const client = getRedisClient();
  if (!client) return null;

  const usageWindow = getCloudSpeechUsageWindow(date);
  const key = getAzureUsageKey(usageWindow.monthKey);
  const nextValue = await redisCommand<number | string>(client, [
    "INCRBY",
    key,
    String(characters),
  ]);
  await redisCommand<number | string>(client, [
    "EXPIRE",
    key,
    String(secondsUntil(usageWindow.endExclusive)),
  ]);

  return {
    monthKey: usageWindow.monthKey,
    azureCharacters: Number(nextValue ?? 0),
    updatedAt: new Date().toISOString(),
    source: "server",
  } satisfies CloudSpeechUsage;
}

function getAzureUsageKey(monthKey: string) {
  return `${process.env.VOICE_USAGE_REDIS_PREFIX ?? KEY_PREFIX}:${monthKey}`;
}

function getRedisClient(): RedisClient | null {
  const url =
    process.env.VOICE_USAGE_REDIS_REST_URL ??
    process.env.KV_REST_API_URL ??
    process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.VOICE_USAGE_REDIS_REST_TOKEN ??
    process.env.KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

async function redisCommand<T>(client: RedisClient, command: string[]) {
  const response = await fetch(`${client.url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([command]),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`No se pudo leer el contador mensual de Azure: ${response.status}.`);
  }

  const data = (await response.json()) as RedisNumberResponse[];
  return data[0]?.result as T;
}

function secondsUntil(date: Date) {
  return Math.max(60, Math.ceil((date.getTime() - Date.now()) / 1000));
}
