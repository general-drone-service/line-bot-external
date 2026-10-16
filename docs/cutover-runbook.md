# line-bot-external 切換 runbook：Cloudflare Workers ＋ 資料庫搬到 CRM

這份 runbook 合併兩件事：

- **Cloudflare 切換**：正式流量從 Vercel 移到 Cloudflare Workers。細節與背景見 `docs/cloudflare-cutover.md`；兩份有出入時，**以本文件為準**。
- **資料庫搬到 CRM**：bot 的資料從 quote-drone168 搬到 CRM 的 `line_bot` schema，經 CRM edge 閘道 `line-bot-data` 存取。
  - 設計見 CRM repo `docs/superpowers/specs/2026-10-16-line-bot-db-to-crm-design.md` 的 §4.3／§4.4。
  - 程式在 CRM #1207，以及 bot #4（切換能力）、#5（閘道 client）。

最後接著寫**來源追蹤的開啟順序**，以及 quote-drone168 的待辦。

## 怎麼讀

**「誰做」欄位**：
- **使用者**：使用者親手在後台、終端機或手機操作。
- **agent（使用者下令）**：由 agent 執行，但必須是使用者在對話中直接下的指令。例如 be-crm 套用 migration，或 rev-* 在 pm 核准後 merge。
- **pm 唯讀**：pm（或任何 agent）只讀不寫的驗證，例如 curl、dig、Logs、唯讀 SQL。

**通用規則**：
- 所有值，包括 secret、密碼、DB 連線字串，只在使用者自己的終端機或後台輸入，不貼進聊天、issue 或檔案。
- 終端機輸入一律用 `read -rs`，不要寫在指令列上，避免留在 shell 歷史。
- **每一個寫入正式 DB 的步驟，執行前都要使用者核准**。
- Worker secret 一律用 **Secret** 型別設定，原因見 `cloudflare-cutover.md` §1。
  - 在 Cloudflare 後台的位置是 Worker `line-bot-external` → Settings → Variables and Secrets。
  - 每存一次，Cloudflare 會建立並部署一個新 version，幾秒內生效。
- 下文用到的代號：
  - `$WORKER`：`https://line-bot-external.<子網域>.workers.dev`
  - `$GW`：`https://<CRM project ref>.supabase.co/functions/v1/line-bot-data`
  - `$PROD`：`https://line-bot-external.drone168.com`

**常用工具**（在使用者自己的終端機）：

```bash
# LINE webhook 簽章（測 webhook 用）
read -rs LINE_CHANNEL_SECRET; export LINE_CHANNEL_SECRET
sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$LINE_CHANNEL_SECRET" -binary | base64; }

# CRM 閘道呼叫（測閘道用）；簽法同 line-inquiry-ingest：sha256= hex HMAC("<unix 秒>.<body>")
read -rs GW_SECRET; export GW_SECRET
gw() {
  local b="{\"action\":\"$1\",\"args\":$2}" ts; ts=$(date +%s)
  local sig; sig=$(printf '%s' "$ts.$b" | openssl dgst -sha256 -hmac "$GW_SECRET" -hex | awk '{print $NF}')
  curl -s -w ' %{http_code}\n' -X POST "$GW" -H 'content-type: application/json' \
    -H "x-drone168-timestamp: $ts" -H "x-drone168-signature: sha256=$sig" -d "$b"
}

# 搬資料用的 DB 連線（Supabase 後台 → Connect → Session pooler 的連線字串，含密碼）
read -rs QUOTE_DB_URL; read -rs CRM_DB_URL; export QUOTE_DB_URL CRM_DB_URL
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT   # 匯出檔含個資，結束就刪

# 每次匯出都寫到新的暫存檔；匯出失敗就不印檔名，後面的匯入不會執行（避免拿舊檔匯入）
export_csv() {  # $1=來源連線  $2=select 查詢 → stdout 印出新檔路徑
  local f; f=$(mktemp "$W/export.XXXXXX") || return 1
  psql "$1" -v ON_ERROR_STOP=1 -c "\copy ($2) to '$f' csv" >&2 || { echo "匯出失敗，停止" >&2; return 1; }
  echo "$f"
}
```

