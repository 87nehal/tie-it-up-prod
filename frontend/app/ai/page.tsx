import type { Metadata } from "next"
import { Suspense } from "react"

import { AiDecisions } from "@/components/erp/ai-decisions"

export const metadata: Metadata = {
  title: "AI decisions",
}

export default function Page() {
  return (
    <Suspense>
      <AiDecisions />
    </Suspense>
  )
}
