import type { Metadata } from "next"
import { Suspense } from "react"
import { JobCardWorkspace } from "@/components/service/jobcard-workspace"

export const metadata: Metadata = {
  title: "Job cards",
}

export default function Page() {
  return (
    <Suspense>
      <JobCardWorkspace />
    </Suspense>
  )
}
