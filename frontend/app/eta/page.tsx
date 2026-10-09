import type { Metadata } from "next"

import { EtaWorkspace } from "@/components/eta-workspace"

export const metadata: Metadata = {
  title: "Ride ETA",
}

export default function EtaPage() {
  return <EtaWorkspace />
}
