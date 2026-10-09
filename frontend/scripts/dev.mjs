import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(scriptsDir, "..")
const repositoryRoot = path.resolve(frontendDir, "..")
const backendDir = path.join(repositoryRoot, "backend")
const apiHealthUrl = "http://127.0.0.1:8000/api/health"
// Optional local LLM (Laya, llama.cpp) next to this repository; the platform
// falls back to rules/templates when it is absent.
const layaDir = path.resolve(repositoryRoot, "..", "laya")
const layaPort = "8100"
const layaHealthUrl = `http://127.0.0.1:${layaPort}/health`
const python = process.env.PYTHON_EXECUTABLE || "python"
const nextBin = path.join(
  frontendDir,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
)

// --prod: build once, then serve the optimised build (no per-page compile on first visit)
const prod = process.argv.includes("--prod")

let apiProcess = null
let layaProcess = null
let nextProcess = null
let stopping = false

async function apiIsReady() {
  try {
    const response = await fetch(apiHealthUrl, {
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    })
    if (!response.ok) return false
    const payload = await response.json()
    return Boolean(payload?.damage?.ok && payload?.damage?.model_loaded)
  } catch {
    return false
  }
}

async function waitForApi() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (await apiIsReady()) return
    if (apiProcess && apiProcess.exitCode !== null) {
      throw new Error(`model API exited with code ${apiProcess.exitCode}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("model API did not become ready within 90 seconds")
}

async function layaIsReady() {
  try {
    const response = await fetch(layaHealthUrl, { signal: AbortSignal.timeout(1000) })
    return response.ok
  } catch {
    return false
  }
}

async function startLaya() {
  if (process.env.LAYA_DISABLED === "1") return
  if (await layaIsReady()) {
    console.log(`[dev] Reusing local LLM on ${layaHealthUrl}`)
    return
  }
  if (!fs.existsSync(path.join(layaDir, "api", "main.py"))) {
    console.log("[dev] Local LLM (../laya) not found; using rules and templates")
    return
  }
  console.log("[dev] Starting local LLM (Laya)...")
  layaProcess = spawn(python, ["-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", layaPort], {
    cwd: layaDir,
    stdio: "inherit",
    windowsHide: true,
  })
  layaProcess.on("error", (error) => {
    console.error(`[dev] Local LLM unavailable: ${error.message}`)
    layaProcess = null
  })
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await layaIsReady()) {
      console.log("[dev] Local LLM ready (model weights load on first use)")
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  console.error("[dev] Local LLM did not come up; continuing without it")
}

function terminate(child) {
  if (child && child.exitCode === null) child.kill()
}

function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  terminate(nextProcess)
  terminate(apiProcess)
  terminate(layaProcess)
  setTimeout(() => process.exit(code), 1000).unref()
}

async function main() {
  await startLaya()
  if (await apiIsReady()) {
    console.log("[dev] Reusing backend API on http://127.0.0.1:8000")
  } else {
    console.log("[dev] Starting hash-verified backend API...")
    apiProcess = spawn(python, ["-m", "app.main"], {
      cwd: backendDir,
      env: {
        ...process.env,
        PYTHONPATH: [path.join(backendDir, "src"), process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
      stdio: "inherit",
      windowsHide: true,
    })
    apiProcess.on("error", (error) => {
      console.error(`[dev] Unable to start Python: ${error.message}`)
      shutdown(1)
    })
    await waitForApi()
    console.log("[dev] Model API ready")
  }

  if (prod) {
    console.log("[dev] Building production bundle (one-off, ~1-2 min)...")
    const code = await new Promise((resolve) => {
      const build = spawn(process.execPath, [nextBin, "build", "--webpack"], {
        cwd: frontendDir,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
      })
      build.on("exit", resolve)
      build.on("error", () => resolve(1))
    })
    if (code !== 0) {
      console.error("[dev] Build failed")
      shutdown(1)
      return
    }
  }
  const nextArgs = prod ? [nextBin, "start"] : [nextBin, "dev", "--webpack"]
  nextProcess = spawn(process.execPath, nextArgs, {
    cwd: frontendDir,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  })
  nextProcess.on("error", (error) => {
    console.error(`[dev] Unable to start Next.js: ${error.message}`)
    shutdown(1)
  })
  nextProcess.on("exit", (code) => shutdown(code ?? 0))
  apiProcess?.on("exit", (code) => {
    if (!stopping) {
      console.error(`[dev] Model API stopped unexpectedly with code ${code}`)
      shutdown(code ?? 1)
    }
  })
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

main().catch((error) => {
  console.error(
    `[dev] ${error instanceof Error ? error.message : String(error)}`
  )
  shutdown(1)
})