搬資料的每一段都寫成 `F=$(export_csv …) && psql …`：來源匯出失敗時整段停止，不會拿上一次留下的檔案匯入。

## 整體順序

```
前置 A（白天）：程式合併與部署 ──► 窗口 1（平日 22:00）：Cloudflare 切換
                                        │ 穩定 ≥ 1 天
前置 B（白天）：CRM 準備、資料預搬 ──► 窗口 2（平日 22:00）：資料庫切到 CRM
                                        │ 回退窗口 1 週
                                   追蹤開啟（P1 → 重送 → P2 → 第一支廣告）
```

**窗口 1 必須先完成**。CRM 閘道的 secret 只設在 Cloudflare，Vercel 沒有。所以 `BOT_DB=crm` 之後，Vercel 已經不是有效的回退目標。

## 前置 A：程式合併與部署（白天，不影響客服）

| # | 誰做 | 在哪裡 | 動作 | 驗證與預期 | 失敗時 |
|---|---|---|---|---|---|
| A1 | agent（pm 核准後 merge） | GitHub | 合併 bot #4。main 的 push 會同時部署 Vercel production 與 Worker | pm 唯讀：Workers Builds 與 Vercel 的部署都成功；`curl -s -o /dev/null -w '%{http_code}' $PROD/api/bot-pause` 回 `401` | GitHub revert #4，兩邊會自動重新部署 |
| A2 | pm 唯讀 | Worker Logs、LINE | 非上班時間用員工帳號傳一句話 | AI 有回覆；Logs 沒有 500 | 同 A1 |
| A3 | 使用者 | Cloudflare 後台 | 確認 Workers Paid 方案、drone168.com 的 zone 與 Worker 在同一個帳號、workers.dev 已啟用；記下 `$WORKER` | 後台看得到 | 先解決再往下 |
| A4 | 使用者 | Cloudflare 後台 | 依 `cloudflare-cutover.md` §1 的表，從 Vercel 抄值、設好 Worker secret。這時**不要**設 `BOT_DB`、`BOT_CUTOVER_FREEZE`、追蹤與推送的開關 | 用 `cloudflare-cutover.md` §2 的 1–3 項打 `$WORKER`：首頁標題正確；webhook 沒有簽章回 `401`、正確簽章的空事件回 `{"ok":true} 200`；`/api/bot-pause` 回 `401` | 改正 secret 後重測 |
| A5 | 使用者（終端機） | `$WORKER` | 合成文字事件（`cloudflare-cutover.md` §2 第 4 項）。**#4 之後報價查詢已關閉**，所以改用一般文字，例如「想洗外牆」，並在非上班時間送 | 回 `200`；Logs 有 `LINE API reply failed: 400`（假 reply token，屬正常）；quote-drone168 的 `chat_history` 有該假 user 的 user 和 assistant 兩列 | 看 Logs 修 secret |
| A6 | 使用者（核准後寫入） | quote-drone168 SQL | 刪除 A5 的測試列：`delete from chat_history where user_id = 'Ucutovertest000000000000000000001'; delete from bot_pause where user_id = 'Ucutovertest000000000000000000001';` | 兩個 `delete` 的列數合計 2（`bot_pause` 為 0） | — |

## 窗口 1：Cloudflare 切換（平日 22:00，約 60–75 分鐘，大多在等 DNS）

已經做完的話，跳到前置 B。

