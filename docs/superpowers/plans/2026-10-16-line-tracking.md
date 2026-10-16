# LINE 詢問來源追蹤（bot 端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `@058xfgns` 的 LINE 詢問可帶來源（FB 入口 token）並可靠記錄、去重，之後推送 CRM `line_inquiries`。

**Architecture:** 先修 webhook 的安全與錯誤語意（P0），再在 POST 事件迴圈前整批寫入追蹤事件並以事件 ID 去重（P1），最後以 outbox 推送 CRM（P2-bot）。純判斷邏輯放 `src/lib/tracking/`，webhook 主流程從 route 抽到 `src/lib/line/webhook.ts` 以便測試（Next route 檔不能匯出額外名稱）。

**Tech Stack:** Next 15 app router。**正式環境實際在 Vercel**（`line-bot-external.drone168.com` → Vercel 專案 `line-bot-external`，main push 即部署 production）；repo 另有 vinext → Cloudflare Workers 設定。Supabase（quote-drone168，從表推定）、node:test + tsx（已安裝，不加依賴）。

**Spec:** pm 方案 v3 `line-tracking-plan.md`（範圍以它為準）；細節參考原規格 `~/Downloads/review-line-tracking.md` 中 v3 採用的部分。

## Global Constraints

- 不加新依賴；測試用 `node --import tsx --test`。
- 不 merge、不部署、不 apply 遠端 migration、不改 Cloudflare／Vercel／LINE 設定；commit／push 分支／開 PR 已獲授權。**merge 到 main = Vercel 自動部署 production**。
- 追蹤不存聊天全文、附件或 reply token。
- 簽章：缺 secret／長度不符／錯誤一律拒絕，不得跳過驗證繼續處理。
- LINE 重送目前**關閉**（使用者確認）：P0 可單獨上線；**重送要等 P1 去重上線並驗證後才開**。

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

## P1（已實作，分支 `feat/line-tracking-p1`，疊在 P0 上）

實作與原大綱的差異都寫在下面；測試即規格。

### Task 4: 型別與 migration — `supabase/migrations/003_line_tracking.sql`
- 表：`line_tracking_sources`、`line_tracking_touches`、`line_tracking_events`（`account_id + webhook_event_id` 唯一；`tracking_status`／`reply_status`／`crm_sync_status` 三個獨立狀態）、`line_tracking_unsent`（tombstone）；view `line_tracking_health`（security_invoker，診斷用）。
- 寫入全部走 SQL 函式（原子、可在本機 Postgres 驗證）：`record_events`、`process_event`、`claim_reply`（回傳嘗試次數，0＝沒搶到）、`finish_reply`、`create_touch`、`lease_crm`、`finish_crm`。
- 權限：4 張表開 RLS、不建 policy；表、view、函式都 `REVOKE` anon／authenticated，函式只 `GRANT` 給 service_role。
- 來源不在 migration 裡 seed，上線時由營運用 SQL 新增（檔頭有範例）。
- 併發：同一則訊息的原訊息與 unsend 以 `(account, message_id)` advisory lock 序列化，而且一律先拿 advisory lock、再拿列鎖（固定順序，避免死鎖）；每個來源的新 touch 配額也用 advisory lock，讓計數和 insert 成為原子操作；測試 touch 不論走哪個分支都保留 `is_test`。
- 驗證：`npm run test:db`（暫時性本機 Postgres 叢集：SQL 斷言＋三個雙連線競態測試〔message 先、unsend 先、配額〕，含 S01 權限；拿掉 lock 時競態測試會失敗）。

### Task 5: webhook 整批寫入與回覆 claim — `src/lib/line/webhook.ts`
- 驗簽 → `events: []` 回 200 → 缺 `destination`／`webhookEventId`／`timestamp` 回 400 → **整批 `record_events`，失敗就回 500、一則都不回覆** → 每個事件：`process_event`（失敗不擋回覆、回 500 讓重送補做）→ `claim_reply` → handler → `finish_reply`。
- 是否處理看持久化的 `reply_status`，不看是否新插入（已入庫但沒 claim 的事件，重送時可以恢復處理）。
- 錯誤語意（pm 裁決）：LINE 4xx → `failed`（終態，回 200）；先前已失敗過一次再遇到 4xx → `unknown`（第一次可能其實已送達）；5xx／網路／其他錯誤 → 放回 `pending` 並回 500。上班時間或暫停時略過 → `skipped`（終態）。寫入 `sent` 失敗 → 停在 `sending`，絕不重送（由 health view 觀察）。
- follow 推播帶 `X-Line-Retry-Key`（由 webhookEventId 推導；LINE 保證 24 小時內去重），重送時收到 409＋`x-line-accepted-request-id` 視同已送。
- 測試帳號：環境變數 `LINE_TEST_USER_IDS`（逗號分隔），或來源設 `is_test`。

