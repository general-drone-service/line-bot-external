import { getAnthropicClient } from "./client"
import { reply } from "@/lib/line"
import type { LineMessage } from "@/lib/line"
import { quickReply } from "@/lib/line"
import { loadHistory, saveMessage } from "./history"

const IMAGE_PROMPT = `你是 GDS 低空作業的客服。客戶傳了一張照片。

用 2-3 句自然對話回覆，80 字以內。像跟朋友聊天一樣說你看到什麼（建築類型、外牆狀況），然後問要不要報價或安排勘查。

禁止條列式，禁止 Markdown 格式。純文字。

最後一行加 [QUICK_REPLY:我想報價,預約勘查]`

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
