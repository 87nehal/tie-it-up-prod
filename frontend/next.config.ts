import path from "node:path"
import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"

const dir = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  devIndicators: false,
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // let phones on the local Wi-Fi load the dev server (staff/customer app at /m)
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
    "*.ngrok-free.app",
    "*.ngrok-free.dev",
    "*.ngrok.app",
  ],
  turbopack: {
    root: dir,
  },
  experimental: {
    // Damage inference can run for minutes on CPU; the default 30s proxy timeout kills it.
    proxyTimeout: 10 * 60 * 1000,
  },
  async redirects() {
    return [
      ["/service/outreach", "/crm"],
      ["/service/booking", "/appointments"],
      ["/service/pickups", "/pickups"],
      ["/service/reception", "/reception"],
      ["/service/job-card", "/job-cards"],
    ].map(([source, destination]) => ({
      source,
      destination,
      permanent: false,
    }))
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_URL ?? "http://127.0.0.1:8000"}/api/:path*`,
      },
    ]
  },
}

export default nextConfig
