/** LINE Official Account ID */
export const LINE_OA_ID = "@058xfgns"

/** Build the LINE OA deep-link URL for sending a pre-filled message */
export function buildLineOaMessageUrl(message: string): string {
  return `https://line.me/R/oaMessage/${LINE_OA_ID}/?${encodeURIComponent(message)}`
}
