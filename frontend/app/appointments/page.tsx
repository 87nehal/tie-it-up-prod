import { Suspense } from "react"
import type { Metadata } from "next"

import { AppointmentsDiary } from "@/components/erp/appointments"

export const metadata: Metadata = {
  title: "Appointments",
}

export default function Page() {
  return (
    <Suspense>
      <AppointmentsDiary />
    </Suspense>
  )
}
