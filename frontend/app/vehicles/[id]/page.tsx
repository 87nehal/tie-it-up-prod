import type { Metadata } from "next"

import { Vehicle360View } from "@/components/erp/vehicles"

export const metadata: Metadata = {
  title: "Vehicle 360",
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <Vehicle360View id={Number(id)} />
}
