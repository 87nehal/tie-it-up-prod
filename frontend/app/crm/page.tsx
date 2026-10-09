import type { Metadata } from "next"
import { Suspense } from "react"
import { OutreachWorkspace } from "@/components/service/outreach-workspace"

export const metadata: Metadata = {
  title: "Service outreach",
}

export default function Page() {
  return (
    <Suspense>
      <OutreachWorkspace />
    </Suspense>
  )
}
