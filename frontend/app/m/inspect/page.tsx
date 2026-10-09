"use client"

import { Suspense } from "react"

import { InspectScreen } from "@/components/mobile/inspect-screen"
import { Loading } from "@/components/mobile/shared"

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <InspectScreen />
    </Suspense>
  )
}
