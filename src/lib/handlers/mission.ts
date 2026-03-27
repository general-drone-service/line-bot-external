import { reply } from "@/lib/line"
import type { LineMessage } from "@/lib/line"

export async function handleMissionStatus(replyToken: string) {
  const messages: LineMessage[] = [
    {
      type: "text",
      text:
        "🔍 任務進度查詢\n\n" +
        "請提供您的報價編號（如 Q-20260323-456），\n" +
        "我們將為您查詢施工進度。\n\n" +
        "如有急件，請直接聯繫客服。",
    },
  ]
  await reply(replyToken, messages)
}
