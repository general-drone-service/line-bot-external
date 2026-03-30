import type Anthropic from "@anthropic-ai/sdk"
import { lookupQuote } from "@/lib/services/quote-api"
import { searchKnowledge } from "@/lib/knowledge"
import { requestHumanHandoff } from "@/lib/services/notify"
import { pauseBot } from "@/lib/services/bot-pause"
import { loadHistory } from "./history"
import type { QuoteData } from "@/lib/services/quote-api"

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "lookup_quote",
    description:
      "查詢客戶的報價單資料。當客戶提到報價編號（格式：Q-XXXXXXXX-XXX）時使用。",
    input_schema: {
      type: "object" as const,
      properties: {
        quote_code: {
          type: "string",
          description: "報價編號，如 Q-20260327-619",
        },
      },
      required: ["quote_code"],
    },
  },
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
  quoteData?: QuoteData | null
}

export async function executeTool(
  name: string,
  toolUseId: string,
  input: Record<string, unknown>,
  userId?: string
): Promise<ToolResult> {
  switch (name) {
    case "lookup_quote": {
      const code = input.quote_code as string
      const quote = await lookupQuote(code)
      if (!quote) {
        return {
          tool_use_id: toolUseId,
          content: `找不到報價編號 ${code} 的報價單。`,
          quoteData: null,
        }
      }
      return {
        tool_use_id: toolUseId,
        content: JSON.stringify({
          quote_code: quote.quote_code,
          total: quote.pricing.total,
          suggested_days: quote.time_result.suggested_days,
          valid_until: quote.expires_at ?? quote.pricing.valid_until,
          pdf_url: quote.pdf_url ?? null,
        }),
        quoteData: quote,
      }
    }

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
      const history = userId ? await loadHistory(userId) : []
      const lastMessages = history.slice(-6).map((m) => `${m.role}: ${m.content}`)

      await requestHumanHandoff({
        userId: userId ?? "unknown",
        reason,
        lastMessages,
      })

      // Auto-pause bot so it doesn't interfere with human agent
      if (userId) {
        await pauseBot(userId)
      }

      return {
        tool_use_id: toolUseId,
        content: "已通知客服團隊，他們會盡快與客戶聯繫。機器人已暫停自動回覆。",
      }
    }

    default:
      return { tool_use_id: toolUseId, content: `Unknown tool: ${name}` }
  }
}