| # | 分鐘 | 誰做 | 在哪裡 | 動作 | 驗證與預期 | 失敗時 |
|---|---|---|---|---|---|---|
| W1-1 | 2 | 使用者 | LINE Developers console | 記下目前的 Webhook URL（`$PROD/api/webhook`），改成 `$WORKER/api/webhook` → Verify | Verify 顯示 Success | 改回 `$PROD/api/webhook`。CNAME 還沒動，所以還是 Vercel，立即生效 |
| W1-2 | 3 | 使用者 | 員工手機 | 傳一句文字、一張圖片 | 都有回覆 | 同 W1-1 |
| W1-3 | 15 | pm 唯讀 | Worker Logs | 觀察 | 沒有 500；有 webhook 請求進來 | 同 W1-1 |
| W1-4 | 3 | 使用者 | Cloudflare → drone168.com → DNS；Worker → Domains & Routes | 刪除 CNAME `line-bot-external`（指向 vercel-dns）→ 加 Custom domain `line-bot-external.drone168.com` | `curl -sI $PROD/ \| grep -i '^server'` 最後回 `cloudflare` | 見下方「窗口 1 回退」 |
| W1-5 | 30 以上 | pm 唯讀 | 終端機 | `dig +short line-bot-external.drone168.com @1.1.1.1`、`@8.8.8.8`、`@168.95.1.1` | 三個 resolver 都回 Cloudflare 的 IP；從改 DNS 算起已滿 30 分鐘；用 `cloudflare-cutover.md` §2 的 1–3 項打 `$PROD` 都通過 | 繼續等。LINE 這時仍打 workers.dev，不影響客服 |
| W1-6 | 3 | 使用者 | LINE console、員工手機 | Webhook URL 改回 `$PROD/api/webhook` → Verify → 傳一句話 | Success；有回覆 | 改回 `$WORKER/api/webhook` |
| W1-7 | 24 小時後 | 使用者 | Vercel → Settings → Domains | 移除 `line-bot-external.drone168.com`。專案保留一週，期間不要在 Vercel 設任何新開關 | — | — |

**窗口 1 回退**：分界是「舊的 CNAME 有沒有動過」。

- 還沒動：把 LINE Webhook URL 改回 `$PROD/api/webhook`。
- 動過了：LINE Webhook URL 改成 Vercel production alias（`https://<alias>.vercel.app/api/webhook`），立即生效。正式網域要回到 Vercel 的步驟見 `cloudflare-cutover.md` §4。

## 前置 B：CRM 準備與資料預搬（白天，不影響客服）

| # | 誰做 | 在哪裡 | 動作 | 驗證與預期 | 失敗時 |
|---|---|---|---|---|---|
| B1 | agent（rev-crm 在 pm 核准後 merge；be-crm 依使用者指令套 migration） | GitHub、CRM 正式 Supabase | 合併 CRM #1207 → 部署 edge `line-bot-data` → 套 `20261016125544_line_bot_schema.sql`（先 dry run，再 apply）。只新增 schema、表、函式和開關 `feature_flags.line_bot_data = false`，不動既有資料 | pm 唯讀：`line_bot` schema 與 16 支 `public.line_bot_*` 函式存在；`select enabled from feature_flags where flag_key = 'line_bot_data'` 是 `false` | migration 檔頭有 down 步驟；edge 撤回部署 |
| B2 | 使用者 | 終端機、Supabase 後台、Cloudflare 後台 | 產生閘道密鑰 `openssl rand -hex 32`（只顯示在自己的終端機），設到兩個地方：CRM 的 Edge Functions → Secrets → `LINE_BOT_DATA_SECRET`；Worker 的 Secret `LINE_BOT_DATA_SECRET`。Worker 另設 Secret `LINE_BOT_DATA_URL` = `$GW` | 開關還沒開，所以：沒有簽章 `curl -s -o /dev/null -w '%{http_code}' -X POST $GW -d '{}'` 回 `401`；`gw pause.get '{"p_user_id":"Utest"}'` 回 `{"error":"Disabled",...} 503`。**回 401 代表兩邊的密鑰不一致** | 重設成同一把 |
| B3 | agent（pm 核准後 merge） | GitHub | 合併 bot #5（先把 base 改成 main）。Worker 這時 `BOT_DB` 仍未設，等同 `quote` | 員工帳號傳一句話有回覆；Logs 沒有 `Invalid BOT_DB`、`needs LINE_BOT_DATA_URL` | revert #5 |
| B4 | 使用者（核准後寫入 CRM） | 終端機 psql | 知識庫：先比對兩邊 62 列 → 用 COPY 搬過去（向量完全相同，不需要 Voyage）：<br>`F=$(export_csv "$QUOTE_DB_URL" "select id, source, heading, content, embedding::text, created_at from public.knowledge_chunks") && psql "$CRM_DB_URL" -v ON_ERROR_STOP=1 -c "\copy line_bot.knowledge_chunks (id, source, heading, content, embedding, created_at) from '$F' csv"` | 兩邊 `select count(*), count(distinct source)` 一致（62 列） | `delete from line_bot.knowledge_chunks` 後重來 |
| B5 | 使用者（核准後寫入 CRM） | 終端機 psql | 預先複製 `chat_history`，可以重複執行（見下方「SQL：複製 chat_history」） | `missing` = 0 | 可以重跑 |
| B6 | pm 唯讀 | — | 確認 #5 已部署數小時以上（舊版本的請求都已結束），而且窗口 1 已完成 | — | 延後窗口 2 |

