import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { AppShell } from "@/components/app-shell"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { DemoTour } from "@/components/demo-tour"

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" })
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" })

export const metadata: Metadata = {
  title: {
    default: "Maruti Suzuki Service | Dealer workspace",
    template: "%s | Maruti Suzuki Service",
  },
  description:
    "Dealer service workspace from customer follow-up through delivery.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geist.variable} ${geistMono.variable} font-sans antialiased`}
    >
      <body>
        <ThemeProvider>
          <AppShell>{children}</AppShell>
          <Toaster />
          <DemoTour />
        </ThemeProvider>
      </body>
    </html>
  )
}
