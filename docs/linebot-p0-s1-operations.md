# S1 inbox 合成驗證與候選操作

狀態：新入口及 worker 預設關；未授權 prod 部署、啟用、merge 或重播。S0 wire 見 `linebot-p0-v1-contract.md`。S1 只耐久收件與 validate_v1，不建立 inquiry，不重發 LINE，不提供行銷 push。

新配置 `LINE_P0_INBOX_ENABLED` / `LINE_P0_WORKER_ENABLED` 必須恰為字串 true 才啟用；未設為 false。啟用時 `LINE_P0_ACCOUNT_ID` 必須是 owner 核定的 Messaging destination，CRM 同名設定必須一致。舊 LINE_TRACKING/CRM_PUSH/BOT_DB 配置不被新程式覆寫。owner 未核 provider/LIFF/正式flags，不得以 repo default 當正式現值。

收件先驗 LINE 原 body 簽章與 account，再送 HMAC gateway；DB receipt 成功後才 ACK。payload 的 quote/read token 參與 hash，但於 CRM edge 移除後才存 DB；replyToken 不持久化。規則 vendored 到兩 runtime，source 檔與 S0 fixtures 要保持 parity。未知 schema 隔離；結構／hash 不合法不假 ACK。

## 合成檢查

external `heavy-run npm test`、`heavy-run node node_modules/typescript/bin/tsc --noEmit`、`heavy-run npm run build`。Next build 自動調整 tsconfig 的產物不是此片產品改動，應檢視後只還原自己的產物，不改別人的 checkout。

CRM runner `heavy-run bash supabase/tests/run-line-inbox.sh` 起獨立本機 postgres:16（無 host port），跑 native transaction／ACL／lease／unsend／expiry／replay／concurrency，結束刪自己的容器。跨 repo HTTP 整合設定 `LINE_INBOX_EXTERNAL_WORKTREE` 為已授權 external S1 worktree，跑同 runner `--integration`；只綁 localhost、合成 secret／事件、假 LINE callback，沒有真 LINE／prod 呼叫。

## 候選人工 replay CLI

`node --import tsx scripts/replay-line-inbox.ts <authorized-input.json>` 預設 dry-run；另帶 `--apply` 才請求重排工作。JSON 不得自行開 apply。輸入為 accountId、requestId、events（最多20個 event_receipt_id／expected_version）、reason。禁止用姓名／訊息原文作原因；使用內部處置理由，別複製客戶資料。

操作人透過既有登入取得 `LINE_INBOX_OPERATOR_TOKEN`（authenticated JWT），另以 `LINE_INBOX_CRM_URL` 與 `LINE_INBOX_PUBLISHABLE_KEY` 配置目標；不放 `.env` 範例、不印 token。CLI 固定只接受 CRM origin，不能把憑證轉送任意網址；也不接受 service_role 或 bot HMAC 假裝操作者。CRM 自行驗證登入與既有 admin 角色，CLI 解碼只是誤用防護。

**dry-run 仍會建立操作稽核收據**，不改 event/job；正式執行任何 dry-run／apply 都是受控正式 RPC 寫入，需另取得使用者核准，agent 不可自行拿 prod 試。預覽只回計數、狀態，操作人保留輸入版本；確認用新的 requestId，expected_version 不變，競爭時409。結果不明則同 requestId／同指紋重試，不換 ID 盲送。

只有 retry/dead_letter 可重排；done/withdrawn/expired／無 payload 拒絕，不能復原撤回或過期原文。新 worker 只 validate，不會回覆 LINE 或重建 inquiry。正式資料缺少必要版本的選取 UI 不在此片，須由已授權的既有操作介面／人工核對提供精確 opaque IDs與版本，不能用 bot key 掃全庫。無此輸入來源就不做正式 replay。

## 觀測／停損

worker 每次有限 claim10、lease300秒、25秒停止啟動新工作；對未完成租約由下次收回，attempt最多10。輸出固定 heartbeat 計數，失敗不 log payload。P0 的正式監控告警設定仍是 release gate，不冒稱 repo 有 logger 就代表監控已上線。

停入口或 worker 保留所有 accepted inbox／receipt／job；不得 drop/reset 去重，也不能將已ACK事件盲目丟回無去重舊路徑。關 flag 不等於清除資料；一年清除／去識別化 worker 另片預設關，正式啟用前要列執行 owner、備份與去重鍵保留期限。此文件不授權任何 prod 命令。
