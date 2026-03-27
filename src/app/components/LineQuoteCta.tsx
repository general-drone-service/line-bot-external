"use client"

import { useState, useCallback } from "react"
import { buildLineOaMessageUrl } from "@/lib/line/constants"
import { saveQuote } from "@/lib/stores/quote-store"
import type { PricingResult, TimeResult } from "@/lib/types"
import type { QuoteFormData, AreaEstimate } from "./quote-defaults"

interface Props {
  pricing: PricingResult
  timeResult: TimeResult
  formData: QuoteFormData
  areaEstimate: AreaEstimate
  buildingName: string | null
}

export function LineQuoteCta({ pricing, timeResult, formData, areaEstimate, buildingName }: Props) {
  const [lineSending, setLineSending] = useState(false)
  const [lineSent, setLineSent] = useState(false)
  const [lineError, setLineError] = useState<string | null>(null)

  const handleGetQuoteViaLine = useCallback(async () => {
    if (!pricing || !timeResult) return
    setLineSending(true)
    setLineError(null)

    try {
      const numBuildings = formData.numBuildings ?? 1
      const totalArea = areaEstimate.project_total_m2 ?? (areaEstimate.total_area_m2 * numBuildings)

      // Save locally first
      saveQuote({
        quote_code:    pricing.quote_code,
        client_name:   formData.clientName,
        address:       formData.address,
        building_name: buildingName || undefined,
        floors:        formData.floors,
        total_area_m2: totalArea,
        total_ntd:     pricing.total,
        suggested_days: timeResult.suggested_days,
      })

      // Generate PDF & save to server
      const res = await fetch("/api/quote/generate-and-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pricing,
          timeResult,
          formData: {
            clientName: formData.clientName,
            address: formData.address,
            buildingType: formData.buildingType,
            floors: formData.floors,
            numBuildings: formData.numBuildings,
            serviceType: formData.serviceType,
            timeSlot: formData.timeSlot,
            expectedDate: formData.expectedDate,
            urgent: formData.urgent,
          },
          areaEstimate: {
            source: areaEstimate.source,
            total_area_m2: areaEstimate.total_area_m2,
            project_total_m2: areaEstimate.project_total_m2,
            num_facades: areaEstimate.num_facades,
          },
          buildingName,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "伺服器錯誤" }))
        throw new Error((err as { error?: string }).error ?? "伺服器錯誤")
      }

      const { quoteCode } = (await res.json()) as { quoteCode: string }

      // Open LINE with pre-filled message
      window.open(buildLineOaMessageUrl(`我要報價單 ${quoteCode}`), "_blank")

      setLineSent(true)
    } catch (err) {
      setLineError(err instanceof Error ? err.message : "發送失敗，請重試")
    } finally {
      setLineSending(false)
    }
  }, [pricing, timeResult, formData, areaEstimate, buildingName])

  return (
    <div className="no-print border-2 border-[#06C755] rounded-xl overflow-hidden">
      {/* First-time customer discount highlight */}
      <div className="relative bg-gradient-to-r from-amber-400 via-yellow-400 to-amber-400 px-6 py-4 text-center">
        <div className="absolute inset-0 bg-[repeating-linear-gradient(120deg,transparent,transparent_8px,rgba(255,255,255,0.1)_8px,rgba(255,255,255,0.1)_16px)]" />
        <p className="relative text-lg font-extrabold text-amber-900 tracking-wide">
          首次合作客戶最低享九折優惠！
        </p>
      </div>

      {lineSent ? (
        <div className="px-6 py-5 bg-green-50 text-center space-y-3">
          <div className="text-3xl">✅</div>
          <p className="text-sm font-semibold text-green-800">
            報價單已生成，LINE 已開啟！
          </p>
          <p className="text-xs text-green-700">
            請在 LINE 中送出訊息，即可立即收到報價單 PDF。
          </p>
          <p className="text-xs text-zinc-500 mt-2">
            報價編號：<span className="font-mono font-medium">{pricing.quote_code}</span>
          </p>
          <button
            onClick={() => setLineSent(false)}
            className="text-xs text-green-600 hover:text-green-800 underline mt-2"
          >
            重新發送
          </button>
        </div>
      ) : (
        <div className="px-6 py-6 space-y-5">
          {/* Title */}
          <div className="text-center space-y-1">
            <p className="text-base font-semibold text-zinc-900">
              透過 LINE 取得完整報價單 PDF
            </p>
            <p className="text-xs text-zinc-500">
              點擊下方按鈕，系統將自動生成報價單並透過 LINE 官方帳號發送給您
            </p>
          </div>

          {/* Main CTA button */}
          <div className="flex justify-center">
            <button
              onClick={handleGetQuoteViaLine}
              disabled={lineSending}
              className="flex items-center gap-3 px-8 py-3.5 rounded-xl font-semibold text-white text-base transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-60 disabled:cursor-wait"
              style={{ backgroundColor: "#06C755" }}
            >
              {lineSending ? (
                <>
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  生成報價單中...
                </>
              ) : (
                <>
                  {/* LINE icon */}
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314" />
                  </svg>
                  透過 LINE 取得報價單
                </>
              )}
            </button>
          </div>

          {/* Error */}
          {lineError && (
            <div className="text-center">
              <p className="text-sm text-red-600">{lineError}</p>
              <button
                onClick={handleGetQuoteViaLine}
                className="text-xs text-red-500 hover:text-red-700 underline mt-1"
              >
                重試
              </button>
            </div>
          )}

        </div>
      )}
    </div>
  )
}
