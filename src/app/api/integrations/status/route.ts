import { NextResponse } from "next/server";
import { DEFAULT_AZURE_TTS_MONTHLY_LIMIT } from "@/lib/reader/cloudSpeechUsage";

export function GET() {
  return NextResponse.json({
    azureReady: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
    gptOssReady: Boolean(process.env.GPT_OSS_ENDPOINT),
    ttsLimits: {
      billingPeriod: "calendar-month",
      azureMonthlyCharacters: readLimit(
        "AZURE_TTS_MONTHLY_CHARACTER_LIMIT",
        DEFAULT_AZURE_TTS_MONTHLY_LIMIT,
      ),
    },
  });
}

function readLimit(envName: string, fallback: number) {
  const value = Number(process.env[envName]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
