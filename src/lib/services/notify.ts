/**
 * Human handoff notification — sends alerts via Email, Discord, and LINE Notify
 * when the AI cannot handle a customer request.
 *
 * Configure via env vars (all optional — only enabled channels will fire):
 *   NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM, SENDGRID_API_KEY
 *   DISCORD_WEBHOOK_URL
 *   LINE_NOTIFY_ACCESS_TOKEN
 */

interface HandoffPayload {
  userId: string
  userName?: string
  reason: string
  lastMessages: string[]
}

// ─── Email (SendGrid) ────────────────────────────────────────────────────────

async function notifyEmail(payload: HandoffPayload) {
  const apiKey = process.env.SENDGRID_API_KEY
  const to = process.env.NOTIFY_EMAIL_TO
  const from = process.env.NOTIFY_EMAIL_FROM ?? "linebot@drone168.com"
  if (!apiKey || !to) return

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
    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.error("Email notification failed:", err)
  }
}

// ─── Discord Webhook ─────────────────────────────────────────────────────────

async function notifyDiscord(payload: HandoffPayload) {
  const url = process.env.DISCORD_WEBHOOK_URL
  if (!url) return

  const content =
    `🚨 **人工接管請求**\n` +
    `> 客戶 ID: \`${payload.userId}\`\n` +
    `> 原因: ${payload.reason}\n\n` +
    `**最近對話:**\n` +
    payload.lastMessages.map((m) => `> ${m}`).join("\n")

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    })
  } catch (err) {
    console.error("Discord notification failed:", err)
  }
}

// ─── LINE Notify ─────────────────────────────────────────────────────────────

async function notifyLine(payload: HandoffPayload) {
  const token = process.env.LINE_NOTIFY_ACCESS_TOKEN
  if (!token) return

  const message =
    `\n🚨 人工接管請求\n` +
    `客戶 ID: ${payload.userId}\n` +
    `原因: ${payload.reason}\n\n` +
    `最近對話:\n${payload.lastMessages.slice(-4).join("\n")}`

  try {
    await fetch("https://notify-api.line.me/api/notify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: `message=${encodeURIComponent(message)}`,
    })
  } catch (err) {
    console.error("LINE Notify failed:", err)
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function requestHumanHandoff(payload: HandoffPayload) {
  console.log("Human handoff requested:", payload.reason, "for user:", payload.userId)

  // Fire all configured channels in parallel
  await Promise.allSettled([
    notifyEmail(payload),
    notifyDiscord(payload),
    notifyLine(payload),
  ])
}
