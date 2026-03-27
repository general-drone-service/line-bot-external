export interface LineEvent {
  type: string
  replyToken?: string
  source?: { type: string; userId?: string }
  message?: { type: string; text?: string }
}

export interface LineWebhookBody {
  events: LineEvent[]
}

export interface LineTextMessage {
  type: "text"
  text: string
}

export interface LineFlexMessage {
  type: "flex"
  altText: string
  contents: Record<string, unknown>
}

export type LineMessage = LineTextMessage | LineFlexMessage
