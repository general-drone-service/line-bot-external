/**
 * Human handoff notification. Sends to every configured channel; the handoff counts as delivered
 * when at least one channel accepted it.
 *
 * Configure via env vars (only configured channels fire):
 *   MANAGER_LINE_ALERT_URL, MANAGER_LINE_ALERT_TOKEN  — manager-line /alert, LINE push to Teddy
 *   NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM, SENDGRID_API_KEY
 */

interface HandoffPayload {
  userId: string
  userName?: string
  reason: string
  lastMessages: string[]
}

const TIMEOUT_MS = 5_000
const ALERT_MAX_BYTES = 4_000

const clip = (text: string, max: number) => {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…"
}

// ─── manager-line /alert ─────────────────────────────────────────────────────

async function notifyManagerLine(payload: HandoffPayload): Promise<boolean | null> {
  const url = process.env.MANAGER_LINE_ALERT_URL
  const token = process.env.MANAGER_LINE_ALERT_TOKEN
  if (!url || !token) return null

  // No dedupe_key: with one, manager-line keeps the full text in D1 until a resolved alert.
  // Repeat alerts for one customer are already limited by the BOT_PAUSE_HOURS pause after a handoff.
  const text =
    `客戶 ID: ${payload.userId}\n原因: ${clip(payload.reason, 200)}\n\n最近對話:\n` +
    payload.lastMessages.slice(-4).map((m) => clip(m, 150)).join("\n")
  // /alert rejects bodies over 4 KB; JSON escapes and multi-byte characters make char limits unreliable
  let json = ""
  for (let max = 1000; max > 0; max -= 100) {
    json = JSON.stringify({ source: "line-bot-handoff", severity: "warning", title: clip(`真人接手：${payload.reason}`, 100), body: clip(text, max) })
    if (new TextEncoder().encode(json).length <= ALERT_MAX_BYTES) break
  }

  // shortcut: no retry on 429/5xx; without a dedupe_key a retry can push twice. Upgrade if alerts get lost.
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: json,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // 202 sent, 200 deduped: both mean the alert is on its way or already went out
    if (res.status === 202 || res.status === 200) return true
    console.error("manager-line alert failed:", res.status)
    return false
  } catch (err) {
    console.error("manager-line alert failed:", (err as Error).name)
    return false
  }
}

// ─── Email (SendGrid) ────────────────────────────────────────────────────────

async function notifyEmail(payload: HandoffPayload): Promise<boolean | null> {
  const apiKey = process.env.SENDGRID_API_KEY
  const to = process.env.NOTIFY_EMAIL_TO
  const from = process.env.NOTIFY_EMAIL_FROM ?? "linebot@drone168.com"
  if (!apiKey || !to) return null

  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from, name: "GDS LINE Bot" },
    subject: `[人工接管] ${payload.reason}`,
    content: [
      {
        type: "text/plain",
        value:
          `客戶 ID: ${payload.userId}\n` +
          `原因: ${payload.reason}\n\n` +
          `最近對話:\n${payload.lastMessages.join("\n")}`,
      },
    ],
  }

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) return true
    console.error("Email notification failed:", res.status)
    return false
  } catch (err) {
    console.error("Email notification failed:", (err as Error).name)
    return false
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Returns true when at least one channel accepted the alert. */
export async function requestHumanHandoff(payload: HandoffPayload): Promise<boolean> {
  // reason is AI-written from the conversation and may hold customer details; keep it out of logs
  console.log("Human handoff requested for user:", payload.userId)

  // A channel that throws while building its message counts as failed, not as an unhandled handoff
  const results = await Promise.all(
    [notifyManagerLine, notifyEmail].map((send) => send(payload).catch(() => false))
  )
  if (results.every((r) => r === null)) console.error("Human handoff: no notification channel configured")
  return results.includes(true)
}
