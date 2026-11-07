/**
 * De-identifies customer-service chat exports before any analysis (Teddy LINE #1435).
 * Plan: ~/drone168/.harness/line-bot-external-cs-analysis-plan-20261107.md §5.
 * Rule based on purpose: no LLM or network call, so raw customer text never leaves the machine.
 * shortcut: rules miss some free-text names and addresses, so clean output is still internal data.
 */

/** Shape of one Meta "Download your information" message_N.json. */
export interface MetaThread {
  participants?: { name: string }[]
  messages: MetaMessage[]
}

export interface MetaMessage {
  sender_name: string
  timestamp_ms: number
  content?: string
  photos?: unknown[]
  videos?: unknown[]
  files?: unknown[]
  audio_files?: unknown[]
  gifs?: unknown[]
}

export interface CleanMessage {
  speaker: string
  /** Days since the thread's first message. */
  day: number
  /** 0 = Sunday, Asia/Taipei. */
  weekday: number
  hour: number
  text: string
  /** Length of the original text, before masking. */
  length: number
  hasAttachment: boolean
}

export interface CleanThread {
  thread: string
  messages: CleanMessage[]
}

/** Meta writes UTF-8 bytes as latin-1 code points; text with any char above 0xFF is already fine. */
export function fixMetaText(s: string): string {
  return /^[\u0000-ÿ]*$/.test(s) ? Buffer.from(s, "latin1").toString("utf8") : s
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const URL_RE = /https?:\/\/[!-~]+/g
const PHONE = /(?<!\d)(?:\+886[-\s]?|\(0\d{1,2}\)\s?|0)\d{1,4}(?:[-\s]?\d{3,4}){1,2}(?!\d)/g
const NATIONAL_ID = /[A-Z][12]\d{8}/g
const EIGHT_DIGITS = /(?<!\d)\d{8}(?!\d)/g
const MONEY = /(?:NT\$|\$)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:萬|元|塊)/g
const COUNTY = "((?:臺北|台北|新北|桃園|臺中|台中|臺南|台南|高雄|基隆|新竹|嘉義|苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|臺東|台東|澎湖|金門|連江)[市縣])"
const CJK = "\\u4e00-\\u9fff"
const NUM = `[\\d〇零一二三四五六七八九十百千]+`
const NO = `${NUM}(?:[-之]${NUM})?`
// shortcut: without a county the road name can swallow up to 4 preceding words; upgrade if that hurts classification.
const ADDRESS = new RegExp(
  `(?:${COUNTY})?(?:[${CJK}]{1,3}[區鄉鎮市])?[${CJK}\\d]{1,4}?(?:路|街|大道)(?:${NUM}段)?(?:${NO}巷)?(?:${NO}弄)?(?:${NO}號(?:之${NUM})?)?(?:${NUM}樓(?:之${NUM})?)?`,
  "g",
)
const HONORIFIC = new RegExp(`[${CJK}](?:先生|小姐|太太|經理|主委|總幹事|董事長|總經理|主任|協理|副總|老闆)`, "g")
// shortcut: names longer than 8 chars keep their head; raise the limit if spot checks find leaks.
const SITE = new RegExp(`([${CJK}A-Za-z0-9]{1,8})(大樓|社區|大廈|華廈|廠|公司|醫院|學校|飯店)`, "g")
// Words around a building name, so the name starts after the last one. A name containing one keeps its head.
const SITE_STOP = /[的們我你他在是洗要想問價這那該貴本個棟間和與跟到從於請住找]/
// Service words and the generic modifiers asked with them: "外牆巡檢公司", "專業太陽能公司" are categories the analysis needs.
const SERVICE_WORDS = /外牆|巡檢|清洗|清潔|太陽能|光電|檢測|無人機|空拍|工程|防水|油漆|塗裝|建設|營造|物業|管理|保全|維修|修繕|推薦|專業|專門|優質|優良|合格|合法|知名|相關|附近|在地|一般|大型|小型|便宜/g
const STRAY_HOUSE_NO = new RegExp(`${NUM}[巷弄]`)

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Full names plus the parts customers write on their own ("Amy", "小明"). */
function nameVariants(names: string[]): string[] {
  const out = new Set<string>()
  for (const name of names) {
    const n = name.trim()
    if (n.length < 2) continue
    out.add(n)
    for (const part of n.split(/\s+/)) if (part.length >= 2) out.add(part)
    if (/^[一-鿿]{3}$/.test(n)) out.add(n.slice(1))
  }
  return [...out].sort((a, b) => b.length - a.length)
}