### Task 6: token 與 `/line/start`
- `src/lib/tracking/token.ts`：`L-` + 32 位 hex（HMAC-SHA256(`LINE_TRACKING_TOKEN_SECRET`, 冪等鍵)），不可能被報價編號 regex 誤判；DB 只存 sha256。交給 handler 前會先去掉 token，訊息只剩 token 時改成「您好」。
- `POST /api/line/touch`（`src/lib/tracking/touch.ts`）：source_key 格式白名單＋DB 必須是啟用中的來源；目的地固定是官方帳號（不會變成開放轉址）；TTL 用 `LINE_TRACKING_TOKEN_TTL_DAYS`（預設 30 天）。只接受 `application/json`（415）、body ≤ 1KB（413）、每個來源每分鐘最多 120 個新 touch（429；同一冪等鍵重試不受限）。規格寫明第一階段不收集 IP，所以 per-IP 節流放在平台 WAF（待決定）。
- `GET /line/start?source=`：只顯示內容、不寫 DB（A01）；按下按鈕才 POST，冪等鍵在每次頁面瀏覽時產生（A02）；有開啟失敗時的複製訊息與加好友備援。**桌面 QR 未做**（需要新依賴，待決定）。

### Task 7: 撤回
- 在 SQL `process_event` 裡處理：寫 tombstone、撤銷由該訊息綁定的 touch、原訊息標成 `retracted`、尚未送出的 CRM 推送改 `cancelled`；比 unsend 晚到的原訊息也是 `retracted`。

## P2-bot（已實作）

### Task 8: outbox 推送 CRM — `src/lib/tracking/crm-push.ts`
- 契約：be-crm `2026-10-16-line-inquiry-rpc-interface.md` §4／§5。HMAC 簽 `"<timestamp>.<body>"`，header 用 `X-Drone168-Timestamp`／`X-Drone168-Signature`；`matched` 以外的狀態一律不帶 sourceKey。
- 每人每個來源只推第一次詢問（unknown 也算一個來源）；`displayName` 送出時才查 LINE profile，bot 端不存。
- 回應處理：200 → `sent`；422／405 → `failed`；401／503／5xx／網路 → 退避重試（1 分鐘起倍增，上限 6 小時，最多 10 次）。
- 租約與送出 claim：每次 lease 配一個新 token。每筆送出前做原子 claim（`pending/sending → sending`，token 相符且租約未過期），這是和 unsend 取消競爭的唯一決勝點：取消先成功就不送；claim 先成功就視為已開始外送，之後 unsend 不會再標成取消。嘗試過的列（attempts > 0）也不能取消，因為可能已經送達。finish 必須是 `sending` 且 token 相符，舊 worker 晚到的結果會被忽略。worker 中途死掉留下的 `sending`，租約到期後會重新 lease 並重送（CRM 依 botEventRef 冪等）。
- 時間預算：Supabase RPC 一律 5 秒 timeout；一批 10 筆；30 秒後不再開始新的一筆（單筆最壞 23 秒）；cron route `maxDuration=60`。
- 開關：要同時有 `CRM_PUSH_ENABLED=true`、`CRM_INGEST_URL`、`LINE_INQUIRY_INGEST_SECRET` 才會推送，否則 outbox 原封不動。
- 排程：spike 成功（自訂 `worker/index.ts` 的 `scheduled` 在本機 wrangler 觸發可用）。但正式環境在 Vercel，所以另加 `GET /api/cron/crm-outbox`（`Bearer $CRON_SECRET`）＋ `vercel.json` cron（每 5 分鐘）。兩邊共用 `flushCrmOutbox`，lease 機制保證同時跑也安全。Vercel 方案頻率限制待確認。

## 上線步驟（每步都要使用者核准）

1. **P0（PR #2）**：Vercel 設 `BOT_PAUSE_API_TOKEN` → merge（＝部署 production）→ 用簽章錯的請求確認回 401。LINE 重送維持關閉。
2. **P1 程式**：merge（＝部署）。這時 `LINE_TRACKING_ENABLED` 還沒設，行為和 P0 完全相同（不碰追蹤表），所以和 migration 誰先誰後都安全。
3. **P1 DB 與開關**：在 quote-drone168 apply `003_line_tracking.sql`（先確認正式環境的 `SUPABASE_URL` 確實指向這個專案）→ 新增正式廣告來源（`enabled=false`），另建一個專用測試來源（`enabled=true, is_test=true`）→ Vercel 設 `LINE_TRACKING_TOKEN_SECRET`（必要時加 `LINE_TEST_USER_IDS`）→ 最後設 `LINE_TRACKING_ENABLED=true`，並**建立新的 production deployment**（Vercel 的環境變數只對新的 deployment 生效）→ 用專用測試帳號走 `/line/start?source=<測試來源>` → 送出 → 檢查 events／touches／health。
4. 驗證去重之後，才在 LINE console **開啟重送**。
5. 把一個來源設 `enabled=true`，換掉一支廣告入口試行。
6. **P2**：CRM ingest 上線後，Vercel 設 `CRM_INGEST_URL`、`LINE_INQUIRY_INGEST_SECRET`、`CRON_SECRET`，最後才設 `CRM_PUSH_ENABLED=true`，然後 redeploy 讓新值生效。
7. 回復方式（依序）：① 先在 LINE console 關閉重送（關掉追蹤就失去去重）；② 來源 `enabled=false`（立即生效，因為存在 DB）；③ 移除 `LINE_TRACKING_ENABLED`／`CRM_PUSH_ENABLED`，並**建立新的 production deployment**（只移除 env 不會影響已在跑的 deployment）；④ 用簽章錯誤的探測請求，以及 touch API 回 503，確認開關真的關了。要 rollback 時，必須選一個確定追蹤和推送都是關閉的版本，「前一個 deployment」不一定符合。資料表保留，不用刪表回復。
