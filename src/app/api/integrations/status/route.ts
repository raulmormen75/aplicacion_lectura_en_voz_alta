import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    gptOssReady: Boolean(process.env.GPT_OSS_ENDPOINT),
  });
}
