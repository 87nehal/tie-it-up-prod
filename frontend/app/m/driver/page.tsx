"use client"

import { Suspense } from "react"

import { DriverScreen } from "@/components/mobile/driver-screen"
import { Loading } from "@/components/mobile/shared"

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <DriverScreen />
    </Suspense>
  )
}
