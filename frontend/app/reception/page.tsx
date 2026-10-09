import type { Metadata } from "next"

import { ReceptionWorkspace } from "@/components/service/reception-workspace"

export const metadata: Metadata = {
  title: "Reception",
}

export default function Page() {
  return <ReceptionWorkspace />
}
