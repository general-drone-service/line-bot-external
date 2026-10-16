# LINE 詢問來源追蹤（bot 端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `@058xfgns` 的 LINE 詢問可帶來源（FB 入口 token）並可靠記錄、去重，之後推送 CRM `line_inquiries`。

**Architecture:** 先修 webhook 的安全與錯誤語意（P0），再在 POST 事件迴圈前整批寫入追蹤事件並以事件 ID 去重（P1），最後以 outbox 推送 CRM（P2-bot）。純判斷邏輯放 `src/lib/tracking/`，webhook 主流程從 route 抽到 `src/lib/line/webhook.ts` 以便測試（Next route 檔不能匯出額外名稱）。

**Tech Stack:** Next 15 app router（vinext → Cloudflare Workers）、Supabase（quote-drone168）、node:test + tsx（已安裝，不加依賴）。

**Spec:** pm 方案 v3 `line-tracking-plan.md`（範圍以它為準）；細節參考原規格 `~/Downloads/review-line-tracking.md` 中 v3 採用的部分。

## Global Constraints

- 不加新依賴；測試用 `node --import tsx --test`。
- 不 push、不 merge、不部署、不 apply 遠端 migration、不改 Cloudflare／LINE 設定；全部回報 pm。
- 追蹤不存聊天全文、附件或 reply token。
- 簽章：缺 secret／長度不符／錯誤一律拒絕，不得跳過驗證繼續處理。
- **去重（P1）與開啟 LINE 重送同批上線**；P0 單獨上線前須確認 LINE 重送是關閉的（P0 會在處理失敗時回 500）。

## Review Focus

1. LINE console「Verify」送的是 `events: []` → 必須回 200（測試 `empty events returns 200`）。
2. 簽章 header 長度與正確值不同 → 現行碼會 throw 再被吞掉而放行；必須 401（測試 `wrong-length signature is rejected`）。
3. 中文內容的 body → HMAC 必須對原始 UTF-8 字串計算（測試 `valid signature over multibyte body is accepted`）。
4. 一批多個事件中只有一個失敗 → 其他事件仍要處理，整體回 500（測試 `one failing event still processes others and returns 500`）。
5. 空白文字、貼圖、群組訊息 → 不算詢問（Task 4 測試）。

---

## P0（本次實作）

### Task 1: 測試指令 + 簽章 fail-closed + 失敗回非 2xx

**Files:**
- Modify: `package.json`（scripts.test）
- Modify: `src/lib/line/signature.ts`
- Create: `src/lib/line/webhook.ts`
- Modify: `src/app/api/webhook/route.ts`（POST 改呼叫 `handleWebhookRequest`；圖片下載失敗改 throw）
- Modify: `src/lib/line/send.ts`（LINE API 非 2xx 改 throw，否則發送失敗仍回 200）
- Test: `tests/webhook-route.test.ts`（實際 route POST，mock fetch：push 503／網路錯誤 → 500，且下一事件仍執行）
- Modify: `src/lib/line/index.ts`（匯出）
- Test: `tests/webhook.test.ts`

**Interfaces:**
- Produces: `verifySignature(body: string, signature: string): boolean` — 長度不符回 `false`；缺 secret 仍 throw（由 `getChannelSecret`）。
- Produces: `handleWebhookRequest(request: Request, handleEvent: (event: LineEvent) => Promise<void>): Promise<Response>`
  - 無 `x-line-signature` → 401；缺 `LINE_CHANNEL_SECRET` → 500 `{ error: "Server misconfigured" }`、不呼叫 handler；簽章錯 → 401；body 非 JSON 或 `events` 非陣列 → 400。
  - 依序處理所有事件；任一 throw 就記 log、繼續下一個，最後回 500；全成功回 200 `{ ok: true }`。

