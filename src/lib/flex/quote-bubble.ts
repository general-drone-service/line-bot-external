import type { LineFlexMessage } from "@/lib/line"
import type { QuoteData } from "@/lib/services/quote-api"

export function buildQuoteBubble(quote: QuoteData): LineFlexMessage {
  const { pricing, time_result: timeResult } = quote
  const validUntil = quote.expires_at ?? pricing.valid_until

  const bubble: Record<string, unknown> = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#27272A",
      paddingAll: "16px",
      contents: [
        { type: "text", text: "GDS 低空作業報價單", color: "#FFFFFF", weight: "bold", size: "md" },
        { type: "text", text: quote.quote_code, color: "#A1A1AA", size: "xs", margin: "sm" },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      paddingAll: "16px",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          contents: [
            { type: "text", text: "報價總額", color: "#71717A", size: "sm", flex: 1 },
            { type: "text", text: `NTD ${pricing.total.toLocaleString()}`, color: "#2563EB", weight: "bold", size: "lg", flex: 2, align: "end" },
          ],
        },
        {
          type: "box",
          layout: "horizontal",
          contents: [
            { type: "text", text: "預估工期", color: "#71717A", size: "sm", flex: 1 },
            { type: "text", text: `${timeResult.suggested_days} 天`, color: "#18181B", weight: "bold", size: "md", flex: 2, align: "end" },
          ],
        },
        {
          type: "box",
          layout: "horizontal",
          contents: [
            { type: "text", text: "有效至", color: "#71717A", size: "xs", flex: 1 },
            { type: "text", text: validUntil, color: "#71717A", size: "xs", flex: 2, align: "end" },
          ],
        },
        { type: "separator", margin: "md" },
        { type: "text", text: "⚠️ 本報價為快速估算，正式報價需現場勘查確認。", color: "#92400E", size: "xxs", wrap: true, margin: "md" },
      ],
    },
  }

  if (quote.pdf_url) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "button",
          action: { type: "uri", label: "下載報價單 PDF", uri: quote.pdf_url },
          style: "primary",
          color: "#2563EB",
        },
      ],
    }
  }

  return {
    type: "flex",
    altText: `您的報價單 ${quote.quote_code} — NTD ${pricing.total.toLocaleString()}`,
    contents: bubble,
  }
}
