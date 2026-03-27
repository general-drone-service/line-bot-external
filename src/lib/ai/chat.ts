import { getAnthropicClient } from "./client"
import { SYSTEM_PROMPT } from "./system-prompt"
import { TOOLS, executeTool } from "./tools"
import type { ToolResult } from "./tools"
import { reply } from "@/lib/line"
import type { LineMessage } from "@/lib/line"
import { buildQuoteBubble } from "@/lib/flex"
import type { QuoteData } from "@/lib/services/quote-api"
import { loadHistory, saveMessage } from "./history"

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
      const text = textParts.join("")

      const lineMessages: LineMessage[] = []

      if (quoteData) {
        lineMessages.push(buildQuoteBubble(quoteData))
      }

      if (text) {
        lineMessages.push({ type: "text", text })
        // Save assistant reply to history
        await saveMessage(userId, "assistant", text)
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
            block.input as Record<string, unknown>
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