- [ ] **Step 1:** `package.json` 加 `"test": "node --import tsx --test tests/*.test.ts tests/*.spec.mjs"`。
- [ ] **Step 2: 寫失敗測試** `tests/webhook.test.ts`（用 `crypto.createHmac` 產生正確簽章；每個測試設定／還原 `process.env.LINE_CHANNEL_SECRET`）：
  - `missing signature header returns 401`
  - `missing channel secret returns 500 and does not handle events`
  - `wrong-length signature is rejected` → 401，handler 呼叫 0 次
  - `same-length wrong signature is rejected` → 401
  - `valid signature over multibyte body is accepted` → 200，handler 收到文字 `您好，我想了解外牆清洗服務`
  - `empty events returns 200`
  - `invalid JSON returns 400`
  - `one failing event still processes others and returns 500` → 3 個事件、第 2 個 throw，handler 呼叫 3 次、status 500
- [ ] **Step 3:** `npm test` → 預期 FAIL（`handleWebhookRequest` 不存在）。
- [ ] **Step 4:** 實作 `signature.ts`（比較前先比 Buffer 長度）與 `webhook.ts`；route 的 POST 改成 `return handleWebhookRequest(request, handleEvent)`。
- [ ] **Step 5:** `npm test` → PASS；`npx tsc --noEmit` 無錯。
- [ ] **Step 6:** Commit `fix: fail closed on LINE signature and surface event failures`。

### Task 2: `/api/bot-pause` 加驗證

**Files:**
- Modify: `src/app/api/bot-pause/route.ts`
- Test: `tests/bot-pause-auth.test.ts`

**Interfaces:**
- 環境變數 `BOT_PAUSE_API_TOKEN`；請求帶 `Authorization: Bearer <token>`。
- 未設 env → 503 `{ error: "Bot pause API not configured" }`；缺／錯 token → 401。驗證在讀 body 與碰 Supabase 之前。比對用 `crypto.timingSafeEqual`（先比長度）。

- [ ] **Step 1: 寫失敗測試**（只測拒絕路徑，不碰 Supabase）：
  - `GET without env token configured returns 503`
  - `GET without Authorization returns 401`
  - `POST with wrong bearer token returns 401`
  - `POST with token of different length returns 401`
- [ ] **Step 2:** `npm test` → FAIL（目前回 400／會打 Supabase）。
- [ ] **Step 3:** 在 route 檔內加未匯出的 `rejectUnauthorized(request: Request): Response | null`，GET／POST 第一行呼叫。
- [ ] **Step 4:** `npm test` → PASS。
- [ ] **Step 5:** Commit `fix: require bearer token for bot pause API`。

### Task 3: 詢問判斷函式（群組不計）

**Files:**
- Create: `src/lib/tracking/inquiry.ts`
- Modify: `src/lib/line/types.ts`（`source` 補 `groupId?`、`roomId?`）
- Test: `tests/inquiry.test.ts`

**Interfaces:**
- Produces: `isInquiryEvent(event: LineEvent): boolean` — 僅當 `type === "message"`、`source.type === "user"`、有 `source.userId`，且 message 為非空白 `text`，或 `image`／`video`／`audio`／`file`／`location`。P1 的 webhook 追蹤使用；P0 不接線（客服行為維持現狀）。

- [ ] **Step 1: 寫失敗測試**：
  - `one-to-one text is an inquiry`
  - `whitespace-only text is not an inquiry`（`"  \n "`）
  - `image, video, audio, file, location are inquiries`
  - `sticker is not an inquiry`
  - `group and room messages are not inquiries`（`source: { type: "group", groupId, userId }`）
  - `follow and unsend are not inquiries`
- [ ] **Step 2:** `npm test` → FAIL。
- [ ] **Step 3:** 實作。
- [ ] **Step 4:** `npm test` → PASS；`npx tsc --noEmit` 無錯。
- [ ] **Step 5:** Commit `feat: add inquiry event predicate excluding group chats`。

**P0 閘門：** rev-line-bot-external review → 回報 pm。P1 開工前須 pm／使用者核准。

---

## P1（待 P0 審過；開工前把每個 task 展開成同樣的 TDD 步驟）

