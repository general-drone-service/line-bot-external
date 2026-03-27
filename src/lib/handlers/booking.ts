import { reply } from "@/lib/line"
import type { LineMessage } from "@/lib/line"

export async function handleBooking(replyToken: string) {
  const messages: LineMessage[] = [
    {
      type: "text",
      text:
        "📅 預約施工服務\n\n" +
        "請提供以下資訊，我們將盡快為您安排：\n" +
        "1. 施工地址\n" +
        "2. 希望日期與時段\n" +
        "3. 聯絡電話\n\n" +
        "或致電 (02) XXXX-XXXX 由專人為您服務。",
    },
  ]
  await reply(replyToken, messages)
}