## 窗口 2：資料庫切到 CRM（平日 22:00，約 30 分鐘；AI 停止自動回覆約 10 分鐘）

開始前：
- 在員工群組公告「22:00–22:30 AI 客服暫停，請人工回覆；轉真人暫停／恢復請等 22:30 後再操作」。
- 確認 LINE 重送仍是**關閉**的（LINE console → Messaging API → Webhook redelivery）。

| # | 分鐘 | 誰做 | 在哪裡 | 動作 | 驗證與預期 | 失敗時 |
|---|---|---|---|---|---|---|
| W2-1 | 2 | 使用者（核准後寫入 CRM） | CRM SQL | 開閘道開關：`update feature_flags set enabled = true where flag_key = 'line_bot_data';`（封口後晚到的寫入要靠它寫進 CRM） | `gw pause.get '{"p_user_id":"Utest"}'` 回 `{"data":null} 200` | 設回 `false` |
| W2-2 | 2 | 使用者 | Cloudflare 後台 | Worker Secret `BOT_CUTOVER_FREEZE` = `on` | 員工帳號傳一句話：**沒有** AI 回覆，Logs 有 `database cutover freeze`；`/api/bot-pause` 用正確 token 呼叫回 `503` | 刪除這個 secret |
| W2-3 | 1 | 使用者（核准後寫入 quote） | quote-drone168 SQL | **封口**（見下方「SQL：封口」）。建立 trigger 時會等進行中的寫入結束 | `insert into chat_history (user_id, role, content) values ('Useal', 'user', 'x');` 失敗，錯誤碼 `LB423` | 封口沒建成就照「窗口 2 回退」的「W2-3 之前」；已經建成就照「W2-3 之後、W2-6 之前」 |
| W2-4 | 5 | 使用者（核准後寫入 CRM） | 終端機 psql | 再跑一次「SQL：複製 chat_history」（差額） | `missing` = 0，而且 `loaded` 等於 quote 端 `select count(*) from public.chat_history`。quote 已經封口，所以兩個數字都不會再變 | 重跑；不行就走「窗口 2 回退」的「W2-3 之後、W2-6 之前」 |
| W2-5 | 3 | 使用者（核准後寫入 CRM） | 終端機 psql | 「SQL：bot_pause 整批替換」（單一交易：刪除快照沒有的列，再新增／更新） | `loaded` 與最後的 `count` 都等於 quote 端 `select count(*) from bot_pause where paused_until > now()` | 交易失敗會自動 rollback，重跑；不行就走「W2-3 之後、W2-6 之前」的回退 |
| W2-6 | 2 | 使用者 | Cloudflare 後台 | Worker Secret `BOT_DB` = `crm` | pm 唯讀：Logs 沒有 `BOT_DB=crm needs`；閘道請求開始出現 | 見下方「窗口 2 回退」 |
| W2-7 | 1 | 使用者 | Cloudflare 後台 | 刪除 `BOT_CUTOVER_FREEZE`（或設成 `off`） | 員工帳號傳一句話，AI 有回覆 | 設回 `on`，再看 Logs |
| W2-8 | 10 | 使用者＋pm 唯讀 | 員工手機、CRM SQL、Logs | 驗收：<br>① 傳一句話 → `select role, left(content, 20) from line_bot.chat_history where user_id = '<員工 user id>' order by created_at desc limit 4` 有新的 user 和 assistant 兩列<br>② 再傳一句，AI 記得前一輪<br>③ 問一個服務問題，知識庫有答案<br>④ `/api/bot-pause` 暫停員工帳號 → 傳話沒有回覆 → 恢復 → 又有回覆，`line_bot.bot_pause` 跟著變<br>⑤ Logs 裡 `primary sealed, writing to fallback` 的筆數，對得上封口後晚到的寫入 | 全部符合 | 窗口 2 回退 |
| W2-9 | 2 | 使用者 | 員工群組 | 公告 AI 客服恢復 | — | — |

