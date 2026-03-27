import { NextResponse } from "next/server"
import crypto from "node:crypto"
import { getSupabaseAdmin } from "@/lib/supabase/client"
import { extractQuoteCode } from "@/lib/quote/lookup"
import { getQuoteAppOrigin } from "@/lib/quote/public-url"

export const runtime = "nodejs"

// ─── Lightweight LINE helpers (no @line/bot-sdk dependency) ──────────────────

function verifySignature(body: string, signature: string): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET
  if (!secret) throw new Error("Missing LINE_CHANNEL_SECRET")
  const hmac = crypto.createHmac("SHA256", secret)
  hmac.update(body)
  const expected = hmac.digest("base64")
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

async function lineReply(replyToken: string, messages: unknown[]) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN")
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  })
}

async function linePush(userId: string, messages: unknown[]) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN")
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to: userId, messages }),
  })
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface LineEvent {
  type: string
  replyToken?: string
  source?: { type: string; userId?: string }
  message?: { type: string; text?: string }
}

// ─── POST handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const rawBody = await request.text()

    const signature = request.headers.get("x-line-signature")
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 })
    }

    try {
      if (!verifySignature(rawBody, signature)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
      }
    } catch {
      console.warn("LINE signature verification skipped (missing secret?)")
    }

    const body = JSON.parse(rawBody) as { events: LineEvent[] }

    for (const event of body.events) {
      try {
        if (event.type === "follow" && event.source?.userId) {
          await handleFollow(event.source.userId)
        } else if (
          event.type === "message" &&
          event.message?.type === "text" &&
          event.message.text &&
          event.replyToken
        ) {
          await handleTextMessage(event.replyToken, event.message.text)
        }
      } catch (err) {
        console.error("Error handling event:", event.type, err)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("LINE webhook error:", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}

// ─── Event handlers ──────────────────────────────────────────────────────────

async function handleFollow(userId: string) {
  await linePush(userId, [
    {
      type: "text",
      text:
        "歡迎加入 GDS 低空作業官方帳號！🚁\n\n" +
        "如需取得報價單，請在網站完成報價後，\n" +
        "點擊「透過 LINE 取得報價單」按鈕即可。\n\n" +
        "您也可以直接傳送報價編號（如 Q-20260323-456）查詢報價單。",
    },
  ])
}

async function handleTextMessage(replyToken: string, text: string) {
  const quoteCode = extractQuoteCode(text)
  if (!quoteCode) return

  const supabase = getSupabaseAdmin()
  const { data: quote, error } = await supabase
    .from("quotes")
    .select("quote_code, pricing, time_result, expires_at, pdf_url")
    .eq("quote_code", quoteCode)
    .maybeSingle()

  if (error || !quote) {
    const base = getQuoteAppOrigin()
    await lineReply(replyToken, [
      { type: "text", text: `找不到報價單 ${quoteCode} 😕\n\n請確認編號是否正確，或至 ${base} 重新取得報價。` },
    ])
    return
  }

  const pricing = quote.pricing as { total: number; valid_until: string }
  const timeResult = quote.time_result as { suggested_days: number }
  const validUntil = (quote.expires_at as string) ?? pricing.valid_until

  await lineReply(replyToken, [
    {
      type: "flex",
      altText: `您的報價單 ${quote.quote_code} — NTD ${pricing.total.toLocaleString()}`,
      contents: {
        type: "bubble",
        size: "mega",
        header: {
          type: "box", layout: "vertical", backgroundColor: "#27272A", paddingAll: "16px",
          contents: [
            { type: "text", text: "GDS 低空作業報價單", color: "#FFFFFF", weight: "bold", size: "md" },
            { type: "text", text: quote.quote_code, color: "#A1A1AA", size: "xs", margin: "sm" },
          ],
        },
        body: {
          type: "box", layout: "vertical", spacing: "md", paddingAll: "16px",
          contents: [
            {
              type: "box", layout: "horizontal", contents: [
                { type: "text", text: "報價總額", color: "#71717A", size: "sm", flex: 1 },
                { type: "text", text: `NTD ${pricing.total.toLocaleString()}`, color: "#2563EB", weight: "bold", size: "lg", flex: 2, align: "end" },
              ],
            },
            {
              type: "box", layout: "horizontal", contents: [
                { type: "text", text: "預估工期", color: "#71717A", size: "sm", flex: 1 },
                { type: "text", text: `${timeResult.suggested_days} 天`, color: "#18181B", weight: "bold", size: "md", flex: 2, align: "end" },
              ],
            },
            {
              type: "box", layout: "horizontal", contents: [
                { type: "text", text: "有效至", color: "#71717A", size: "xs", flex: 1 },
                { type: "text", text: validUntil, color: "#71717A", size: "xs", flex: 2, align: "end" },
              ],
            },
            { type: "separator", margin: "md" },
            { type: "text", text: "⚠️ 本報價為快速估算，正式報價需現場勘查確認。", color: "#92400E", size: "xxs", wrap: true, margin: "md" },
          ],
        },
        footer: {
          type: "box", layout: "vertical", paddingAll: "12px",
          contents: [
            {
              type: "button",
              action: { type: "uri", label: "下載報價單 PDF", uri: quote.pdf_url as string },
              style: "primary", color: "#2563EB",
            },
          ],
        },
      },
    },
  ])
}
