import type { LineEvent } from "@/lib/line"
import type { ReplyStatus, TrackingStore } from "@/lib/tracking/store"

interface Row {
  reply: ReplyStatus | "sending"
  attempts: number
  tracked: boolean
}

/** In-memory stand-in mirroring the SQL claim semantics (the real SQL is covered by tests/db). */
export function fakeStore(failures: Partial<Record<keyof TrackingStore, number>> = {}) {
  const rows = new Map<string, Row>()
  const processed: { id: string; tokenHash: string | null; isTestUser: boolean }[] = []
  const fail = (op: keyof TrackingStore) => {
    if ((failures[op] ?? 0) > 0) {
      failures[op]!--
      throw new Error(`${op} unavailable`)
    }
  }
  const store: TrackingStore = {
    async recordEvents(_accountId, events: LineEvent[]) {
      fail("recordEvents")
      for (const e of events) {
        if (!rows.has(e.webhookEventId!)) rows.set(e.webhookEventId!, { reply: "pending", attempts: 0, tracked: false })
      }
    },
    async processEvent(_accountId, id, tokenHash, isTestUser) {
      fail("processEvent")
      const row = rows.get(id)!
      if (!row.tracked) processed.push({ id, tokenHash, isTestUser })
      row.tracked = true
      return tokenHash ? "matched" : "no_token"
    },
    async claimReply(_accountId, id) {
      fail("claimReply")
      const row = rows.get(id)!
      if (row.reply !== "pending") return 0
      row.reply = "sending"
      return ++row.attempts
    },
    async finishReply(_accountId, id, status) {
      fail("finishReply")
      const row = rows.get(id)!
      if (row.reply === "sending") row.reply = status
    },
  }
  return { store, rows, processed, status: (id: string) => rows.get(id)?.reply }
}
