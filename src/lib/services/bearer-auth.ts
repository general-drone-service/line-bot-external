import crypto from "node:crypto"
import { NextResponse } from "next/server"

/** Fail-closed bearer check: 503 when the expected token is not configured, 401 when it does not match. */
export function rejectUnlessBearer(request: Request, token: string | undefined, name: string): Response | null {
  if (!token) {
    return NextResponse.json({ error: `${name} not configured` }, { status: 503 })
  }
  const given = Buffer.from(request.headers.get("authorization") ?? "")
  const expected = Buffer.from(`Bearer ${token}`)
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return null
}