封口時正在處理的暫停或轉真人、封口後晚到的寫入、重送不重複，這些交錯情況已由 bot #4 的自動測試涵蓋（`tests/bot-db-cutover.test.ts`），正式環境不另外重現。

**窗口 2 回退**：分界是「**quote 有沒有封口過**」。封口之後，凍結前已受理的請求可能已經把晚到的對話成功寫進 CRM，回退時要把這些列補回 quote。

- **W2-3 之前**（還沒封口，bot 只寫過 quote）：
  1. 刪除 `BOT_CUTOVER_FREEZE`。
  2. 把閘道開關設回 `false`。
- **W2-3 之後、W2-6 之前**（`BOT_DB` 仍是 quote，但 CRM 可能已經收到改寫的列）：
  1. `BOT_CUTOVER_FREEZE` 維持 `on`，閘道開關維持開啟。
  2. 封口 CRM：把「SQL：封口」的表名換成 `line_bot.chat_history`、`line_bot.bot_pause`，在 CRM 執行，作為 CRM 端的寫入截止點。
  3. 在 quote 執行「SQL：解除封口」。
  4. 「SQL：複製 chat_history」反向執行（來源與目的對調、表名對調）：`missing` = 0。
  5. `bot_pause` 不需要處理：封口後兩邊都沒有暫停或恢復的寫入（凍結中一律拒絕），quote 仍是封口當下的狀態。
  6. 刪除 `BOT_CUTOVER_FREEZE`，閘道開關設回 `false`。
  7. **CRM 的封口先保留**。凍結前已受理的請求可能還在等 quote 的回應，稍後才嘗試寫 CRM。封口留著，這些晚到的寫入會失敗（該列遺失，屬已接受的情況），不會在補回快照之後才寫進 CRM。`BOT_DB=quote` 時 bot 只在 quote 被封口時才寫 CRM，所以保留 CRM 封口不影響日常運作。
  8. 下次重新排窗口 2 時，數小時以上、確認舊請求都已結束後，才在 CRM 解除封口（「SQL：解除封口」換成 `line_bot.*` 的表名）。這一步要在重跑前置 B 的 B5 **之前**做，因為 B5 要寫入 CRM，封口還在的話會被 `LB423` 擋下。
- **W2-6 之後**（設計 §4.4，反向走同一套程序；每一步寫入都要核准）：
  1. `BOT_CUTOVER_FREEZE` = `on`。
  2. 封口 CRM（同上）。之後 bot 寫 CRM 會收到 `LB423`，`chat_history` 會改寫回 quote。
  3. 在 quote 執行「SQL：解除封口」。
  4. 「複製 chat_history」反向執行：`missing` = 0。
  5. 「bot_pause 整批替換」反向執行（在 quote 的單一交易裡）。
  6. `BOT_DB` = `quote`。
  7. 刪除 `BOT_CUTOVER_FREEZE`。
  8. 驗收同 W2-8，只是查的是 quote 端。
