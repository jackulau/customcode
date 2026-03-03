import { RGBA } from "@opentui/core"
import { existsSync, statSync, writeFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import path from "path"

const LOCK_STALE_MS = 5000
const QUERY_TIMEOUT_MS = 500

/**
 * Acquire a short-lived lock file scoped to the parent process (terminal session).
 * Returns a release function, or null if another instance already holds the lock.
 */
function acquireTerminalQueryLock(): (() => void) | null {
  // Use ppid to scope to the terminal session — instances in the same terminal
  // share the same parent shell process.
  const lockPath = path.join(tmpdir(), `opencode-terminal-query-${process.ppid}.lock`)

  try {
    if (existsSync(lockPath)) {
      const stat = statSync(lockPath)
      const age = Date.now() - stat.mtimeMs
      if (age < LOCK_STALE_MS) {
        // Another instance is currently querying — skip to avoid race
        return null
      }
      // Lock is stale, clean it up
      try {
        unlinkSync(lockPath)
      } catch {
        // Ignore — another process may have already cleaned it
      }
    }

    writeFileSync(lockPath, String(process.pid), { flag: "wx" })
  } catch {
    // Could not create lock (another instance beat us) — skip query
    return null
  }

  return () => {
    try {
      unlinkSync(lockPath)
    } catch {
      // Ignore cleanup errors
    }
  }
}

export namespace Terminal {
  export type Colors = Awaited<ReturnType<typeof colors>>
  /**
   * Query terminal colors including background, foreground, and palette (0-15).
   * Uses OSC escape sequences to retrieve actual terminal color values.
   *
   * Note: OSC 4 (palette) queries may not work through tmux as responses are filtered.
   * OSC 10/11 (foreground/background) typically work in most environments.
   *
   * Uses a PID-scoped lock file to prevent multiple OpenCode instances from
   * querying the terminal simultaneously, which can cause response cross-talk.
   *
   * Returns an object with background, foreground, and colors array.
   * Any query that fails will be null/empty.
   */
  export async function colors(): Promise<{
    background: RGBA | null
    foreground: RGBA | null
    colors: RGBA[]
  }> {
    if (!process.stdin.isTTY) return { background: null, foreground: null, colors: [] }

    const releaseLock = acquireTerminalQueryLock()
    if (!releaseLock) {
      // Another instance is querying — return defaults to avoid cross-talk
      return { background: null, foreground: null, colors: [] }
    }

    return new Promise((resolve) => {
      let background: RGBA | null = null
      let foreground: RGBA | null = null
      const paletteColors: RGBA[] = []
      let timeout: NodeJS.Timeout

      const cleanup = () => {
        process.stdin.setRawMode(false)
        process.stdin.removeListener("data", handler)
        clearTimeout(timeout)
        releaseLock()
      }

      const parseColor = (colorStr: string): RGBA | null => {
        if (colorStr.startsWith("rgb:")) {
          const parts = colorStr.substring(4).split("/")
          return RGBA.fromInts(
            parseInt(parts[0], 16) >> 8, // Convert 16-bit to 8-bit
            parseInt(parts[1], 16) >> 8,
            parseInt(parts[2], 16) >> 8,
            255,
          )
        }
        if (colorStr.startsWith("#")) {
          return RGBA.fromHex(colorStr)
        }
        if (colorStr.startsWith("rgb(")) {
          const parts = colorStr.substring(4, colorStr.length - 1).split(",")
          return RGBA.fromInts(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]), 255)
        }
        return null
      }

      const handler = (data: Buffer) => {
        const str = data.toString()

        // Match OSC 11 (background color)
        const bgMatch = str.match(/\x1b]11;([^\x07\x1b]+)/)
        if (bgMatch) {
          background = parseColor(bgMatch[1])
        }

        // Match OSC 10 (foreground color)
        const fgMatch = str.match(/\x1b]10;([^\x07\x1b]+)/)
        if (fgMatch) {
          foreground = parseColor(fgMatch[1])
        }

        // Match OSC 4 (palette colors)
        const paletteMatches = str.matchAll(/\x1b]4;(\d+);([^\x07\x1b]+)/g)
        for (const match of paletteMatches) {
          const index = parseInt(match[1])
          const color = parseColor(match[2])
          if (color) paletteColors[index] = color
        }

        // Return immediately if we have all 16 palette colors
        if (paletteColors.filter((c) => c !== undefined).length === 16) {
          cleanup()
          resolve({ background, foreground, colors: paletteColors })
        }
      }

      process.stdin.setRawMode(true)
      process.stdin.on("data", handler)

      // Query background (OSC 11)
      process.stdout.write("\x1b]11;?\x07")
      // Query foreground (OSC 10)
      process.stdout.write("\x1b]10;?\x07")
      // Query palette colors 0-15 (OSC 4)
      for (let i = 0; i < 16; i++) {
        process.stdout.write(`\x1b]4;${i};?\x07`)
      }

      timeout = setTimeout(() => {
        cleanup()
        resolve({ background, foreground, colors: paletteColors })
      }, QUERY_TIMEOUT_MS)
    })
  }

  export async function getTerminalBackgroundColor(): Promise<"dark" | "light"> {
    const result = await colors()
    if (!result.background) return "dark"

    const { r, g, b } = result.background
    // Calculate luminance using relative luminance formula
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255

    // Determine if dark or light based on luminance threshold
    return luminance > 0.5 ? "light" : "dark"
  }
}
