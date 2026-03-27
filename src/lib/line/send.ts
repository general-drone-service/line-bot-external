import { getChannelAccessToken } from "./client"
import type { LineMessage } from "./types"

const LINE_API_BASE = "https://api.line.me/v2/bot/message"

async function callLineApi(endpoint: string, body: Record<string, unknown>) {
  const token = getChannelAccessToken()
  const res = await fetch(`${LINE_API_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`LINE API ${endpoint} failed:`, res.status, text)
  }
}

export async function reply(replyToken: string, messages: LineMessage[]) {
  await callLineApi("reply", { replyToken, messages })
}

export async function push(userId: string, messages: LineMessage[]) {
  await callLineApi("push", { to: userId, messages })
}
