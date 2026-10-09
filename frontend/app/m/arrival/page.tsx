"use client"

import { Suspense } from "react"

import { ArrivalFlow } from "@/components/mobile/arrival-flow"
import { Loading } from "@/components/mobile/shared"

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <ArrivalFlow />
    </Suspense>
  )
}
