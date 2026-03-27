export function getChannelAccessToken(): string {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN")
  return token
}

export function getChannelSecret(): string {
  const secret = process.env.LINE_CHANNEL_SECRET
  if (!secret) throw new Error("Missing LINE_CHANNEL_SECRET")
  return secret
}
