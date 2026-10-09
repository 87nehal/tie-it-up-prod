"use client"

import { Suspense } from "react"

import { DemoJourney } from "@/components/mobile/demo-journey"
import { Loading } from "@/components/mobile/shared"

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <DemoJourney />
    </Suspense>
  )
}
