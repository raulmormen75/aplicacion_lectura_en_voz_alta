import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    googleReady: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    azureReady: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
    gptOssReady: Boolean(process.env.GPT_OSS_ENDPOINT),
  });
}
