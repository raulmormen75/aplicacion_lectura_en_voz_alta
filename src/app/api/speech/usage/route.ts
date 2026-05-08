import { NextResponse } from "next/server";
import { getAzureMonthlyCharacterLimit, readServerAzureUsage } from "@/lib/reader/serverVoiceUsage";

export const runtime = "nodejs";

export async function GET() {
  const serverUsage = await readServerAzureUsage().catch(() => null);

  return NextResponse.json({
    configured: Boolean(serverUsage?.configured),
    usage: serverUsage?.usage,
    limits: {
      billingPeriod: "calendar-month",
      azureMonthlyCharacters: getAzureMonthlyCharacterLimit(),
    },
  });
}
