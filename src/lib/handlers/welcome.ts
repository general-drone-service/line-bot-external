import { push } from "@/lib/line"
import type { LineMessage } from "@/lib/line"
import { quickReply } from "@/lib/line"

export async function handleFollow(userId: string) {
  const messages: LineMessage[] = [
    {
      type: "text",
      text:
        "歡迎加入 GDS 低空作業官方帳號！🚁\n\n" +
        "我是 AI 智慧客服，可以隨時為您服務：\n\n" +
        "想了解服務內容或費用？直接問我就好！\n" +
        "有報價編號？傳給我立即查詢報價單。\n" +
        "也可以傳建築照片，我幫您初步評估。\n\n" +
        "請問有什麼可以幫您的呢？",
      quickReply: quickReply(["我想報價", "服務項目", "外牆巡檢", "聯絡方式"]),
    },
  ]
  await push(userId, messages)
}
