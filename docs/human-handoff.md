# 轉真人流程

## 背景

客服 bot 以前從來沒有真的轉接過：通知管道一直沒有設定。業務都是自己看 LINE 官方帳號 @058xfgns 的訊息來接手。這一點不變：**官方帳號的每則訊息，業務都看得到**。轉接通知只是讓負責同仁更早知道。

## 流程

1. 客戶要求找真人，或 AI 判斷需要人工處理時，AI 會呼叫 `request_human` 工具。
2. bot 先暫停對這位客戶自動回覆，時數由 `BOT_PAUSE_HOURS` 決定，預設 2 小時。暫停期間不再呼叫 AI，同一位客戶也不會重複觸發通知。
3. bot 把轉接請求送到 manager-line 的 `/alert`，由 manager-line 用 LINE 推給 Teddy（manager），再由 manager 轉給負責的業務。
   - 送出的內容：客戶 LINE userId、AI 寫的原因、最近 4 則對話。
   - 不帶 `dedupe_key`，manager-line 不會留存全文。
4. 業務在 LINE 官方帳號上直接回覆客戶。需要提早恢復 AI 時，呼叫 `/api/bot-pause` 的 `resume`。

## 客戶會看到什麼

不論通知有沒有送出，客戶都會被告知**會由專人回覆**，不會出現「轉接失敗」這類讓客戶以為沒人處理的說法。

| 情況 | 告訴客戶 |
|---|---|
| 通知已送出 | 已將您的需求轉給負責同仁，會由專人回覆您。 |
| 通知沒送出（manager-line 拒絕、逾時、沒設定），或暫停失敗 | 已記錄您的需求，會由專人回覆您；如需電話聯繫，可撥打 02-7733-7678。 |

這兩句是給 AI 的指示，AI 會用自己的話轉述。實際文字在 `src/lib/ai/tools.ts`。

通知沒送出時暫停照樣保留：如果撤銷暫停，可能會清掉另一個同時發生、而且已經送達的轉接。

## 設定（Worker Secret）

| 名稱 | 說明 |
|---|---|
| `MANAGER_LINE_ALERT_URL` | manager-line `/alert` 的完整網址 |
| `MANAGER_LINE_ALERT_TOKEN` | 值和 manager-line 的 `SUPPORT_ALERT_BEARER` 相同，客服 bot 專用 |
| `BOT_PAUSE_HOURS` | 選用。請不要設成低於 0.5：manager-line 建議同一位客戶 30 分鐘內只通知一次 |

客服 bot 有自己的 `/alert` 額度，每小時 20 則，不和 CRM 告警共用。`source` 是 `line-bot-handoff`。

## 健康檢查

```
curl -s -X POST -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $BOT_PAUSE_API_TOKEN" $WORKER/api/health/handoff
```

這個端點用固定的假資料送一次轉接通知：userId `TEST-e2e`，原因「端到端測試，請忽略」。它不碰資料庫、客戶，也不呼叫 Anthropic。

- 回 `{"delivered":true}`（HTTP 200）：**至少有一個**通知管道受理。目前只設了 manager-line，所以這代表 manager-line 已受理。如果之後另外設了 Email（`SENDGRID_API_KEY`），單靠這個結果就分不出是哪一條通的，要以 Teddy 實際在 LINE 收到「真人接手：端到端測試，請忽略」為準。
- 回 `{"delivered":false}`（HTTP 502）：所有已設定的管道都沒有受理，或一個都沒設定。管道有回應時，Worker Logs 會記 `manager-line alert failed: <狀態碼>`；逾時或連線錯誤記的是錯誤名稱；沒有設定時記的是 `no notification channel configured`。

**manager-line 有設定時，每呼叫一次就會推一則 LINE 給 Teddy，也會用掉一則額度**，所以只在驗收或排查時使用。
