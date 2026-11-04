# LINE bot M1 P0 v1 跨 repo 契約（S0 候選）

狀態：Teddy #1167 核准 S0→S1 合成開發；#1168 訊息保存一年。此文件沒有授權 merge、migration apply、prod 寫入、部署或開 flag。兩 repo owner 均 be-crm-2；manager 協調正式設定。CRM 與 line-bot-external 保存相同 bytes。

## 1. 邊界與唯一資料源

CRM 新私有 `line_bot.inbox_events` 是新版事件唯一原文來源；`inbox_deliveries` 是送達憑證，`inbox_jobs` 是 CRM 處理工作，`inbox_replay_receipts` 是人工重試稽核。舊 tracking_events 繼續供既有路徑使用，標示 metadata-only，不能聲稱可完整 replay 原文。

S1 不改 LINE 自動回覆保證、不建名單／商機、不自動計資格，不改薪資／金額／權限角色。replay 只重試 CRM 工作，沒有 LINE reply 或 push 能力。S2 才整合既有 line_inquiry_ingest/action；S3 才提供持久人工接手；S4 才提供外部客戶 LIFF。不得給 external service-role key。

## 2. 授權 namespace 與驗簽

External route 由部署配置選 Messaging channel secret 及非秘密 `LINE_P0_ACCOUNT_ID`（預期 destination）。必須先驗 LINE 原 body bytes 的 x-line-signature，再 parse JSON，並比較 destination 與配置；body destination 不能自行選 channel／secret。新入口缺配置 fail closed，不 fallback 授權到另一個 account。

CRM gateway 仍驗既有 X-Drone168-Timestamp / X-Drone168-Signature（timestamp.raw-body HMAC，300 秒偏差），先驗原 bytes 再 parse。這是 external→CRM 的可信服務證明，不冒稱 CRM 重新驗過 LINE 原始簽章。CRM 配置允許 account 清單；單帳號初版只有一個 `LINE_P0_ACCOUNT_ID`，須與 external 一致。未知 account 403，不觸碰 DB。不得由 caller 帶任意 RPC 名。

事件鍵 `(account_id, webhook_event_id)`；account 是已核 Messaging destination namespace，provider/Login 不明不影響 S1 收件，但會擋 S4 正式跨 channel 身分映射。event ID、account 長度 1..255，禁止空值；request_id UUIDv4，獨立於 LINE event ID。所有 ID 均不寫應用 log。

## 3. flags（全部新增，預設 false）

| 所在 | 名稱 | false 的行為 |
|---|---|---|
| CRM feature_flags | line_p0_inbox_v1 | 新 inbox actions 503 disabled，不寫入、不 ACK 持久化 |
| external env | LINE_P0_INBOX_ENABLED | 不使用新版 adapter，保留既有路徑 |
| external env | LINE_P0_WORKER_ENABLED | 新版 worker 不 claim／送出 |
| CRM feature_flags | line_p0_identity_v1 | S4 不可用；S1 不新增啟用 |
| CRM feature_flags | line_p0_handoff_v1 | S3 不可用；S1 不新增啟用 |
| CRM feature_flags | line_p0_retention_v1 | 清除作業另片；S1 不新增排程／啟用 |

初始只 seed S1 實際使用的 inbox flag，ON CONFLICT DO NOTHING，不覆寫任何既有值；其餘在所屬片才 seed false。既有 line_bot_data / line_inquiry_ingest / LINE_TRACKING_ENABLED / CRM_PUSH_ENABLED 不被改值。新版 inbox 依賴既有 gateway flag；啟用前需 manager 核對兩個值。切回舊路徑不是已 ACK 工作的安全回退；必須保留新 worker 可接續的 inbox，禁止把全部新資料倒給不去重的舊入口。

## 4. 兩個 hash domain 與 JSON 正規化

`delivery_raw_digest`：LINE 驗簽成功的原 body UTF-8 bytes SHA-256，小寫 hex64；同一送達各 events 共用。只保存 digest、首次 CRM 接收時間、request_id 及 event 關聯，不存完整 raw body／簽章／replyToken。CRM 信任 HMAC caller 的這個聲明，不能用它作事件業務衝突比較。

