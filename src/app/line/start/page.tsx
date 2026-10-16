import type { Metadata } from "next"
import { StartButton } from "./start-button"

export const metadata: Metadata = {
  title: "前往 LINE 詢問 — GDS 低空作業",
  robots: { index: false },
}

const SOURCE_KEY_RE = /^[a-z0-9_]{1,64}$/
// Plain official-account link (no source code) for invalid entries
const ADD_FRIEND_URL = "https://line.me/R/ti/p/%40058xfgns"

export default async function LineStartPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>
}) {
  const { source } = await searchParams
  const sourceKey = typeof source === "string" && SOURCE_KEY_RE.test(source) ? source : null

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "2rem 1rem", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: "1.4rem" }}>無人機外牆清洗與巡檢</h1>
      <p>
        一般無人機服務（GDS）提供建築外牆清洗與巡檢的標準流程、風險評估與作業紀錄。
        點下方按鈕會開啟官方 LINE 帳號 <strong>@058xfgns</strong>，並帶入一段詢問訊息，送出前您可以自行修改。
      </p>
      {sourceKey ? <StartButton sourceKey={sourceKey} fallbackUrl={ADD_FRIEND_URL} /> : (
        <p>
          此連結已失效，您仍可直接<a href={ADD_FRIEND_URL}>加入官方 LINE 帳號</a>詢問。
        </p>
      )}
      <p style={{ fontSize: "0.85rem", color: "#555" }}>
        資料用途：訊息中的「來源」代碼只用來了解您是從哪個管道得知我們，不包含您的姓名、電話或其他個人資料。
      </p>
      <p style={{ fontSize: "0.85rem", color: "#555" }}>
        使用電腦瀏覽時，請改用手機開啟此頁面，或在電腦上安裝 LINE 後再點按鈕。
      </p>
    </main>
  )
}
