import type { Metadata } from "next"

import { Admin } from "@/components/erp/back-office"

export const metadata: Metadata = {
  title: "Masters & staff",
}

export default function Page() {
  return <Admin />
}
