import type { Metadata } from "next"

import { InspectWorkspace } from "@/components/inspect-workspace"

export const metadata: Metadata = {
  title: "Damage inspection",
}

export default function InspectionPage() {
  return <InspectWorkspace />
}
