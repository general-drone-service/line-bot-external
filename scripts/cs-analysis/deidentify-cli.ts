/**
 * Usage: npx tsx scripts/cs-analysis/deidentify-cli.ts <raw dir> <out dir> --staff "<page name>,<staff name>"
 * Reads every message_N.json under <raw dir> (one thread per folder) and writes
 * <out dir>/clean/threads.jsonl and <out dir>/map/pseudonyms.json, both 0600 in 0700 folders.
 * Prints counts only: customer text must not reach the terminal, which an agent may be reading.
 */
import fs from "node:fs"
import path from "node:path"
import { deidentifyThreads, findResidue, type MetaThread } from "./deidentify"

const [rawDir, outDir, flag, staffArg] = process.argv.slice(2)
if (!rawDir || !outDir || flag !== "--staff" || !staffArg) {
  console.error('usage: deidentify-cli.ts <raw dir> <out dir> --staff "<page name>,<staff name>"')
  process.exit(2)
}
const staff = staffArg.split(",").map((s) => s.trim()).filter(Boolean)

// Errors from JSON.parse and fs quote input text or paths, so only the error class is printed.
process.on("uncaughtException", (err) => {
  console.error(`deidentify failed: ${err?.name ?? "Error"}`)
  process.exit(1)
})

const byFolder = new Map<string, MetaThread>()
for (const file of fs.readdirSync(rawDir, { recursive: true, encoding: "utf8" })) {
  if (!/(^|\/)message_\d+\.json$/.test(file)) continue
  const part = JSON.parse(fs.readFileSync(path.join(rawDir, file), "utf8")) as MetaThread
  const folder = path.dirname(file)
  const thread = byFolder.get(folder)
  if (thread) thread.messages.push(...part.messages)
  else byFolder.set(folder, { participants: part.participants, messages: [...part.messages] })
}

const { threads, map } = deidentifyThreads([...byFolder.values()], staff)
const names = Object.values(map).concat(staff)
let residue = 0
for (const t of threads) for (const m of t.messages) if (findResidue(m.text, names).length) residue++

const write = (dir: string, name: string, body: string) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const file = path.join(dir, name)
  fs.writeFileSync(file, body, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}
write(path.join(outDir, "clean"), "threads.jsonl", threads.map((t) => JSON.stringify(t)).join("\n") + "\n")
write(path.join(outDir, "map"), "pseudonyms.json", JSON.stringify(map, null, 2) + "\n")

const messages = threads.reduce((n, t) => n + t.messages.length, 0)
console.log(`threads=${threads.length} messages=${messages} customers=${Object.keys(map).length} residue_messages=${residue}`)
if (residue) process.exitCode = 1
