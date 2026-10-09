import type { Metadata } from "next"

import { PartsInventory } from "@/components/erp/back-office"

export const metadata: Metadata = {
  title: "Parts",
}

export default function Page() {
  return <PartsInventory />
}
