import type { Metadata } from "next"

import { PickupsWorkspace } from "@/components/service/pickups-workspace"

export const metadata: Metadata = {
  title: "Pickup & drop",
}

export default function Page() {
  return <PickupsWorkspace />
}
