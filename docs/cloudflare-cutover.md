# line-bot-external：正式環境從 Vercel 切到 Cloudflare Workers

> 執行順序與資料庫搬遷已合併到 `docs/cutover-runbook.md`，兩者有出入時以 runbook 為準。本文件保留背景與細節。

決定（2026-10-16）：line bot 正式環境維持在 Cloudflare Workers；CRM 留在 Vercel。
現況：`line-bot-external.drone168.com` 目前是一筆 **DNS only（灰雲）CNAME → `*.vercel-dns-016.com`**，由 Vercel 專案 `line-bot-external` 服務。同一個 GitHub repo 也接了 Cloudflare Workers Builds，main 的每次 push 都會**同時**部署到 Vercel production 和 Worker `line-bot-external` 的 production（workers.dev）。

本文件只是清單。每一步雲端操作都由有權限的人在後台執行，並事先核准。

## 0. 前提檢查（切換前一次確認）

- [ ] **Workers 方案是 Paid**。免費方案每個請求只有 10ms CPU、50 個 subrequest。一個文字訊息事件大約會打 10–14 個 subrequest（追蹤 RPC 4 個、history 2 個、Claude 最多 3 次、知識庫搜尋、reply），一批 5 個事件就超過 50。CRM flush 一次最多 41 個。Paid 方案的上限以[官方限制頁](https://developers.cloudflare.com/workers/platform/limits/)為準（2026-10-16 查核：subrequest 預設 10,000、CPU 預設 30 秒；等待 I/O 不計入 CPU）。
- [ ] **drone168.com 的 zone 和 Worker 在同一個 Cloudflare 帳號**（custom domain 的必要條件）。已用 dig 確認 NS 是 `kyle/melany.ns.cloudflare.com`，代表 DNS 在 Cloudflare 上，但是不是同一個帳號，只能在後台確認。
- [ ] Workers Builds 的 build／deploy 指令（Settings → Builds）會產出 `wrangler.jsonc` 指定的 `./worker/index.ts`。PR #3 的 Workers Builds check 是 pass。
- [ ] 記下 workers.dev 網址：Worker → Settings → Domains & Routes → `line-bot-external.<子網域>.workers.dev`，並確認是啟用狀態。下文用 `$WORKER` 代表它。
- [ ] 記下 Vercel production 的備用網址（`*.vercel.app` production alias），用於回退。確認它沒有被 Deployment Protection 擋住。

## 1. 環境變數（從程式碼 grep 出的完整清單）

依據：`grep -rhoE "process\.env\.[A-Z0-9_]+" src worker`（PR #3 版本）。Workers 在 `nodejs_compat` 加上相容日期 ≥ 2025-04-01 時，會把變數和 secret 帶進 `process.env`（官方文件已確認）。

**全部用 Secret 設定**（Dashboard → Worker → Settings → Variables and Secrets → Type: Secret，或 `wrangler secret put`）。原因有兩個：
- 一般變數若在 dashboard 設定，下一次 `wrangler deploy` 會被設定檔覆蓋掉；secret 永遠不會被部署刪除。
- repo 是公開的，所以 `wrangler.jsonc` 不放任何值。

值從 Vercel 專案 `line-bot-external` 的 Production env 逐一抄過去，不要經過聊天、issue 或檔案。

| 變數 | 用途 | 機密 | 何時必要 |
|---|---|---|---|
| `LINE_CHANNEL_SECRET` | webhook 驗簽 | **是** | 切換前（沒設的話 webhook 回 500） |
| `LINE_CHANNEL_ACCESS_TOKEN` | reply／push／圖片下載／profile | **是** | 切換前 |
| `ANTHROPIC_API_KEY` | AI 客服 | **是** | 切換前 |
| `VOYAGE_API_KEY` | 知識庫 embedding（RAG 搜尋） | **是** | 切換前 |
| `SUPABASE_URL` | quote-drone168 | 否（但不放進 repo） | 切換前 |
| `SUPABASE_SERVICE_ROLE_KEY` | quote-drone168 service role | **是** | 切換前 |
| `QUOTE_SUPABASE_URL`／`QUOTE_SUPABASE_SERVICE_ROLE_KEY` | 上一列的備用名稱（程式用 `??` 取用） | 同上 | 兩組擇一，沿用 Vercel 上實際有設的那組 |
| `BOT_PAUSE_API_TOKEN` | `/api/bot-pause`、`/api/health/anthropic` 驗證 | **是**（要選 Secret 型別，不要用 Variable） | 已設（使用者 2026-10-16） |
| `BOT_PAUSE_HOURS` | 暫停時數，預設 2 | 否 | 選用 |
| `BUSINESS_HOURS_START`／`_END`／`_TZ`／`_DAYS` | 上班時間略過 AI，預設 9／18／Asia/Taipei／1–5 | 否 | 選用（Vercel 有設才照抄） |
| `MANAGER_LINE_ALERT_URL` | 轉真人通知：manager-line 的 `/alert` 完整網址（LINE 推給 Teddy） | 否 | **必設**：沒有任何通知管道時，bot 會告訴客戶轉接失敗、請直接打電話 |
| `MANAGER_LINE_ALERT_TOKEN` | 上一列的 Bearer，值和 manager-line 的 `ALERT_BEARER` 相同 | **是** | 和上一列一起設 |
| `SENDGRID_API_KEY` | 轉真人 email 通知 | **是** | 選用 |
| `NOTIFY_EMAIL_TO`／`NOTIFY_EMAIL_FROM` | 通知收件人／寄件人 | 個資，用 secret | 選用 |
| `LINE_TRACKING_ENABLED` | P1 追蹤開關，`true` 才啟用 | 否 | P1 上線時才設 |
| `LINE_TRACKING_TOKEN_SECRET` | 來源 token 的 HMAC 金鑰 | **是** | P1 上線時才設（新產生，至少 32 bytes 亂數） |
| `LINE_TRACKING_TOKEN_TTL_DAYS` | token 有效天數，預設 30 | 否 | 選用 |
| `LINE_TEST_USER_IDS` | 測試帳號的 LINE user ID（逗號分隔） | 個資，用 secret | 驗收時 |
| `CRM_PUSH_ENABLED` | P2 推送開關，`true` 才推送 | 否 | P2 上線時才設 |
| `CRM_INGEST_URL` | CRM edge `line-inquiry-ingest` | 否 | P2 上線時才設 |
| `LINE_INQUIRY_INGEST_SECRET` | 推送的 HMAC，和 CRM 同一個值 | **是** | P2 上線時才設 |
| `CRON_SECRET` | **只有 Vercel cron route 用**；Cloudflare 不需要 | — | 不要設（見 §5） |

`scripts/seed-knowledge.ts` 是本機腳本，只讀 Supabase 和 Voyage 的變數，與 Worker 無關。

## 2. 用 workers.dev 驗證（不用真實客戶）

用 secret 設定新值後，Cloudflare 會建立一個新的 Worker version。以下都打 `$WORKER`，正式網域與 LINE 設定都不動。

```bash
WORKER="https://line-bot-external.<子網域>.workers.dev"
# LINE_CHANNEL_SECRET 只放在自己終端機的環境變數裡，不要貼進任何地方
sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$LINE_CHANNEL_SECRET" -binary | base64; }
```

1. **基本**：`curl -s $WORKER/ | grep -o '<title>[^<]*'` → `LINE Bot — GDS 低空作業`。
2. **簽章**：
   - 沒有簽章：`curl -s -o /dev/null -w '%{http_code}' -X POST $WORKER/api/webhook -d '{"events":[]}'` → `401`。
   - 錯誤長度：加上 `-H 'x-line-signature: short'` → `401`。
   - 正確簽章、空事件（等同 LINE 的 Verify）：
     `B='{"destination":"Utest","events":[]}'; curl -s -w ' %{http_code}' -X POST $WORKER/api/webhook -H "x-line-signature: $(sign "$B")" -H 'content-type: application/json' -d "$B"` → `{"ok":true} 200`。
     如果回 `500 Server misconfigured`，代表 `LINE_CHANNEL_SECRET` 沒有讀到。
3. **secret 有生效**：`curl -s -o /dev/null -w '%{http_code}' $WORKER/api/bot-pause` → `401`。回 `503` 代表 `BOT_PAUSE_API_TOKEN` 沒讀到。
4. **合成事件（回覆路徑與 DB 寫入）**：用假的 user ID 和假的 replyToken，送一個帶假報價編號的文字訊息。報價查詢 24 小時都會跑，所以不受上班時間影響。
   **前提**（假的 reply token 只會擋住最後的 LINE 回覆，擋不住前面的副作用）：
   - `CRM_PUSH_ENABLED` 必須是關閉的（照計畫，切換本來就排在 P1／P2 開關之前）。如果 P1 已經開了，要先把假 user ID 加進 `LINE_TEST_USER_IDS`。
   - AI 有可能呼叫 `request_human`，這會對 Discord／email 發出轉真人通知並寫入 `bot_pause`。要先在通知頻道告知「切換測試，請忽略」，清理時也要一併刪除。
   ```bash
   B='{"destination":"Utest","events":[{"type":"message","webhookEventId":"cutover-test-1","timestamp":'$(date +%s000)',"replyToken":"00000000000000000000000000000000","source":{"type":"user","userId":"Ucutovertest000000000000000000001"},"message":{"type":"text","id":"cutover-m1","text":"查報價 Q-00000000-000"}}]}'
   curl -s -w ' %{http_code}\n' -X POST $WORKER/api/webhook -H "x-line-signature: $(sign "$B")" -H 'content-type: application/json' -d "$B"
   ```
   - 預期 `{"ok":true} 200`：Claude 有回答，LINE reply 因為 token 是假的而回 4xx，這是終態（P1 開了才會記成 failed）。
   - 用 `npx wrangler tail line-bot-external`，或 dashboard → Logs，應該看到 `LINE API reply failed: 400`。這代表 access token 驗證過了，只是 reply token 無效；如果是 401，就是 access token 錯了。
   - DB（唯讀查詢）：`select role, left(content, 30) from chat_history where user_id = 'Ucutovertest000000000000000000001' order by created_at;` 正常路徑會有 user 和 assistant 兩列。AI 走 fallback 時可能只有 user 那一列，這時看 Logs 判斷。
   - 測完刪掉測試資料（寫入正式 DB，要先核准）：`delete from chat_history where user_id = 'Ucutovertest000000000000000000001'; delete from bot_pause where user_id = 'Ucutovertest000000000000000000001';`；P1 已上線的話再加 `delete from line_tracking_events where account_id = 'Utest';`（`Utest` 是這裡用的假 destination，不是正式帳號）。
   - P1 已上線且 `LINE_TRACKING_ENABLED=true` 時，另外查 `line_tracking_events where webhook_event_id = 'cutover-test-1'`：`reply_status` 應該是 `failed`、`tracking_status` 是 `no_token`。用同一個 body 再送一次，應該仍是 200，且沒有第二次 reply（去重）。
5. **cron**（P2 之後）：Worker → Settings → Triggers 有 `*/5 * * * *`；Logs 裡 scheduled 事件沒有錯誤。`CRM_PUSH_ENABLED` 沒設的時候會直接略過，不碰 DB。

## 3. 切換方式：先切 LINE webhook，再換 DNS（不中斷）

LINE 重送目前是關閉的，切換期間沒送到的事件就會遺失。因此**先把流量從 LINE 端直接導到 workers.dev，再動 DNS**，DNS 和憑證的空窗就不會影響客服。

1. **建議時段**：平日 22:00–23:00（台北）。避開上班時間，也還有人能盯著。避開週一早上和廣告剛換素材的時候。
2. 以 LINE Developers console 的設定為準，記下目前的 Webhook URL：`https://line-bot-external.drone168.com/api/webhook`。
3. **把 LINE Webhook URL 改成 `$WORKER/api/webhook`** → 按 Verify，預期 Success。
4. 立即用**員工測試帳號**傳一句話（非上班時間 AI 會回覆），再傳一張圖片，確認都有回覆；Logs 沒有 500。這是第一次用真實 LINE 帳號，但不是客戶。
5. 觀察 15 分鐘：Worker Logs 的錯誤率、`chat_history` 有新的列。
6. **DNS**（Cloudflare dashboard → drone168.com → DNS）：
   - 刪除 `line-bot-external` 這筆 CNAME（→ vercel-dns）。custom domain 要求這個 hostname 沒有既有記錄；TTL 是 300 秒。
   - Worker → Settings → Domains & Routes → Add → Custom domain → `line-bot-external.drone168.com`。Cloudflare 會自動建立 proxied 記錄並簽發憑證。
7. 等憑證生效，同時 **LINE 繼續打 workers.dev**：
   - `curl -sI https://line-bot-external.drone168.com/ | grep -i '^server'` → `cloudflare`。
   - 公開 resolver 都已更新：`dig +short line-bot-external.drone168.com @1.1.1.1`、`@8.8.8.8`、`@168.95.1.1` 都回 Cloudflare 的 IP，不再是 `vercel-dns`。
   - 從 DNS 變更算起至少等 **30 分鐘**（記錄 TTL 是 300 秒，但上游快取可能更久），再用 §2 的 1–3 項對正式網域跑一次。
8. **把 LINE Webhook URL 改回 `https://line-bot-external.drone168.com/api/webhook`** → Verify → 用員工帳號再測一次。
9. Vercel：**`line-bot-external.drone168.com` 的網域綁定再保留 24 小時**，讓還留著舊快取的人仍然打得到服務；24 小時後才到 Settings → Domains 移除。專案和最後一個 production 保留一週當回退目標，期間不要在 Vercel 設任何 P1／P2 的開關。

## 4. 回退

先決定能回退到哪裡，分界是「**舊的 CNAME 記錄有沒有動過**」：

- **CNAME 還沒動**（步驟 3–5）：把 LINE Webhook URL 改回 `https://line-bot-external.drone168.com/api/webhook`。它仍然指向 Vercel，立即生效。
- **CNAME 已刪或已改**（步驟 6 之後，不論 custom domain 或憑證有沒有好）：
  1. 先把 LINE Webhook URL 改成 Vercel production alias（`https://<vercel-production-alias>/api/webhook`），立即生效，不用等 DNS。
  2. 想讓正式網域也回到 Vercel：移除 Worker 的 custom domain → 重建 CNAME `line-bot-external` → `9fd7d06a5da34303.vercel-dns-016.com`（**DNS only，灰雲**）→ 在 Vercel 專案加回這個網域，並等它重新驗證、簽發憑證。
- **如果 LINE 重送已經開啟**（P1 上線之後）：Vercel 沒有開追蹤，就沒有去重。所以要**先在 LINE console 關閉重送，再把流量切回 Vercel**，否則重送的事件會重複觸發 AI、history 和真人通知。另一個選項是先讓 Vercel 開同一套追蹤（共用 DB，去重可以跨平台），驗證之後再切流量。
- CRM 推送：只在實際接收流量的那一邊開 `CRM_PUSH_ENABLED`。兩邊同時開也不會重複送（有租約和 claim），但排查時會很難分辨是哪一邊送的。

## 5. 切換後 P2 改用 Workers cron

PR #3 已經內建 Workers 版本：`wrangler.jsonc` 的 `triggers.crons: ["*/5 * * * *"]` 加上 `worker/index.ts` 的 `scheduled()` → `flushCrmOutbox()`。所以：

- [ ] 不需要改程式就能用：PR #3 merge 後，Workers Builds 部署時就會註冊 cron。`CRM_PUSH_ENABLED` 沒設之前每 5 分鐘只會略過。
- [ ] 在 **Cloudflare** 設 `CRM_INGEST_URL`、`LINE_INQUIRY_INGEST_SECRET`，最後才設 `CRM_PUSH_ENABLED=true`。**不要設 `CRON_SECRET`**。
- [ ] 確認 Vercel 那邊**沒有**設 `CRM_PUSH_ENABLED`，避免兩邊同時推送。
- [ ] 切換穩定一週後開一個小 PR：刪掉 `vercel.json`、`src/app/api/cron/crm-outbox/route.ts`、`tests/cron-route.test.ts`，以及 cron route 裡的 `maxDuration`（那是 Vercel 專用）。`src/lib/services/bearer-auth.ts` 仍給 bot-pause 用，要保留。同時停用 Vercel 專案的 Git 自動部署，或直接刪除專案。
- [ ] 時間預算：flush 最壞約 58 秒 wall time（大部分在等 I/O，不計入 CPU）。Cron trigger 的 wall time 上限是 15 分鐘，CPU 上限 30 秒（[官方限制頁](https://developers.cloudflare.com/workers/platform/limits/)）。subrequest 正常路徑每輪最多 41 個。

## 需要在後台操作的步驟（給使用者）

1. Cloudflare：確認 Workers Paid 方案、drone168.com zone 在同一個帳號、workers.dev 有啟用。
2. Cloudflare：依 §1 設 secret（從 Vercel 抄值）。
3. 用 §2 驗證 workers.dev（任何有 channel secret 的人都可以在自己的終端機跑），並刪除測試的 `chat_history` 列。
4. LINE console：Webhook URL → workers.dev（§3 步驟 3），用員工帳號測試。
5. Cloudflare DNS：刪除 CNAME，加上 Worker custom domain（§3 步驟 6）；確認公開 resolver 都已更新，並等至少 30 分鐘（§3 步驟 7）。
6. LINE console：Webhook URL 改回正式網域（§3 步驟 8）。
7. Vercel：24 小時後移除網域，專案保留一週（§3 步驟 9）。
