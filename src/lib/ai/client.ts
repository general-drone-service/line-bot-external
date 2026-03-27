import Anthropic from "@anthropic-ai/sdk"

let _client: Anthropic | null = null

export function getAnthropicClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY")
    _client = new Anthropic({ apiKey })
  }
  return _client
}