`canonical_event_hash_v1`：對單一事件移除**僅頂層** replyToken 與 deliveryContext 後，以固定 JSON serializer 序列化，再 SHA-256。頂層 webhookEventId 包含在投影；batch、request_id、destination 不在事件 hash（account 另為唯一鍵）。物件 keys 依 JS UTF-16 code unit 順序排序（Array.sort），陣列保留順序，字串用 JSON.stringify，不作 Unicode 正規化，有限數字用 JSON.stringify，null/boolean 按 JSON。只接受 JSON 值，拒絕 NaN/Infinity/undefined/BigInt 及 unsafe integer（避免不同 runtime 精度差）。CRM 與 external 合成 fixtures 必須逐 byte 相同。

除上述兩個頂層 delivery-only 欄位，不刪任何其他業務欄位，包括未知欄位。同 event key 同 hash 回同 event receipt；異 hash 409 event_conflict，整批回滾且不覆寫原事件。由 CRM 計算並驗證 caller 提供的 canonical hash；不只信 caller hash。request_id 相同但 digest／events 不同回 409 request_conflict；首次提交與重試結果不明仍可安全再取原 receipt。

## 5. v1 收件 wire

沿既有 line-bot-data envelope `{action,args}`，新增且只新增以下白名單；既有 action 相容不改。成功仍 `{data: ...}`；錯誤仍 `{error: {code,message}}`（新 action 用固定 code/message，不含原文）。

`action: "inbox.record.v1"`；args **恰為** p_account_id / p_request_id / p_delivery_raw_digest / p_events。

p_events 最多 100 筆、整個 gateway body 最多 256 KiB UTF-8；空 batch 合法（LINE verify 不創 job）。每筆恰為 `{event,canonical_event_hash_v1}`。event 必須是移除頂層 replyToken / deliveryContext 的 JSON object，至少 webhookEventId string、timestamp 非負安全整數 Unix ms、type 非空 string、source object（若 LINE 事件定義無 source 則允許缺省），不得包含已移除兩欄。message 事件必須有 message object / type；text 必須有 text string 與 id string；unsend 必須有 unsend.messageId string。所有其餘欄位原樣保留。支援自動處理清單僅 text message（一對一 source.type=user）及 unsend；v1 已知 top-level keys 為 webhookEventId/type/timestamp/mode/source/message/unsend，source keys 為 type/userId/groupId/roomId，text message keys 為 id/type/text/quoteToken/markAsReadToken/quotedMessageId/emojis/mention，unsend keys 為 messageId。支援類型的結構或欄位超出此白名單即隔離；mode 僅 active/standby，source.type 僅 user/group/room，非 user text 隔離；其餘或未知業務欄位先持久化隔離 `quarantined_schema`，不自動進詢問處理，ACK 不代表已完成業務處理。

text 的 quoteToken、markAsReadToken、quotedMessageId 若有必須為非空 string；emojis 為 array，每項恰為 index/length（非負安全整數，length>0）與 productId/emojiId（string）；mention 恰有 mentionees array（1..20），各項 index/length 同上、type user/all，可有 userId string／isSelf boolean（僅 user）。引用、emoji、mention 不做語義解析或自動操作，但合法標準結構可正常 validate；未知額外欄位仍保留於 hash 並隔離。

**token 最小保存**：quoteToken／markAsReadToken 與其他已知 metadata 都納入原事件 canonical hash（不丟掉來規避衝突）；CRM edge 從送入 event 重算並驗證 hash 後，才移除 message.quoteToken／message.markAsReadToken 形成 persisted payload。這兩種 token 不進 SQL、receipt、log 或 replay，S1 不提供引用回覆／標記已讀能力；保留不可逆 hash 只供同事件比較，不宣稱可從 persisted payload 重算含 token 的原 hash。replyToken/deliveryContext 仍依 §4 排除於 canonical domain。claim 傳的是最小 persisted event，不包含兩個 token。未知 schema 僅隔離，不借 replay 還原已排除的 token。

單一交易：驗證整批→鎖 request receipt→以排序 event key 鎖定／插入→比 hash→保存 delivery/event 關聯→各新 event 一個 job→保存 request receipt。重複 event key 在同批須相同 hash；回傳事件依第一次出現順序去重。任何一筆 conflict/invalid 都整批回滾。DB exception 500、關 flag 503、超限413，均不得回持久化成功。LINE adapter 僅在 CRM 收件成功後 ACK 200；短時回覆仍沿既有獨立 receipt，不在 replay 範圍。

record data 恰為 `{schema_version:1,request_id,events:[{event_receipt_id,webhook_event_id,status,version}]}`。event_receipt_id 是 CRM UUID，不用客戶 LINE ID；version 初始1，狀態為 pending／quarantined_schema／withdrawn／expired／done／dead_letter／processing／retry。record 回傳當前狀態，event_receipt_id 不因 redelivery／replay 改變。request receipt 重送返回相同接受事件集合，狀態可隨 job 更新；它不是可重新讀取原文的 API。

