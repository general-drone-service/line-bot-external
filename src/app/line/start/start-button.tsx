"use client"

import { useState } from "react"

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; url: string; message: string }
  | { kind: "error"; text: string }

export function StartButton({ sourceKey, fallbackUrl }: { sourceKey: string; fallbackUrl: string }) {
  // One key per page view: retries after a lost response return the same touch and token
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const [state, setState] = useState<State>({ kind: "idle" })
  const [copied, setCopied] = useState(false)

  async function start() {
    if (state.kind === "loading") return
    setState({ kind: "loading" })
    try {
      const res = await fetch("/api/line/touch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: sourceKey, idempotencyKey }),
      })
      if (res.status === 404) {
        setState({ kind: "error", text: "此連結已失效，請直接加入官方帳號詢問。" })
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { url, message } = (await res.json()) as { url: string; message: string }
      setState({ kind: "ready", url, message })
      window.location.href = url
    } catch {
      setState({ kind: "error", text: "暫時無法連線，請再試一次。" })
    }
  }

  async function copy(message: string) {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const button = { display: "block", width: "100%", padding: "0.9rem", fontSize: "1.05rem", border: 0, borderRadius: 8, background: "#06C755", color: "#fff", textAlign: "center" as const, textDecoration: "none" }

  if (state.kind === "ready") {
    return (
      <div>
        <a href={state.url} style={button}>開啟 LINE</a>
        <p>若 LINE 沒有自動開啟，請按上方按鈕，或複製以下訊息貼到官方帳號聊天室：</p>
        <pre style={{ whiteSpace: "pre-wrap", background: "#f4f4f4", padding: "0.75rem", borderRadius: 6 }}>{state.message}</pre>
        <button type="button" onClick={() => copy(state.message)}>{copied ? "已複製" : "複製訊息"}</button>
        {" "}<a href={fallbackUrl}>加入官方帳號</a>
      </div>
    )
  }

  return (
    <div>
      <button type="button" onClick={start} disabled={state.kind === "loading"} style={button}>
        {state.kind === "loading" ? "開啟中…" : "前往 LINE 詢問"}
      </button>
      {state.kind === "error" && (
        <p role="alert">
          {state.text} <a href={fallbackUrl}>加入官方帳號</a>
        </p>
      )}
    </div>
  )
}
