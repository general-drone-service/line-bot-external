import { reply } from "@/lib/line"
import type { LineMessage } from "@/lib/line"

export async function handleUnknown(replyToken: string) {
  const messages: LineMessage[] = [
    {
      type: "text",
      text:
        "您好！我可以協助您：\n\n" +
        "📋 查詢報價 → 傳送報價編號（如 Q-20260323-456）\n" +
        "📅 預約施工 → 傳送「預約」\n" +
        "🔍 查詢進度 → 傳送「進度」\n" +
        "👋 聯繫客服 → 傳送「客服」",
    },
  ]
  await reply(replyToken, messages)
}
