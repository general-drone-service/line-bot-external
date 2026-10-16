import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { GET } from "@/app/api/cron/crm-outbox/route"

const savedEnv = { ...process.env }
afterEach(() => {
  process.env = { ...savedEnv }
})

const get = (authorization?: string) =>
  new Request("https://example.test/api/cron/crm-outbox", authorization ? { headers: { authorization } } : {})

test("cron without CRON_SECRET configured returns 503", async () => {
  delete process.env.CRON_SECRET
  assert.equal((await GET(get("Bearer x"))).status, 503)
})

test("cron with wrong or missing bearer returns 401", async () => {
  process.env.CRON_SECRET = "test-cron-secret"
  assert.equal((await GET(get())).status, 401)
  assert.equal((await GET(get("Bearer wrong-cron-secre"))).status, 401)
})

test("authorized cron with push disabled reports skipped without touching the database", async () => {
  process.env.CRON_SECRET = "test-cron-secret"
  delete process.env.CRM_PUSH_ENABLED
  const res = await GET(get("Bearer test-cron-secret"))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { skipped: "disabled" })
})
