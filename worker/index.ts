import { runInboxWorker } from "../src/lib/inbox/worker"
import handler from "vinext/server/fetch-handler"
import { flushCrmOutbox } from "../src/lib/tracking/crm-push"

interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void
}

// Cloudflare entry: vinext serves requests; the cron trigger flushes the CRM outbox (Vercel uses /api/cron/crm-outbox)
export default {
  fetch: handler.fetch,
  scheduled(_controller: unknown, _env: unknown, ctx: ScheduledContext) {
    ctx.waitUntil(runInboxWorker().then(result => {
      if (result.skipped !== "disabled") console.info("LINE inbox worker heartbeat", {claimed:result.claimed,finished:result.finished,failed:result.failed})
    }).catch(() => console.error("LINE inbox worker unavailable")))
    ctx.waitUntil(flushCrmOutbox().catch((err) => console.error("CRM outbox flush failed:", err)))
  },
}
