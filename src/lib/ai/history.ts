import { createClient } from "@supabase/supabase-js"

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL ?? process.env.QUOTE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.QUOTE_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  return createClient(url, key)
}

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

const MAX_HISTORY = 20 // keep last 20 messages (10 turns)
const HISTORY_TTL_HOURS = 24 // load messages from last 24 hours

export async function loadHistory(userId: string): Promise<ChatMessage[]> {
  const supabase = getSupabaseAdmin()
  const cutoff = new Date(Date.now() - HISTORY_TTL_HOURS * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from("chat_history")
    .select("role, content")
    .eq("user_id", userId)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY)

  if (error) {
    console.error("Failed to load chat history:", error.message)
    return []
  }

  return (data ?? []) as ChatMessage[]
}

export async function saveMessage(userId: string, role: "user" | "assistant", content: string) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from("chat_history")
    .insert({ user_id: userId, role, content })

  if (error) {
    console.error("Failed to save chat message:", error.message)
  }
}
