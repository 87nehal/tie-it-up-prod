import type { Metadata, Viewport } from "next"

import { MobileShell } from "@/components/mobile/mobile-shell"

export const metadata: Metadata = {
  title: "Sharma Motors Staff",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "SM Staff", statusBarStyle: "default" },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f7f8fa",
}

export default function MobileLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <MobileShell>{children}</MobileShell>
}
