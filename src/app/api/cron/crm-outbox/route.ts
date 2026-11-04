import { runInboxWorker } from "@/lib/inbox/worker"
import { NextResponse } from "next/server"
import { rejectUnlessBearer } from "@/lib/services/bearer-auth"
import { flushCrmOutbox } from "@/lib/tracking/crm-push"

export const runtime = "nodejs"
// flushCrmOutbox stops starting rows after 30s; keep this above its worst case (~58s incl. lease RPC)
export const maxDuration = 60

/** Vercel Cron entry (sends `Authorization: Bearer $CRON_SECRET`); see vercel.json. */
export async function GET(request: Request) {
  const rejected = rejectUnlessBearer(request, process.env.CRON_SECRET, "Cron")
  if (rejected) return rejected
  try {
    const [legacy,inbox] = await Promise.all([flushCrmOutbox(),runInboxWorker()])
    if (inbox.skipped !== "disabled") console.info("LINE inbox worker heartbeat", {claimed:inbox.claimed,finished:inbox.finished,failed:inbox.failed})
    return NextResponse.json(inbox.skipped === "disabled" ? legacy : {...legacy,inbox})
  } catch (err) {
    console.error("CRM outbox flush failed:", err)
    return NextResponse.json({ error: "Flush failed" }, { status: 500 })
  }
}
