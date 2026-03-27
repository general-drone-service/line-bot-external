import { getAnthropicClient } from "./client"
import { reply } from "@/lib/line"
import type { LineMessage } from "@/lib/line"
import { quickReply } from "@/lib/line"
import { loadHistory, saveMessage } from "./history"

const IMAGE_PROMPT = `你是 GDS 低空作業（一般無人機服務）的專業顧問。客戶傳了一張建築物的照片。

請分析這張照片並提供：
1. 建築類型判斷（住宅、商辦、廠房、透天厝等）
2. 外牆材質觀察（磁磚、石材、玻璃帷幕、金屬等）
3. 可見的污染或損壞狀況（灰塵、水垢、青苔、磁磚剝落等）
4. 初步建議（適合的服務類型）

用繁體中文、簡潔專業的語氣回覆，150 字以內。
回覆是純文字，禁止使用 Markdown 格式（**粗體**等）。
最後問客戶是否需要進一步報價或安排免費現場勘查。
在最後加上 [QUICK_REPLY:我想報價,預約勘查,了解更多]`

export async function handleAiImage(replyToken: string, imageBase64: string, userId: string) {
  const client = getAnthropicClient()

  const history = await loadHistory(userId)
  await saveMessage(userId, "user", "[客戶傳送了一張照片]")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: imageBase64,
          },
        },
        { type: "text", text: "請幫我看看這棟建築的狀況" },
      ],
    },
  ]

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: IMAGE_PROMPT,
      messages,
    })

    const textParts: string[] = []
    for (const block of response.content) {
      if (block.type === "text") {
        textParts.push(block.text)
      }
    }
    const rawText = textParts.join("")

    // Parse quick reply
    const qrMatch = rawText.match(/\[QUICK_REPLY:([^\]]+)\]\s*$/)
    const cleanText = qrMatch ? rawText.replace(/\[QUICK_REPLY:[^\]]+\]\s*$/, "").trim() : rawText
    const labels = qrMatch ? qrMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : null

    const msg: LineMessage = { type: "text", text: cleanText }
    if (labels) {
      msg.quickReply = quickReply(labels)
    }

    await saveMessage(userId, "assistant", cleanText)
    await reply(replyToken, [msg])
  } catch (err) {
    console.error("Image analysis error:", err)
    await reply(replyToken, [
      { type: "text", text: "抱歉，圖片分析暫時無法使用。您可以直接描述建築狀況，我來幫您評估！" },
    ])
  }
}