## 6. jobs、租約與期限

S1 worker 僅作 inbox schema／撤回／期限分類，寫持久處理結果與 receipt，**不重送現有 inquiry、不發 LINE**。S2 加入 inquiry job processor 前需另版契約與測試；不得把 S1 done 宣稱已入詢問漏斗。kind=`validate_v1`，processing outcome=`validated`／`quarantined`／`withdrawn`／`expired`。

- `inbox.claim.v1` args 恰為 p_account_id / p_limit / p_lease_seconds。limit1..20、lease30..300秒；DB `FOR UPDATE SKIP LOCKED`，pending/retry 到期才可 claim，過期租約可接手；每次成功 claim attempts+1、version+1，發不可猜 lease_token。
- claim data `{schema_version:1,jobs:[{event_receipt_id,job_id,version,lease_token,lease_expires_at,event,expires_at}]}`。只傳必要受保護 event，不傳 replyToken；worker 不 log body。已撤回、已到期 event 不得帶原文出 DB。
- `inbox.finish.v1` args 恰為 p_account_id / p_job_id / p_lease_token / p_expected_version / p_outcome / p_error_code。outcome validated／quarantined／retry／failed；error_code 固定枚舉 schema_unknown／temporary_unavailable／attempts_exhausted／null，沒有自由 error text。lease token/version/期限皆須匹配，舊 worker 409 stale_lease，不可覆寫新 owner。
- finish data `{schema_version:1,job_id,status,version}`。相同 completion 指紋重送回原 receipt，即使 lease 已被清除；異指紋／舊 lease 409。交易中再次檢查撤回／到期，優先阻止 validated／payload 復活。
- attempt 上限10（包含 lease 到期接手）；重試等待 min(30*2^(attempt-1),3600)秒。第10次失敗或第10次租約過期進 dead_letter，不無限 claim。claim 不延長資料保存期限；worker deadline 短於 lease，未知遠端結果查 receipt或帶同參數重試。

## 7. 撤回與 replay

unsend tombstone 鍵 `(account_id,message_id)`，和訊息收件同交易；先撤回後訊息仍不產可處理原文；先訊息後撤回立即清空 payload 並阻止後續 claim/finish/replay。hash 留作最小去重證據；hash 不是匿名保證，後續保存片需評估可連結性。同批先後順序不改結果。撤回不自動撤銷已被人工採用的 CRM 業務紀錄，另由人工處理，不能默默刪商機。

人工 replay 不開放於 bot HMAC gateway。CRM 受限操作 RPC 僅既有授權管理員，沿 repo 身分授權 helpers，不新增角色；external CLI 只能用操作者既有登入 token 呼叫受限操作，不能用 bot key 假造人。候選操作 request_id／expected version／原因／明確 event_receipt_ids（最多20）／dry_run，預設 dry_run=true。只允許 retry/dead_letter，不能重置 done／withdrawn／expired，不能復原 payload；全批驗證後單交易。預覽只回計數/狀態與opaque receipt；確認執行是另一請求，帶預覽版本，版本變動409。相同 request_id／指紋回同 receipt，異指紋409。審核者與原因不信 caller 任意 user_id，由 auth.uid 決定。CLI 是 S1 新交付，不聲稱現有已有命令。

## 8. 一年保存與清除（Teddy #1168）

event 首次 CRM transaction_timestamp UTC 為 received_at；expires_at 為 UTC 年曆加一年，2/29 在非閏年落2/28相同時刻；不採固定365天。delivery/receipt 含原文或可還原副本不得超過此期限；batch receipt 到期由關聯事件各自判斷，不延長較早事件。replay、redelivery、request重送不得刷新 received_at/expires_at。LINE事件 timestamp 不當保存起點（可延遲或不可信）。合成邊界：2028-02-29T12:00:00Z→2029-02-28T12:00:00Z，到期相等即不可讀原文或 replay。

S1 所有 claim／處理／replay 在 expires_at <= now 時拒絕原文，不代表磁碟副本已清除。**清除/去識別化 worker 另片，預設關**：bounded dry-run、固定批次、可重試、競爭鎖定、清除後不可重建。移到另一表／只隱藏 UI 不算清除。避免原文進 log/error/receipt，event 以外的副本納入清單；附件內容不抓取、不長存，replyToken不存。