- 回退窗口（1 週）內**不要開追蹤**：追蹤只存在 CRM，切回 quote 時追蹤狀態不會跟著回去。

### SQL：封口（quote-drone168；回退時把表名換成 CRM 的 `line_bot.*`）

```sql
create or replace function public.line_bot_cutover_seal() returns trigger language plpgsql as $$
begin
  raise exception 'line bot table % is sealed for the CRM cutover', tg_table_name using errcode = 'LB423';
end $$;
create trigger line_bot_cutover_seal before insert or update or delete or truncate on public.chat_history
  for each statement execute function public.line_bot_cutover_seal();
create trigger line_bot_cutover_seal before insert or update or delete or truncate on public.bot_pause
  for each statement execute function public.line_bot_cutover_seal();
```

`LB423` 是 bot 認得的封口錯誤碼（`src/lib/botdb/index.ts` 的 `SEALED_CODE`）。CRM 端用同一個碼，be-crm 已在 CRM #1207 的 G7b 測試鎖住。

### SQL：解除封口

```sql
drop trigger if exists line_bot_cutover_seal on public.chat_history;
drop trigger if exists line_bot_cutover_seal on public.bot_pause;
drop function if exists public.line_bot_cutover_seal();
```

### SQL：複製 chat_history（以 id 冪等，可重跑）

```bash
psql "$QUOTE_DB_URL" -c "select count(*) as source_rows from public.chat_history"
F=$(export_csv "$QUOTE_DB_URL" "select id, user_id, role, content, created_at from public.chat_history") &&
psql "$CRM_DB_URL" -v ON_ERROR_STOP=1 <<SQL
create temp table s (id uuid, user_id text, role text, content text, created_at timestamptz);
\copy s from '$F' csv
select count(*) as loaded from s;
insert into line_bot.chat_history (id, user_id, role, content, created_at)
  select id, user_id, role, content, coalesce(created_at, now()) from s on conflict (id) do nothing;
select count(*) as missing from s where not exists (select 1 from line_bot.chat_history c where c.id = s.id);
SQL
```

`loaded` 必須等於 `source_rows`。封口後（W2-4）兩者都不會再變；預搬（B5）時來源還在寫入，`loaded` 可以略大於 `source_rows`。反向執行時把兩個連線與表名對調（`line_bot.chat_history` ↔ `public.chat_history`）。

### SQL：bot_pause 整批替換（CRM，單一交易）

```bash
psql "$QUOTE_DB_URL" -c "select count(*) as source_rows from public.bot_pause where paused_until > now()"
F=$(export_csv "$QUOTE_DB_URL" "select user_id, paused_until from public.bot_pause where paused_until > now()") &&
psql "$CRM_DB_URL" -v ON_ERROR_STOP=1 <<SQL
begin;
create temp table s (user_id text, paused_until timestamptz) on commit drop;
\copy s from '$F' csv
select count(*) as loaded from s;
delete from line_bot.bot_pause b where not exists (select 1 from s where s.user_id = b.user_id);
insert into line_bot.bot_pause (user_id, paused_until) select user_id, paused_until from s
  on conflict (user_id) do update set paused_until = excluded.paused_until;
commit;
select count(*) from line_bot.bot_pause;
SQL
```

不能只做 upsert。快照裡「沒有這一列」本身就代表「已恢復」，這個狀態也要同步過去。

## 回退窗口結束後（窗口 2 之後 1 週）

