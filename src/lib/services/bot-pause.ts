import { createClient } from "@supabase/supabase-js"

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL ?? process.env.QUOTE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.QUOTE_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  return createClient(url, key)
}

const DEFAULT_PAUSE_HOURS = 2

/**
 * Pause bot auto-reply for a specific user.
 * @param userId LINE user ID
 * @param hours How many hours to pause (default from BOT_PAUSE_HOURS env or 2)
 */
export async function pauseBot(userId: string, hours?: number) {
  const pauseHours = hours ?? (Number(process.env.BOT_PAUSE_HOURS) || DEFAULT_PAUSE_HOURS)
  const pausedUntil = new Date(Date.now() + pauseHours * 60 * 60 * 1000).toISOString()

  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from("bot_pause")
    .upsert({ user_id: userId, paused_until: pausedUntil }, { onConflict: "user_id" })

  if (error) {
    console.error("Failed to pause bot:", error.message)
  }
}

/**
 * Resume bot auto-reply for a specific user (remove pause).
 */
export async function resumeBot(userId: string) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from("bot_pause")
    .delete()
    .eq("user_id", userId)

  if (error) {
    console.error("Failed to resume bot:", error.message)
  }
}

/**
 * Check if bot is currently paused for a user.
 * Returns true if paused (should NOT auto-reply).
 */
export async function isBotPaused(userId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from("bot_pause")
    .select("paused_until")
    .eq("user_id", userId)
    .single()

  if (error || !data) return false

  return new Date(data.paused_until) > new Date()
}
