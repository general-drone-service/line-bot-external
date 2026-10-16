import { handleTouchRequest } from "@/lib/tracking/touch"

export const runtime = "nodejs"

export async function POST(request: Request) {
  return handleTouchRequest(request)
}