### Task 4: 型別與 migration
- `types.ts`：`LineWebhookBody.destination`；`LineEvent` 加 `webhookEventId`、`timestamp`、`deliveryContext.isRedelivery`、`unsend.messageId`、`follow.isUnblocked`、`mode`。
- `supabase/migrations/003_line_tracking.sql`（只在本機／測試專案 apply）：
  - `line_tracking_sources(source_key unique, crm_source_code, entry_type, enabled, label, created_at)`
  - `line_tracking_touches(token_hash unique, idempotency_key unique, source_id, expires_at, bound_line_user_id, bound_at, is_test)`
  - `line_tracking_events(account_id, webhook_event_id, unique(account_id, webhook_event_id), event_type, event_at, line_user_id, message_id, touch_id, attribution_status, tracking_status, reply_status check in (pending, skipped, sending, sent, failed, unknown), crm_sync_status, retracted_at, is_test)`
  - `line_tracking_unsent(account_id, message_id, primary key)` tombstone
  - 全部 `enable row level security`、不建 policy；`revoke all from anon, authenticated`；view 用 `security_invoker`。

### Task 5: webhook 整批寫入與回覆 claim
- `src/lib/tracking/store.ts`：`recordEvents(destination, events): Promise<{ inserted: Set<string> }>`（upsert ignoreDuplicates，失敗 throw）；`claimReply(accountId, eventId): Promise<boolean>`（條件式 `update … where reply_status='pending'` → `sending`）；`finishReply(…, "sent" | "failed" | "skipped" | "unknown")`。
- `handleWebhookRequest`：驗簽後、迴圈前呼叫 `recordEvents`；throw → 500，handler 一個都不跑。**是否處理由持久化狀態＋原子 claim 決定，不看是否新插入**：`reply_status='pending'` 的事件（含先前已入庫、claim 前中斷的）可被 claim 後處理；`sending`／`sent`／`skipped`／`unknown` 一律跳過。上班時間／暫停 → `skipped`（終態）。LINE reply 呼叫 throw 或逾時 → `unknown`，不重送。
- 測試：重送同一事件 3 次 handler 只跑 1 次；`recordEvents` 失敗 → 500 且 0 次回覆；claim 失敗不回覆；**寫入成功 → claim 前中斷 → 重送可恢復處理**。

### Task 6: token 與 `/line/start`
- `src/lib/tracking/token.ts`：`deriveToken(secret, idempotencyKey): string`（HMAC-SHA256 → base64url 前 22 字元，加前綴 `L-` 以避開 `Q-\w{8}-\w{3}`）；`hashToken(token): string`；`extractToken(text): string | null`；`stripToken(text): string`。
- `src/app/line/start/page.tsx`（GET 只顯示，不建 touch）＋ `src/app/api/line/touch/route.ts`（POST `{ source, idempotencyKey }`；source_key 白名單；回 `https://line.me/R/oaMessage/%40058xfgns/?<encodeURIComponent(預填訊息)>`）。桌面 QR 編碼 `/line/start?source=` 本身（不加 QR 依賴則先以文字連結＋提示，QR 另議）。
- 綁定：`update touches set bound_line_user_id=$u where token_hash=$h and (bound_line_user_id is null or bound_line_user_id=$u)`；0 列且存在 → `conflict`。
- AI 與 `chat_history` 收到的是 `stripToken(text)`。

### Task 7: 撤回
- `unsend`：寫 tombstone；撤銷該 message 的綁定貢獻（`touch_id` 清空、`attribution_status='retracted'`）。晚到的原訊息若有 tombstone → 不綁定。

### P1 驗收
規格 A01–A12、S01、S02（v3 範圍內）；在測試 Supabase 專案跑。

---

## P2-bot（待 CRM 介面定案）

### Task 8: outbox 推送 CRM
- `line_tracking_events.crm_sync_status`（pending／sent／failed）＋ `src/lib/tracking/crm-push.ts`：`pushInquiry(row)` 送 `line-inquiry-ingest`，HMAC 簽章（共用密鑰 `CRM_INGEST_HMAC_SECRET`），帶 `is_test`、`bot_event_ref`。
- 重試：**spike** —— `vinext/server/fetch-handler` 沒有 `scheduled` 匯出（查過 node_modules/vinext/dist），需自訂 worker entry 包住 fetch handler 再加 `triggers.crons`。spike 不成就改「下一次 webhook 時以 `ctx.waitUntil` 補送 pending」。