| # | 誰做 | 在哪裡 | 動作 |
|---|---|---|---|
| C1 | 使用者 | Cloudflare 後台 | 刪除 Worker Secret `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（或 `QUOTE_SUPABASE_*`）、`BOT_CUTOVER_FREEZE`；`BOT_DB=crm` 保留到 C2 合併為止 |
| C2 | agent（使用者下令） | GitHub | 小 PR：<br>• 移除 quote 端的 `supabaseBotDb`、`BOT_DB` 開關、封口改寫與 `BOT_CUTOVER_FREEZE`<br>• 移除 Vercel cron（`vercel.json`、`src/app/api/cron/crm-outbox/route.ts`、`tests/cron-route.test.ts`）<br>• 是否刪除已被 CRM 取代的 `supabase/migrations/003_line_tracking.sql` 與 `tests/db`，由使用者決定 |
| C3 | 使用者 | Vercel | 停用 Git 自動部署，或刪除專案 `line-bot-external` |

## 追蹤開啟（回退窗口結束後，平日 22:00）

依序做，每一步穩定後才做下一步。

開關的定位：
- `LINE_TRACKING_ENABLED` 是**全域**開關。關掉就回到不記錄、**不去重**的 P0 行為。
- 開啟後，每個 webhook 事件都要先寫進 CRM，閘道出問題時事件會回 500、也不會回覆客戶。所以開啟的當下要有人盯著。

**緊急關閉（T4 開了重送之後一律照這個順序）**：
1. LINE console 先**關閉 Webhook redelivery**。不先關的話，追蹤一關就沒有去重，重送會再次觸發 AI 回覆與轉真人通知。
2. 刪除 Worker Secret `CRM_PUSH_ENABLED`，未送出的列留在 pending。
3. 停用廣告來源：`update line_bot.tracking_sources set enabled = false where enabled;`
4. 刪除 Worker Secret `LINE_TRACKING_ENABLED`。
5. 驗證：`curl -s -o /dev/null -w '%{http_code}' -X POST $PROD/api/line/touch -H 'content-type: application/json' -d '{"source":"test_e2e","idempotencyKey":"00000000-0000-4000-8000-000000000000"}'` 回 `503`；員工帳號傳話有回覆。

T4 之前（重送還沒開），只刪除 `LINE_TRACKING_ENABLED` 就可以。

| # | 誰做 | 在哪裡 | 動作 | 驗證與預期 | 失敗時 |
|---|---|---|---|---|---|
| T0 | 使用者（核准後寫入 CRM） | CRM SQL、Cloudflare 後台 | 準備：<br>• 新增測試來源 `insert into line_bot.tracking_sources (source_key, crm_source_code, entry_type, label, enabled, is_test) values ('test_e2e', '<CRM 來源代碼>', 'form_to_line', '端到端測試', true, true);`（`crm_source_code` 向 be-crm 確認）<br>• Worker Secret `LINE_TRACKING_TOKEN_SECRET`（`openssl rand -hex 32`）<br>• Worker Secret `LINE_TEST_USER_IDS`（員工測試帳號的 LINE user ID，逗號分隔） | `select source_key, enabled, is_test from line_bot.tracking_sources` 只有 `test_e2e` 是 enabled | 刪除該列 |
| T1 | 使用者 | Cloudflare 後台 | Worker Secret `LINE_TRACKING_ENABLED` = `true` | 員工帳號傳一句話仍有回覆；Logs 沒有 `failed to record events` | 刪除這個 secret（重送還沒開，可以直接回到 P0 行為） |
| T2 | 使用者＋pm 唯讀 | 員工手機、CRM SQL | 測試帳號端到端：手機開 `$PROD/line/start?source=test_e2e` → 按按鈕 → 送出預填訊息（內含〔來源：L-…〕） | `select tracking_status, reply_status, is_test from line_bot.tracking_events order by received_at desc limit 1`：預期 `matched`、`sent`（非上班時間；上班時間是 `skipped`）、`true`。bot 的回覆不包含 token 字樣 | T1 的回退 |
| T3 | 使用者（終端機） | `$WORKER` | 去重驗證：同一個簽章 body 送兩次（`cloudflare-cutover.md` §2 第 4 項的合成事件，假 user 已在 `LINE_TEST_USER_IDS` 裡） | 兩次都回 `200`；Logs 只有一次 reply 嘗試；`tracking_events` 同一個 `webhook_event_id` 只有一列 | 先不開重送，回報 |
| T4 | 使用者 | LINE console | 打開 Webhook redelivery | 去重的證據以 T3 的受控測試為準：首投成功後再送同一事件，沒有第二次 reply／push。bot 目前不記錄成功的 reply／push，所以開啟後沒有逐事件核對的資料。日常只觀察兩件事：員工或客戶沒有回報收到重複回覆；`select reply_status, reply_attempts from line_bot.tracking_events where reply_attempts > 1` 的列在首次遇到 5xx 或網路錯誤後再試，屬允許的重試。不要用 `is_redelivery = true` 判斷，因為首投已記錄的事件，重送時不會被改寫 | 照「緊急關閉」第 1 步關閉重送 |
| T5 | 使用者 | CRM SQL、Cloudflare 後台 | 推送：<br>• 確認 CRM `feature_flags.line_inquiry_ingest` 已開（關閉時 CRM 回 503，bot 會保留 pending 等之後再送）<br>• Worker Secret `CRM_INGEST_URL`、`LINE_INQUIRY_INGEST_SECRET`（與 CRM 同一把）<br>• 最後才設 `CRM_PUSH_ENABLED` = `true`<br>Vercel 那邊**不要**設這些 | 5 分鐘內 Logs 的 scheduled 事件沒有錯誤；T2 那筆在 CRM 收件匣出現且標示為測試；`crm_sync_status` 變成 `sent` | 刪除 `CRM_PUSH_ENABLED`，未送出的列會留在 pending；全部停用照「緊急關閉」 |
| T6 | 使用者（核准後寫入 CRM） | CRM SQL、廣告後台 | 第一支廣告來源：<br>• `insert into line_bot.tracking_sources (source_key, crm_source_code, entry_type, label, enabled) values ('<key>', '<CRM 來源代碼>', 'line_ad', '<名稱>', true);`<br>• 廣告連結設成 `$PROD/line/start?source=<key>` | 第一位真實客戶進來後，CRM 收件匣有該來源的詢問 | `update line_bot.tracking_sources set enabled = false where source_key = '<key>';`。新點擊會回到一般加好友連結，已發出的 token 照常可用 |

## quote-drone168 待辦

| # | 何時 | 誰做 | 內容 |
|---|---|---|---|
| Q1 | 窗口 2 的 W2-3 | 使用者（核准後寫入） | 封口 trigger（見上方「SQL：封口」）；回退時用「SQL：解除封口」 |
| Q2 | 窗口 2 後 **30 天** | 使用者（核准後刪除） | 刪除 bot 的舊表與函式：`drop table public.chat_history, public.bot_pause, public.knowledge_chunks;` 加上 `drop function public.match_knowledge(...)` 和封口函式。<br>刪除前：<br>• 確認回退窗口早已結束<br>• 再查一次 quote-page 與 drone168-workplan 都不碰這三張表（設計文件 §B.A 已確認過一次）<br>• 先另外匯出一份備份 |
| Q3 | 隨時（越早越好，與搬遷無關） | 使用者核准後由 agent 依指令執行 | 6 張表沒有 RLS，而且 anon／authenticated 有完整 CRUD 加 TRUNCATE：`chat_history`、`quotes`、`quote_drafts`、`bot_pause`、`pricing_params`、`knowledge_chunks`。<br>• 做法：每張表 `alter table … enable row level security;` 加上 `revoke all on … from anon, authenticated;`<br>• 已確認 quote-page、line-bot、drone168-workplan 都只在 server 端用 service role（service role 會繞過 RLS）<br>• 執行後用 quote-page 的報價流程走一次驗證<br>• 另外：storage bucket `quote-pdfs`、`cleaning-photos` 目前是公開的，要不要改成私有由使用者決定 |
