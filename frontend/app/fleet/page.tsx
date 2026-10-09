import type { Metadata } from "next"

import { FleetWorkspace } from "@/components/fleet-workspace"

export const metadata: Metadata = {
  title: "Hub Gate",
}

export default function FleetPage() {
  return <FleetWorkspace />
}
