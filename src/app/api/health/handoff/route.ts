import { NextResponse } from "next/server"
import { rejectUnlessBearer } from "@/lib/services/bearer-auth"
import { requestHumanHandoff } from "@/lib/services/notify"

/**
 * Sends one human handoff alert with fixed test data, so the Worker's alert secrets and manager-line
 * can be checked without a customer, the database or Anthropic. Every call pushes a LINE message to
 * Teddy and uses the hourly alert quota: run it only when checking the channel.
 * Requires `Authorization: Bearer $BOT_PAUSE_API_TOKEN`.
 */
export async function POST(request: Request) {
  const rejected = rejectUnlessBearer(request, process.env.BOT_PAUSE_API_TOKEN, "Health API")
  if (rejected) return rejected

  const delivered = await requestHumanHandoff({
    userId: "TEST-e2e",
    reason: "端到端測試，請忽略",
    lastMessages: ["user: 測試訊息，不是客戶", "assistant: 測試回覆"],
  })
  return NextResponse.json({ delivered }, { status: delivered ? 200 : 502 })
}
