import { reply } from "@/lib/line"
import type { LineMessage } from "@/lib/line"
import { extractQuoteCode } from "@/lib/router"
import { lookupQuote } from "@/lib/services/quote-api"
import { buildQuoteBubble } from "@/lib/flex"

export async function handleQuoteLookup(replyToken: string, text: string) {
  const quoteCode = extractQuoteCode(text)
  if (!quoteCode) return

  const quote = await lookupQuote(quoteCode)

  if (!quote) {
    const messages: LineMessage[] = [
      {
        type: "text",
        text: `找不到報價單 ${quoteCode} 😕\n\n請確認編號是否正確，或至報價網站重新取得報價。`,
      },
    ]
    await reply(replyToken, messages)
    return
  }

  const messages: LineMessage[] = [buildQuoteBubble(quote)]
  await reply(replyToken, messages)
}
