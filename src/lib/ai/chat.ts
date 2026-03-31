import { getAnthropicClient } from "./client"
import { SYSTEM_PROMPT } from "./system-prompt"
import { TOOLS, executeTool } from "./tools"
import type { ToolResult } from "./tools"
import { reply } from "@/lib/line"
import type { LineMessage } from "@/lib/line"
import { quickReply } from "@/lib/line"
import { buildQuoteBubble } from "@/lib/flex"
import type { QuoteData } from "@/lib/services/quote-api"
import { loadHistory, saveMessage } from "./history"

const QUICK_REPLY_REGEX = /\[QUICK_REPLY:([^\]]+)\]\s*$/

// Fallback quick reply detection when Haiku forgets the tag
const FALLBACK_QUICK_REPLIES: [RegExp, string[]][] = [
  [/哪種服務|哪項服務|需要什麼服務|服務項目/, ["外牆清洗", "外牆防水塗層", "外牆檢測"]],
  [/建物類型|建築類型|什麼類型|哪種建築/, ["住宅社區", "商辦大樓", "透天厝", "廠房", "太陽能板"]],
  [/清潔方式|怎麼洗|哪種洗法/, ["柔洗（快速噴洗）", "淨洗（高壓水洗）", "精洗（清潔劑）"]],
  [/施工時段|什麼時段|什麼時間施工/, ["平日白天", "週末假日", "夜間"]],
  [/髒污|汙垢|髒的類型/, ["灰塵", "水垢", "黑黴", "鳥屎", "排煙汙垢", "油汙"]],
  [/複雜程度|外牆狀況|立面複雜/, ["平整簡單", "中等", "複雜（多裝飾格柵）"]],
  [/平日還是週末|方便的時間/, ["平日", "週末"]],
  [/住宅.*商辦.*公共|哪種用途/, ["住宅", "商辦", "公共建築"]],
]

function parseQuickReply(text: string): { cleanText: string; labels: string[] | null } {
  const match = text.match(QUICK_REPLY_REGEX)
  if (match) {
    const cleanText = text.replace(QUICK_REPLY_REGEX, "").trim()
    const labels = match[1].split(",").map((s) => s.trim()).filter(Boolean)
    return { cleanText, labels: labels.length > 0 ? labels : null }
  }

  // Fallback: detect question patterns and auto-add buttons
  for (const [pattern, labels] of FALLBACK_QUICK_REPLIES) {
    if (pattern.test(text)) {
      return { cleanText: text, labels }
    }
  }

  return { cleanText: text, labels: null }
}

export async function handleAiChat(replyToken: string, userText: string, userId: string) {
  const client = getAnthropicClient()

  // Load conversation history
  const history = await loadHistory(userId)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ]

  // Save user message to history
  await saveMessage(userId, "user", userText)

  let quoteData: QuoteData | null = null

  for (let i = 0; i < 3; i++) {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    })

    if (response.stop_reason === "end_turn") {
      const textParts: string[] = []
      for (const block of response.content) {
        if (block.type === "text") {
          textParts.push(block.text)
        }
      }
      const rawText = textParts.join("")

      const lineMessages: LineMessage[] = []

      if (quoteData) {
        lineMessages.push(buildQuoteBubble(quoteData))
        await saveMessage(userId, "assistant", `[報價卡片] ${quoteData.quote_code}`)
      } else if (rawText) {
        const { cleanText, labels } = parseQuickReply(rawText)
        const msg: LineMessage = { type: "text", text: cleanText }
        if (labels) {
          msg.quickReply = quickReply(labels)
        }
        lineMessages.push(msg)
        await saveMessage(userId, "assistant", cleanText)
      }

      if (lineMessages.length > 0) {
        await reply(replyToken, lineMessages)
      }
      return
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: ToolResult[] = []
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = await executeTool(
            block.name,
            block.id,
            block.input as Record<string, unknown>,
            userId
          )
          toolResults.push(result)
          if (result.quoteData) {
            quoteData = result.quoteData
          }
        }
      }

      messages.push({ role: "assistant", content: response.content })
      messages.push({
        role: "user",
        content: toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
        })),
      })

      continue
    }

    break
  }

  await reply(replyToken, [
    { type: "text", text: "抱歉，目前無法處理您的問題。請稍後再試，或聯繫客服 02-7733-7678。" },
  ])
}
