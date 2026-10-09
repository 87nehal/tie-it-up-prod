"use client"

import { Suspense } from "react"

import { SearchScreen } from "@/components/mobile/vehicle-screen"
import { Loading } from "@/components/mobile/shared"

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <SearchScreen />
    </Suspense>
  )
}
