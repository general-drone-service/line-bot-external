import Anthropic from "@anthropic-ai/sdk"

/** Model used for chat and image replies; the health check probes the same one. */
export const CHAT_MODEL = "claude-haiku-4-5-20251001"

let _client: Anthropic | null = null

export function getAnthropicClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY")
    _client = new Anthropic({ apiKey })
  }
  return _client
}
