import { botDbs, cutoverFrozen, CutoverFrozenError } from "@/lib/botdb"

const DEFAULT_PAUSE_HOURS = 2

// bot_pause is replaced wholesale during the cutover, so no writes are allowed while frozen.
function assertWritable() {
  if (cutoverFrozen()) throw new CutoverFrozenError()
}

/**
 * Pause bot auto-reply for a specific user. Throws if the pause was not stored.
 * @param userId LINE user ID
 * @param hours How many hours to pause (default from BOT_PAUSE_HOURS env or 2)
 */
export async function pauseBot(userId: string, hours?: number) {
  assertWritable()
  const pauseHours = hours ?? (Number(process.env.BOT_PAUSE_HOURS) || DEFAULT_PAUSE_HOURS)
  const pausedUntil = new Date(Date.now() + pauseHours * 60 * 60 * 1000).toISOString()
  await botDbs().primary.setPause(userId, pausedUntil)
}

/**
 * Resume bot auto-reply for a specific user (remove pause). Throws if it was not stored.
 */
export async function resumeBot(userId: string) {
  assertWritable()
  await botDbs().primary.clearPause(userId)
}

/**
 * Check if bot is currently paused for a user.
 * Returns true if paused (should NOT auto-reply).
 */
export async function isBotPaused(userId: string): Promise<boolean> {
  try {
    const until = await botDbs().primary.pausedUntil(userId)
    return until !== null && new Date(until) > new Date()
  } catch {
    return false
  }
}
