import type { Metadata } from "next"

import { VehicleList } from "@/components/erp/vehicles"

export const metadata: Metadata = {
  title: "Customers & vehicles",
}

export default function Page() {
  return <VehicleList />
}
