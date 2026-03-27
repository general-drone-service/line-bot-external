export interface LineEvent {
  type: string
  replyToken?: string
  source?: { type: string; userId?: string }
  message?: {
    type: string
    text?: string
    id?: string
    contentProvider?: { type: string }
  }
}

export interface LineWebhookBody {
  events: LineEvent[]
}

export interface QuickReplyItem {
  type: "action"
  action: {
    type: "message"
    label: string
    text: string
  }
}

export interface QuickReply {
  items: QuickReplyItem[]
}

export interface LineTextMessage {
  type: "text"
  text: string
  quickReply?: QuickReply
}

export interface LineFlexMessage {
  type: "flex"
  altText: string
  contents: Record<string, unknown>
  quickReply?: QuickReply
}

export type LineMessage = LineTextMessage | LineFlexMessage

export function quickReply(labels: string[]): QuickReply {
  return {
    items: labels.map((label) => ({
      type: "action" as const,
      action: {
        type: "message" as const,
        label,
        text: label,
      },
    })),
  }
}
