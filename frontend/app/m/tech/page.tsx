"use client"

import { Suspense } from "react"

import { TechScreen } from "@/components/mobile/tech-screen"
import { Loading } from "@/components/mobile/shared"

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <TechScreen />
    </Suspense>
  )
}