到期清除後保留的最小去重鍵／hash／收據是否仍可連結、保留多久，及備份/平台log淘汰延遲列正式 release gate 由 owner 核；不得把「hash」等同「匿名」。S1 不實作正式刪除、不開排程；上線前須有一年期限執行 owner、就緒狀態與備份限制，不能以目前沒有到期事件作永久豁免。

## 9. HTTP 與故障處理

| HTTP | code | caller 行為 |
|---|---|---|
| 200 | receipt | 只表示該 action 已持久完成，非所有業務成功 |
| 400/422 | invalid_request / invalid_event | 不原樣重試，保留本地可觀測失敗，不 ACK 假成功 |
| 401/403 | invalid_signature / account_forbidden | 停該配置、告警，不印簽章／payload |
| 409 | event_conflict / request_conflict / stale_lease / version_conflict | 人工處理或重新讀取受限 receipt，不盲目覆蓋 |
| 413 | payload_too_large | 不拆成改內容事件；告警並保留可觀測失敗 |
| 503 | disabled / unavailable | 可退避重試，不當成功、不丟資料 |
| 500 | internal | 可退避重試；ACK 前失敗不能回200 |

HTTP caller 超時後重試同 request_id，所有寫入有交易冪等。logs 只 action／固定code／計數，不含 event id、LINE id、原文、tokens、request body。監控 pending age、retry/dead_letter、lease expiry、conflict、worker heartbeat；正式容忍量須 fresh baseline 後核定。

## 10. 合成契約矩陣與 release gates

S1 開工前以相同 JSON fixtures 鎖定：object key重排同hash、batch拆批重排不改eventhash、isRedelivery false→true與replyToken排除、業務文字/未知欄位變動異hash、Unicode組合形式不可誤合、nested replyToken仍納入hash、raw篡改先401、destination錯403、非法json無DB、整批回滾／重複event／結果不明、lease接手舊finish409、attempt10、unsend先後/同批、到期邊界、replay越權/版本/limit/冪等、不發LINE。

S0兩 repo 同 bytes 文件與 fixtures；S1 native SQL整段起測收、Deno frozen、external Node直接測試、型別/build均 heavy-run。每片 rev-crm，兩 repo 分別 draft PR／精確 SHA 核 push。正式需兩側備齊、schema版本與flags核對、fresh基線、備份/回退、Teddy核精確 SHA；未核不得 apply／開 flag。

## 11. 設定核對（repo-only，不是 prod 證明）

截至 S0 CRM base15cdb6d3 / external base9df4fdca：
- Messaging/Login 同 provider：未知；外部 LIFF 配置與用途：未知。repo 沒有足以核對的非秘密設定，不能猜同一。
- manager 於 2026-11-04 16:5x（Asia/Taipei）以 Supabase MCP SELECT 唯讀查證：CRM line_bot_data=false（更新 2026-10-16 13:51Z）、line_inquiry_ingest=false（更新 2026-10-16 09:35Z）；CRM 無其他 line/inquiry/bot flags。此為 manager 提供的最小布林結論，本 agent 未直查 prod、未改設定。
- LINE_TRACKING runtime：未知；CRM_PUSH runtime：未知；BOT_DB runtime CRM primary：未知。Messaging/Login 同 provider、外部 LIFF 用途同為未知，**啟用前須 owner 確認**。程式碼僅證明前兩者未設時 false、BOT_DB 未設時 quote；未知只擋正式開啟，不擋 S0 契約或 S1 合成開發。
- wrangler.jsonc 有每5分鐘 cron 與 observability enabled；不證明正式已部署該版本或 heartbeat 正常。
- 需 owner 只回以上布林／用途分類，不回任何 secret 或客人資料。未讀 .env*、未送真 LINE、未改正式設定。
- 人工接手入口／是否直到明確恢復由 manager 另問 Teddy；不阻擋 S0 文件與 S1 合成開發，會擋 S3 正式啟用。

技術依據沿已核父計畫的 LINE 官方 webhook 驗簽／redelivery、LIFF server token 驗證文件；本文件的限額、狀態與一年年曆邊界是本系統契約，不冒稱 LINE 平台原生保證。

S0 I1 修訂依據：[LINE 官方 text webhook schema](https://developers.line.biz/en/reference/messaging-api/nojs/#wh-text)，2026-11-04 查讀。新增含 quoteToken／markAsReadToken 的全合成正向向量，不使用真 token；既有 unknown-business／nested-replyToken 負向向量仍保留。
