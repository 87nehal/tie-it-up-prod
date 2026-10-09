import type { Metadata } from "next"

import { WorkshopBoard } from "@/components/erp/workshop-board"

export const metadata: Metadata = {
  title: "Workshop board",
}

export default function Page() {
  return <WorkshopBoard />
}
