import crypto from "node:crypto"
import { getChannelSecret } from "./client"

export function verifySignature(body: string, signature: string): boolean {
  const secret = getChannelSecret()
  const hmac = crypto.createHmac("SHA256", secret)
  hmac.update(body)
  const expected = Buffer.from(hmac.digest("base64"))
  const given = Buffer.from(signature)
  // timingSafeEqual throws on length mismatch; that must be a rejection, not a skip
  if (given.length !== expected.length) return false
  return crypto.timingSafeEqual(given, expected)
}
