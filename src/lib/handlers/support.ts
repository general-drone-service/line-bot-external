import { reply } from "@/lib/line"
import type { LineMessage } from "@/lib/line"

export async function handleSupport(replyToken: string) {
  const messages: LineMessage[] = [
    {
      type: "text",
      text:
        "👋 客服支援\n\n" +
        "感謝您的聯繫！我們的客服團隊將盡快回覆您。\n\n" +
        "服務時間：週一至週五 09:00–18:00\n" +
        "您也可以來電：(02) XXXX-XXXX",
    },
  ]
  await reply(replyToken, messages)
}
