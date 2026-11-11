import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

// Mirrors seed-knowledge.ts chunking: one chunk per "## " heading.
function section(heading: string): string {
  const md = fs.readFileSync(new URL("../knowledge/pricing.md", import.meta.url), "utf-8")
  const chunk = md.split(/^## /m).find((s) => s.startsWith(heading))
  assert.ok(chunk, `missing section ${heading}`)
  return chunk
}

test("inspection pricing quotes by work day, not per m², with no minimum charge (Teddy LINE #1669)", () => {
  const s = section("巡檢服務定價")
  assert.match(s, /每天 NT\$35,000 起/)
  assert.match(s, /熱成像：每天加 NT\$15,000/)
  assert.match(s, /簽證（選配）：每案 NT\$150,000 起/)
  assert.match(s, /依現場勘查後報價/)
  assert.doesNotMatch(s, /\/m²|最低/)
})
