import type { Metadata } from "next"

import { Billing } from "@/components/erp/back-office"

export const metadata: Metadata = {
  title: "Billing",
}

export default function Page() {
  return <Billing />
}
