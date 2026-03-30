/**
 * Business hours check — bot only auto-replies OUTSIDE business hours.
 * During business hours, human agents handle messages.
 *
 * Configure via env vars:
 *   BUSINESS_HOURS_START=9    (default 9 = 09:00)
 *   BUSINESS_HOURS_END=18     (default 18 = 18:00)
 *   BUSINESS_HOURS_TZ=Asia/Taipei (default)
 *   BUSINESS_HOURS_DAYS=1,2,3,4,5  (default Mon-Fri, 0=Sun 6=Sat)
 */

function getConfig() {
  const start = Number(process.env.BUSINESS_HOURS_START) || 9
  const end = Number(process.env.BUSINESS_HOURS_END) || 18
  const tz = process.env.BUSINESS_HOURS_TZ || "Asia/Taipei"
  const days = process.env.BUSINESS_HOURS_DAYS
    ? process.env.BUSINESS_HOURS_DAYS.split(",").map(Number)
    : [1, 2, 3, 4, 5] // Mon–Fri
  return { start, end, tz, days }
}

/**
 * Returns true if current time is within business hours.
 * When true, the bot should NOT auto-reply (humans are available).
 */
export function isDuringBusinessHours(): boolean {
  const { start, end, tz, days } = getConfig()

  const now = new Date()
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  })

  const parts = formatter.formatToParts(now)
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0)
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? ""

  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  const dayNum = dayMap[weekday] ?? -1

  if (!days.includes(dayNum)) return false

  const currentTime = hour + minute / 60
  return currentTime >= start && currentTime < end
}
