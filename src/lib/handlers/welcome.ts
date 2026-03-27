import { push } from "@/lib/line"
import type { LineMessage } from "@/lib/line"

export async function handleFollow(userId: string) {
  const messages: LineMessage[] = [
    {
      type: "text",
      text:
        "歡迎加入 GDS 低空作業官方帳號！🚁\n\n" +
        "如需取得報價單，請在網站完成報價後，\n" +
        "點擊「透過 LINE 取得報價單」按鈕即可。\n\n" +
        "您也可以直接傳送報價編號（如 Q-20260323-456）查詢報價單。\n\n" +
        "其他功能：\n" +
        "・傳送「預約」安排施工時間\n" +
        "・傳送「進度」查詢任務狀態\n" +
        "・傳送「客服」聯繫真人客服",
    },
  ]
  await push(userId, messages)
}
