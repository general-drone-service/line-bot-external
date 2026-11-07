import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { deidentifyThreads, findResidue, fixMetaText, maskText, type MetaThread } from "../scripts/cs-analysis/deidentify"

// All names, numbers and addresses below are synthetic.

test("fixMetaText undoes Meta's latin-1 escaping and leaves correct text alone", () => {
  const mangled = Buffer.from("想洗外牆", "utf8").toString("latin1")
  assert.equal(fixMetaText(mangled), "想洗外牆")
  assert.equal(fixMetaText("想洗外牆"), "想洗外牆")
  assert.equal(fixMetaText("hello"), "hello")
})

test("maskText masks phones, email, url, ids and money", () => {
  const out = maskText("電話0912-345-678或(02)2345-6789、+886 912 345 678，信箱a.b@example.com，網址https://x.example/p，身分證A123456789，統編12345678，預算30萬、NT$12,000", [])
  for (const leak of ["0912", "2345-6789", "912 345", "example", "A123456789", "12345678", "30萬", "12,000"]) {
    assert.ok(!out.includes(leak), `leaked ${leak}: ${out}`)
  }
  assert.match(out, /\[電話\].*\[電話\].*\[電話\].*\[EMAIL\].*\[URL\].*\[ID\].*\[ID\].*\[金額\].*\[金額\]/)
})

test("maskText masks the address but keeps the county", () => {
  assert.equal(maskText("地址是臺北市大安區測試路三段100號5樓，謝謝", []), "地址是[地址:台北市]，謝謝")
  // Without a county the rule over-masks the word before the road; safer than leaking.
  assert.equal(maskText("在測試路100巷2號", []), "[地址]")
})

test("an address is still masked when a customer's name is part of the road name", () => {
  assert.equal(maskText("我在新北市板橋區測試路1號", ["林測試"]), "我在[地址:新北市]")
})

test("maskText masks listed names, name parts and honorifics", () => {
  const out = maskText("王小明說小明家的事，請找陳先生或Amy Lin", ["王小明", "Amy Lin"])
  assert.equal(out, "[人名]說[人名]家的事，請找[人名]或[人名]")
})

test("maskText masks building names but keeps the words around them", () => {
  assert.equal(maskText("請問遠揚社區外牆清洗多少", []), "請問[案場]外牆清洗多少")
  assert.equal(maskText("我想清洗我們社區", []), "我想清洗我們社區")
  assert.equal(maskText("你們公司有巡檢嗎", []), "你們公司有巡檢嗎")
})

test("deidentifyThreads pseudonymizes speakers consistently and keeps only safe fields", () => {
  const PAGE = "測試粉專"
  const t0 = Date.UTC(2026, 0, 5, 1, 0) // Mon 09:00 Asia/Taipei
  const threads: MetaThread[] = [
    {
      participants: [{ name: "王小明" }, { name: PAGE }],
      messages: [
        { sender_name: PAGE, timestamp_ms: t0 + 3_600_000, content: "王先生您好" },
        { sender_name: "王小明", timestamp_ms: t0, content: "我是王小明 0912345678", photos: [{ uri: "p.jpg" }] },
      ],
    },
    { participants: [{ name: "王小明" }, { name: PAGE }], messages: [{ sender_name: "王小明", timestamp_ms: t0 + 2 * 86_400_000, content: "再問一次" }] },
  ]
  const { threads: out, map } = deidentifyThreads(threads, [PAGE])

  assert.equal(out.length, 2)
  assert.deepEqual(out[0], {
    thread: "T0001",
    messages: [
      { speaker: "C0001", day: 0, weekday: 1, hour: 9, text: "我是[人名] [電話]", length: 16, hasAttachment: true },
      { speaker: "STAFF", day: 0, weekday: 1, hour: 10, text: "[人名]您好", length: 5, hasAttachment: false },
    ],
  })
  assert.equal(out[1].messages[0].speaker, "C0001")
  assert.deepEqual(map, { C0001: "王小明" })
  assert.ok(!JSON.stringify(out).includes("王小明"))
  assert.ok(!JSON.stringify(out).includes(PAGE))
})

test("findResidue reports leftover phones, emails and names", () => {
  assert.deepEqual(findResidue("[人名] [電話]", ["王小明"]), [])
  assert.deepEqual(findResidue("王小明 0912-345-678 a@b.co 測試路1號", ["王小明"]).sort(), ["address", "email", "name", "phone"])
})

test("long building names are masked whole, even when they contain a customer's name part", () => {
  assert.equal(maskText("請問合成測試幸福社區外牆", []), "請問[案場]外牆")
  assert.equal(maskText("我住王小明幸福大樓", ["王小明"]), "我住[案場]")
})

test("Chinese-numeral house numbers are masked with the address", () => {
  assert.equal(maskText("地址測試路一段一百號三樓之二", []), "[地址]")
  assert.equal(maskText("在測試街二十巷五弄", []), "[地址]")
  assert.equal(maskText("地址測試路100號之2", []), "[地址]")
  assert.equal(maskText("地址測試路一百之二號", []), "[地址]")
})

test("generic service names are not mistaken for building names", () => {
  assert.equal(maskText("請問外牆巡檢公司", []), "請問外牆巡檢公司")
  assert.equal(maskText("想找太陽能公司", []), "想找太陽能公司")
  assert.equal(maskText("大成外牆工程公司報價", []), "[案場]報價")
  assert.equal(maskText("請推薦外牆巡檢公司", []), "請推薦外牆巡檢公司")
  assert.equal(maskText("請問專業太陽能公司", []), "請問專業太陽能公司")
})

test("CLI never echoes raw input when a file cannot be parsed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deid-"))
  try {
    fs.mkdirSync(path.join(dir, "raw", "SYNTHETIC_PATH_MARKER"), { recursive: true })
    fs.writeFileSync(path.join(dir, "raw", "SYNTHETIC_PATH_MARKER", "message_1.json"), "SYNTHETIC_PRIVATE_TEXT not json")
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/cs-analysis/deidentify-cli.ts", path.join(dir, "raw"), path.join(dir, "out"), "--staff", "x"], { encoding: "utf8" })
    assert.notEqual(r.status, 0)
    for (const out of [r.stdout, r.stderr]) {
      assert.ok(!out.includes("SYNTHETIC"), `leaked: ${out}`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("CLI writes clean and map files readable only by the owner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deid-"))
  try {
    fs.mkdirSync(path.join(dir, "raw", "t1"), { recursive: true })
    const thread = { participants: [{ name: "王小明" }], messages: [{ sender_name: "王小明", timestamp_ms: 0, content: "想洗外牆" }] }
    fs.writeFileSync(path.join(dir, "raw", "t1", "message_1.json"), JSON.stringify(thread))
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/cs-analysis/deidentify-cli.ts", path.join(dir, "raw"), path.join(dir, "out"), "--staff", "x"], { encoding: "utf8" })
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trim(), "threads=1 messages=1 customers=1 residue_messages=0")
    const mode = (p: string) => fs.statSync(path.join(dir, "out", p)).mode & 0o777
    assert.equal(mode("clean"), 0o700)
    assert.equal(mode("map"), 0o700)
    assert.equal(mode("clean/threads.jsonl"), 0o600)
    assert.equal(mode("map/pseudonyms.json"), 0o600)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
