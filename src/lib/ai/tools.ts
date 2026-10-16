import type Anthropic from "@anthropic-ai/sdk"
import { searchKnowledge } from "@/lib/knowledge"
import { requestHumanHandoff } from "@/lib/services/notify"
import { pauseBot } from "@/lib/services/bot-pause"
import { loadHistory } from "./history"

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_knowledge",
    description:
      "搜尋公司知識庫，找出與客戶問題相關的資訊。用於回答服務內容、價格、流程、法規等問題。",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "搜尋關鍵詞或問題摘要",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "request_human",
    description:
      "轉接真人客服。當你無法回答客戶的問題、客戶明確要求跟真人說話、或遇到需要人工處理的情況時使用。",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "轉接原因摘要",
        },
      },
      required: ["reason"],
    },
  },
]

export interface ToolResult {
  tool_use_id: string
  content: string
}

export async function executeTool(
  name: string,
  toolUseId: string,
  input: Record<string, unknown>,
  userId?: string
): Promise<ToolResult> {
  switch (name) {
    case "search_knowledge": {
      const query = input.query as string
      const chunks = await searchKnowledge(query)
      if (chunks.length === 0) {
        return { tool_use_id: toolUseId, content: "知識庫中沒有找到相關資訊。" }
      }
      const text = chunks
        .map((c) => `[${c.source}${c.heading ? " > " + c.heading : ""}]\n${c.content}`)
        .join("\n\n---\n\n")
      return { tool_use_id: toolUseId, content: text }
    }

    case "request_human": {
      const reason = input.reason as string

      // Pause first so the bot never claims a handoff while it would keep replying
      if (userId) {
        try {
          await pauseBot(userId)
        } catch (err) {
          console.error("request_human: failed to pause bot", err)
          return {
            tool_use_id: toolUseId,
            content: "轉接失敗：系統暫時無法轉接真人客服。不要告訴客戶已轉接，請客戶直接撥打 02-7733-7678。",
          }
        }
      }

      const history = userId ? await loadHistory(userId) : []
      const lastMessages = history.slice(-6).map((m) => `${m.role}: ${m.content}`)

      await requestHumanHandoff({
        userId: userId ?? "unknown",
        reason,
        lastMessages,
      })

      return {
        tool_use_id: toolUseId,
        content: "已通知客服團隊，他們會盡快與客戶聯繫。機器人已暫停自動回覆。",
      }
    }

    default:
      return { tool_use_id: toolUseId, content: `Unknown tool: ${name}` }
  }
}
