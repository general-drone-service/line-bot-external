# Webhook 先回 200、再背景處理（第 100 件）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LINE 斷線之後，Worker 仍要把 AI 回覆做完。驗簽、記錄事件之後先回 200，回覆的處理交給平台的 `waitUntil`。

**Architecture:**
- `handleWebhookRequest` 多一個可選的 `defer(task)` 參數：
  - 有傳：記錄完事件就把「逐事件 track 加 reply」交給 `defer`，馬上回 `{ok:true}`。
  - 沒傳：維持現在的同步行為，既有測試不必改。
- route 傳入 Next 的 `after()`。vinext 在 Workers 上會把它接到 `ctx.waitUntil`，Vercel 上 Next 本身也支援。
- `after()` 在 request scope 外會丟錯，例如在 route 測試裡，這時退回同步處理並記一筆 warn。
- 背景處理有兩種 log：超過 25 秒還沒做完，記一筆 error（Workers 的 `waitUntil` 上限是回應後 30 秒）；失敗事件數大於 0 也記 error。

**Tech Stack:** Next 15.5 route handler、vinext 1.0.0-beta.9（`after` → `executionContext.waitUntil`，見 `node_modules/vinext/dist/shims/server.js`）、`node:test`。

**Spec:** pm 的第 100 件、`~/drone168/.harness/line-bot-sec/w1-4-wrangler.md`「擋住切換的問題」。

## Global Constraints
- 驗簽、body 驗證、`recordEvents` 失敗時，回應碼都不變：401、400、500。
- 逐事件的去重、`claimReply`、`finishReply` 語意不變，只是改在回應之後執行。
- 不加新依賴，不改 Vercel 和 Worker 的設定。
- log 不印訊息原文和 token；沿用現有的 `describeError`。

## Review Focus
1. **背景處理丟出未捕捉的錯誤**：不能變成 unhandled rejection，要記 log。→ Task 1 的測試「deferred handler throw is logged」。
2. **超過時間上限**：25 秒還沒做完要記 log，才看得出 `waitUntil` 有沒有被砍。→ Task 1 的測試「slow batch logs a warning」（用可注入的 `slowMs`）。
3. **client 斷線**：回應必須在 handler 還沒完成時就回傳。→ Task 1 的測試「responds before handler settles」。
4. **`after()` 不可用時**：要退回同步處理，不能丟掉事件。→ Task 2 的 route 測試（測試環境本來就沒有 request scope）。
5. **redelivery 語意改變**：背景失敗時，已經回了 200，LINE 不會重送。目前 redelivery 關著，沒有影響；P1 開啟 redelivery 之前要重新評估（`pending` 狀態要靠 cron 補做，或改用 Queue）。寫進 PR 說明，不在這次實作。

---

### Task 1: `handleWebhookRequest` 支援 defer

**Files:**
- Modify: `src/lib/line/webhook.ts`
- Test: `tests/webhook.test.ts`（新增一段測試）

**Interfaces:**
- Produces: `handleWebhookRequest(request, handleEvent, store?, options?: { defer?: (task: () => Promise<void>) => void | Promise<void>; slowMs?: number }): Promise<Response>`

- [ ] Step 1：寫失敗的測試（`fakeStore`、`recorder` 沿用既有的 helper）
  - `responds before handler settles`：handler 回傳一個不會自己 resolve 的 promise；`defer` 把 task 存起來。預期回應 200、`{ok:true}`，而且 `seen.length === 0`。接著執行存起來的 task、放行 handler 之後，`seen.length === 1`，store 的 reply 狀態是 `sent`。
  - `deferred handler throw is logged`：handler 丟 `new Error("boom")`。執行 task 不會 reject；`console.error` 被呼叫，訊息包含 `failed`。
  - `slow batch logs a warning`：`slowMs: 10`，handler 等 30ms。`console.error` 有一筆包含 `still running`。
  - `invalid signature is still 401 with defer`：`defer` 不會被呼叫。
- [ ] Step 2：`npm test` 確認新測試失敗。
- [ ] Step 3：實作。把現有的逐事件迴圈抽成 `processEvents(store, accountId, events, handleEvent): Promise<number>`（回傳失敗數）。
  - 有 `defer`：`await options.defer(() => runInBackground(...))`，然後回 `{ok:true}`。
  - `runInBackground` 用 `setTimeout(slowMs ?? 25_000)` 記 `LINE webhook: batch still running after Nms`；結束時 `clearTimeout`；失敗數大於 0 時記 `LINE webhook: N event(s) failed in background`；整段 try/catch 記 log，不往外丟。
  - 沒有 `defer`：原本的同步路徑和 500 行為不變。
- [ ] Step 4：`npm test` 全部通過。
- [ ] Step 5：commit。

### Task 2: route 接上 `after()`

**Files:**
- Modify: `src/app/api/webhook/route.ts`
- Test: `tests/webhook-route.test.ts`（既有的測試要全部照常通過，不改斷言）

**Interfaces:**
- Consumes: Task 1 的 `options.defer`。

- [ ] Step 1：route 加 `deferAfterResponse(task)`：`try { after(task) } catch (err) { console.warn("LINE webhook: after() unavailable, handling inline", describeError(err)); await task() }`。在 POST 裡傳入 `{ defer: deferAfterResponse }`。
- [ ] Step 2：`npm test`。route 測試沒有 request scope，會走同步退路，所以既有斷言全部通過。
- [ ] Step 3：`npm run build`（或 repo 用的 build 指令），確認 Next 和 vinext 都能編譯。
- [ ] Step 4：commit，開 PR（只開不合），送 `rev-line-bot-external` 審。

### 上線後驗證（PR 合併、Workers Builds 部署之後，Window 1 之前）
- webhook 暫時指向 workers.dev，用員工帳號傳一則文字、一張圖片：
  - `chat_history` 兩則都有 assistant 那一列。
  - devops 的 tail 顯示 POST 回 200，沒有 `canceled`，也沒有 `waitUntil() tasks did not complete`。
- 驗完把 webhook 改回 Vercel alias，等 Window 1 重排。