function namePattern(names: string[]): RegExp | null {
  const variants = nameVariants(names)
  if (!variants.length) return null
  return new RegExp(variants.map((v) => (/^\w+$/.test(v) ? `\\b${escape(v)}\\b` : escape(v))).join("|"), "g")
}

export function maskText(text: string, names: string[]): string {
  let s = text
    .replace(EMAIL, "[EMAIL]")
    .replace(URL_RE, "[URL]")
    .replace(PHONE, "[電話]")
    .replace(NATIONAL_ID, "[ID]")
    .replace(EIGHT_DIGITS, "[ID]")
    .replace(ADDRESS, (_m, county?: string) => (county ? `[地址:${county.replace("臺", "台")}]` : "[地址]"))
    .replace(SITE, (m, prefix: string) => {
      let cut = 0
      for (let i = 0; i < prefix.length; i++) if (SITE_STOP.test(prefix[i])) cut = i + 1
      const proper = prefix.slice(cut).replace(SERVICE_WORDS, "")
      return proper.length >= 2 ? `${prefix.slice(0, cut)}[案場]` : m
    })
  // Names go after addresses and sites: a name part inside them would otherwise break their match.
  const byName = namePattern(names)
  if (byName) s = s.replace(byName, "[人名]")
  return s.replace(MONEY, "[金額]").replace(HONORIFIC, "[人名]")
}

/** Kinds of identifiers still present in masked text; used for the spot check (plan §5.1 step 4). */
export function findResidue(text: string, names: string[]): string[] {
  const kinds: string[] = []
  if (new RegExp(PHONE.source).test(text)) kinds.push("phone")
  if (new RegExp(EMAIL.source).test(text)) kinds.push("email")
  if (new RegExp(NATIONAL_ID.source).test(text)) kinds.push("id")
  if (new RegExp(ADDRESS.source).test(text) || STRAY_HOUSE_NO.test(text)) kinds.push("address")
  const byName = namePattern(names)
  if (byName && new RegExp(byName.source).test(text)) kinds.push("name")
  return kinds
}

const DAY_MS = 86_400_000
const TAIPEI_OFFSET_MS = 8 * 3_600_000 // Taiwan has no DST.
const pad = (n: number) => String(n).padStart(4, "0")

/** Pseudonyms are shared across threads, so one customer keeps one id. `map` is the only way back. */
export function deidentifyThreads(threads: MetaThread[], staffNames: string[]): { threads: CleanThread[]; map: Record<string, string> } {
  const staff = new Set(staffNames)
  const customers = new Set<string>()
  for (const t of threads) {
    for (const p of t.participants ?? []) customers.add(fixMetaText(p.name))
    for (const m of t.messages) customers.add(fixMetaText(m.sender_name))
  }
  for (const s of staff) customers.delete(s)
  const names = [...customers, ...staff]

  const ids = new Map<string, string>()
  const speakerOf = (name: string) => {
    if (staff.has(name)) return "STAFF"
    if (!ids.has(name)) ids.set(name, `C${pad(ids.size + 1)}`)
    return ids.get(name)!
  }

  const out = threads.map((t, i) => {
    const sorted = [...t.messages].sort((a, b) => a.timestamp_ms - b.timestamp_ms)
    const start = sorted[0]?.timestamp_ms ?? 0
    return {
      thread: `T${pad(i + 1)}`,
      messages: sorted.map((m) => {
        const text = fixMetaText(m.content ?? "")
        const local = new Date(m.timestamp_ms + TAIPEI_OFFSET_MS)
        return {
          speaker: speakerOf(fixMetaText(m.sender_name)),
          day: Math.floor((m.timestamp_ms - start) / DAY_MS),
          weekday: local.getUTCDay(),
          hour: local.getUTCHours(),
          text: maskText(text, names),
          length: text.length,
          hasAttachment: [m.photos, m.videos, m.files, m.audio_files, m.gifs].some((a) => Array.isArray(a) && a.length > 0),
        }
      }),
    }
  })
  return { threads: out, map: Object.fromEntries([...ids].map(([name, id]) => [id, name])) }
}
