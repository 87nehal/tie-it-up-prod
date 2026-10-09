"use client"

import { Suspense } from "react"

import { GateScreen } from "@/components/mobile/gate-screen"
import { Loading } from "@/components/mobile/shared"

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <GateScreen />
    </Suspense>
  )
}
