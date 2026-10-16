import { botDbs, chatMessageId, insertMessageWithFallback } from "@/lib/botdb"
import type { ChatRow } from "@/lib/botdb"

export type ChatMessage = ChatRow

/** The LINE event a conversation turn belongs to; gives its history rows stable ids. */
export interface ChatTurn {
  accountId: string
  webhookEventId: string
  userId: string
}

const MAX_HISTORY = 20 // keep last 20 messages (10 turns)
const HISTORY_TTL_HOURS = 24 // load messages from last 24 hours

export async function loadHistory(userId: string): Promise<ChatMessage[]> {
  const cutoff = new Date(Date.now() - HISTORY_TTL_HOURS * 60 * 60 * 1000).toISOString()
  try {
    // Most recent N (descending), reversed to chronological order
    return (await botDbs().primary.recentMessages(userId, cutoff, MAX_HISTORY)).reverse()
  } catch (err) {
    console.error("Failed to load chat history:", (err as Error).message)
    return []
  }
}

/**
 * Throws when the row could not be stored anywhere, so the webhook returns non-2xx.
 * Call it before reply(): a failure must never follow a reply the customer already got.
 */
export async function saveMessage(turn: ChatTurn, role: ChatMessage["role"], content: string) {
  await insertMessageWithFallback(botDbs(), {
    id: chatMessageId(turn.accountId, turn.webhookEventId, role),
    user_id: turn.userId,
    role,
    content,
  })
}
