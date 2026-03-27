import crypto from "node:crypto"
import { getChannelSecret } from "./client"

export function verifySignature(body: string, signature: string): boolean {
  const secret = getChannelSecret()
  const hmac = crypto.createHmac("SHA256", secret)
  hmac.update(body)
  const expected = hmac.digest("base64")
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
