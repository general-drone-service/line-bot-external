import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "LINE Bot — GDS 低空作業",
  description: "LINE Official Account webhook service",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  )
}
