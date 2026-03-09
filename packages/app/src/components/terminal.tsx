import { type HexColor, resolveThemeVariant, useTheme, withAlpha } from "@opencode-ai/ui/theme"
import { showToast } from "@opencode-ai/ui/toast"
import type { FitAddon, Ghostty, Terminal as Term } from "ghostty-web"
import { type ComponentProps, createEffect, createMemo, onCleanup, onMount, splitProps } from "solid-js"
import { SerializeAddon } from "@/addons/serialize"
import { matchKeybind, parseKeybind } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { usePrompt, type ImageAttachmentPart } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { monoFontFamily, useSettings } from "@/context/settings"
import type { LocalPTY } from "@/context/terminal"
import { disposeIfDisposable, getHoveredLinkText, setOptionIfSupported } from "@/utils/runtime-adapters"
import { terminalWriter } from "@/utils/terminal-writer"
import { uuid } from "@/utils/uuid"

const TOGGLE_TERMINAL_ID = "terminal.toggle"
const DEFAULT_TOGGLE_TERMINAL_KEYBIND = "ctrl+`"
export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  onSubmit?: () => void
  onCleanup?: (pty: LocalPTY) => void
  onConnect?: () => void
  onConnectError?: (error: unknown) => void
}

let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined

const loadGhostty = () => {
  if (shared) return shared
  shared = import("ghostty-web")
    .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
    .catch((err) => {
      shared = undefined
      throw err
    })
  return shared
}

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
  },
}

const debugTerminal = (...values: unknown[]) => {
  if (!import.meta.env.DEV) return
  console.debug("[terminal]", ...values)
}

const useTerminalUiBindings = (input: {
  container: HTMLDivElement
  term: Term
  cleanups: VoidFunction[]
  handlePointerDown: () => void
  handleLinkClick: (event: MouseEvent) => void
  onImagePaste?: (file: File) => void
  readClipboardImage?: () => Promise<File | null>
  readClipboardText?: () => Promise<string>
}) => {
  const handleCopy = (event: ClipboardEvent) => {
    const selection = input.term.getSelection()
    if (!selection) return

    const clipboard = event.clipboardData
    if (!clipboard) return

    event.preventDefault()
    clipboard.setData("text/plain", selection)
  }

  // Desktop: intercept paste on keydown instead of relying on the paste event.
  // On macOS WKWebView, the paste event may not fire when the clipboard contains
  // only an image and the focused element is a textarea. By handling Cmd/Ctrl+V
  // on keydown, we can proactively check the native clipboard for images.
  const handleDesktopPasteKeydown = async (event: KeyboardEvent) => {
    const isPaste = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v"
    if (!isPaste) return

    // Block the default paste — we handle both image and text via native APIs
    event.preventDefault()
    event.stopPropagation()

    // Try image first
    if (input.readClipboardImage && input.onImagePaste) {
      const file = await input.readClipboardImage()
      if (file) {
        input.onImagePaste(file)
        return
      }
    }

    // No image — paste text via native clipboard API
    if (input.readClipboardText) {
      const text = await input.readClipboardText()
      if (text) {
        input.term.paste(text)
      }
    }
  }

  // Web fallback: use the browser paste event (works when native APIs aren't available)
  const handlePaste = async (event: ClipboardEvent) => {
    const clipboard = event.clipboardData
    if (!clipboard) return

    // Check for image files in browser clipboard
    const items = Array.from(clipboard.items)
    const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"))

    // Capture text synchronously before clipboard data is cleared
    const text = clipboard.getData("text/plain") ?? clipboard.getData("text") ?? ""

    // Browser clipboard has an image — forward to prompt as attachment
    if (imageItem && input.onImagePaste) {
      const file = imageItem.getAsFile()
      if (file) {
        event.preventDefault()
        event.stopPropagation()
        input.onImagePaste(file)
        return
      }
    }

    if (!text) return
    event.preventDefault()
    event.stopPropagation()
    input.term.paste(text)
  }

  const handleTextareaFocus = () => {
    input.term.options.cursorBlink = true
  }
  const handleTextareaBlur = () => {
    input.term.options.cursorBlink = false
  }

  input.container.addEventListener("copy", handleCopy, true)
  input.cleanups.push(() => input.container.removeEventListener("copy", handleCopy, true))

  if (input.readClipboardImage || input.readClipboardText) {
    // Desktop: use keydown-based paste for reliable image support
    input.container.addEventListener("keydown", handleDesktopPasteKeydown, true)
    input.cleanups.push(() => input.container.removeEventListener("keydown", handleDesktopPasteKeydown, true))
  }

  // Always register paste handler as fallback (for right-click paste, non-keyboard paste, web)
  input.container.addEventListener("paste", handlePaste, true)
  input.cleanups.push(() => input.container.removeEventListener("paste", handlePaste, true))

  input.container.addEventListener("pointerdown", input.handlePointerDown)
  input.cleanups.push(() => input.container.removeEventListener("pointerdown", input.handlePointerDown))

  input.container.addEventListener("click", input.handleLinkClick, {
    capture: true,
  })
  input.cleanups.push(() =>
    input.container.removeEventListener("click", input.handleLinkClick, {
      capture: true,
    }),
  )

  input.term.textarea?.addEventListener("focus", handleTextareaFocus)
  input.term.textarea?.addEventListener("blur", handleTextareaBlur)
  input.cleanups.push(() => input.term.textarea?.removeEventListener("focus", handleTextareaFocus))
  input.cleanups.push(() => input.term.textarea?.removeEventListener("blur", handleTextareaBlur))
}

/**
 * Detect whether a startup command invokes the Claude CLI.
 * Matches `claude` as a standalone command word (not `claude-something`).
 */
const isClaudeCommand = (cmd: string): boolean => /^claude(\s|$)/.test(cmd.trim())

/** Returns true if the command already includes session/resume flags we should not override. */
const hasClaudeSessionFlags = (cmd: string): boolean =>
  /--(?:session-id|resume|continue)\b/.test(cmd) || /\s-[cr]\b/.test(cmd)

/**
 * Strip any existing --session-id or --resume flags from a Claude command
 * so we can inject our own without duplicating them.
 */
const stripClaudeSessionFlags = (cmd: string): string =>
  cmd.replace(/\s+--(?:session-id|resume)\s+\S+/g, "").trim()

const persistTerminal = (input: {
  term: Term | undefined
  addon: SerializeAddon | undefined
  cursor: number
  pty: LocalPTY
  claudeSessionId?: string
  onCleanup?: (pty: LocalPTY) => void
}) => {
  if (!input.addon || !input.onCleanup || !input.term) return
  const buffer = (() => {
    try {
      return input.addon.serialize()
    } catch {
      debugTerminal("failed to serialize terminal buffer")
      return ""
    }
  })()

  input.onCleanup({
    ...input.pty,
    buffer,
    cursor: input.cursor,
    rows: input.term.rows,
    cols: input.term.cols,
    scrollY: input.term.getViewportY(),
    claudeSessionId: input.claudeSessionId,
  })
}

export const Terminal = (props: TerminalProps) => {
  const platform = usePlatform()
  const prompt = usePrompt()
  const sdk = useSDK()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  const server = useServer()
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, ["pty", "class", "classList", "onConnect", "onConnectError"])

  // Snapshot PTY identity at mount time. When <For> reuses a slot after a
  // close/reorder, the reactive `local.pty` already reflects the replacement
  // item by the time our cleanup runs — saving our buffer to the wrong entry.
  const ptyAtMount: LocalPTY = {
    id: local.pty.id,
    title: local.pty.title,
    titleNumber: local.pty.titleNumber,
  }

  let ws: WebSocket | undefined
  let term: Term | undefined
  let ghostty: Ghostty
  let serializeAddon: SerializeAddon
  let fitAddon: FitAddon
  let handleResize: () => void
  let fitFrame: number | undefined
  let sizeTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSize: { cols: number; rows: number } | undefined
  let claudeSessionId: string | undefined = local.pty.claudeSessionId
  let lastSize: { cols: number; rows: number } | undefined
  let disposed = false
  const cleanups: VoidFunction[] = []
  const start =
    typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor) ? local.pty.cursor : undefined
  let cursor = start ?? 0
  let output: ReturnType<typeof terminalWriter> | undefined

  const cleanup = () => {
    if (!cleanups.length) return
    const fns = cleanups.splice(0).reverse()
    for (const fn of fns) {
      try {
        fn()
      } catch (err) {
        debugTerminal("cleanup failed", err)
      }
    }
  }

  const pushSize = (cols: number, rows: number) => {
    return sdk.client.pty
      .update({
        ptyID: local.pty.id,
        size: { cols, rows },
      })
      .catch((err) => {
        debugTerminal("failed to sync terminal size", err)
      })
  }

  const getTerminalColors = (): TerminalColors => {
    const mode = theme.mode() === "dark" ? "dark" : "light"
    const fallback = DEFAULT_TERMINAL_COLORS[mode]
    const currentTheme = theme.themes()[theme.themeId()]
    if (!currentTheme) return fallback
    const variant = mode === "dark" ? currentTheme.dark : currentTheme.light
    if (!variant?.seeds) return fallback
    const resolved = resolveThemeVariant(variant, mode === "dark")
    const text = resolved["text-stronger"] ?? fallback.foreground
    const background = resolved["background-stronger"] ?? fallback.background
    const alpha = mode === "dark" ? 0.25 : 0.2
    const base = text.startsWith("#") ? (text as HexColor) : (fallback.foreground as HexColor)
    const selectionBackground = withAlpha(base, alpha)
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
    }
  }

  const terminalColors = createMemo(getTerminalColors)

  const scheduleFit = () => {
    if (disposed) return
    if (!fitAddon) return
    if (fitFrame !== undefined) return

    fitFrame = requestAnimationFrame(() => {
      fitFrame = undefined
      if (disposed) return
      fitAddon.fit()
    })
  }

  const scheduleSize = (cols: number, rows: number) => {
    if (disposed) return
    if (lastSize?.cols === cols && lastSize?.rows === rows) return

    pendingSize = { cols, rows }

    if (!lastSize) {
      lastSize = pendingSize
      void pushSize(cols, rows)
      return
    }

    if (sizeTimer !== undefined) return
    sizeTimer = setTimeout(() => {
      sizeTimer = undefined
      const next = pendingSize
      if (!next) return
      pendingSize = undefined
      if (disposed) return
      if (lastSize?.cols === next.cols && lastSize?.rows === next.rows) return
      lastSize = next
      void pushSize(next.cols, next.rows)
    }, 100)
  }

  createEffect(() => {
    const colors = terminalColors()
    if (!term) return
    setOptionIfSupported(term, "theme", colors)
  })

  createEffect(() => {
    const font = monoFontFamily(settings.appearance.font())
    if (!term) return
    setOptionIfSupported(term, "fontFamily", font)
    scheduleFit()
  })

  createEffect(() => {
    const size = settings.terminal.fontSize()
    if (!term) return
    setOptionIfSupported(term, "fontSize", size)
    scheduleFit()
  })

  createEffect(() => {
    const style = settings.terminal.cursorStyle()
    if (!term) return
    setOptionIfSupported(term, "cursorStyle", style)
  })

  createEffect(() => {
    const blink = settings.terminal.cursorBlink()
    if (!term) return
    setOptionIfSupported(term, "cursorBlink", blink)
  })

  createEffect(() => {
    const lines = settings.terminal.scrollback()
    if (!term) return
    setOptionIfSupported(term, "scrollback", lines)
  })

  let zoom = platform.webviewZoom?.()
  createEffect(() => {
    const next = platform.webviewZoom?.()
    if (next === undefined) return
    if (next === zoom) return
    zoom = next
    scheduleFit()
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    t.focus()
    t.textarea?.focus()
    setTimeout(() => t.textarea?.focus(), 0)
  }
  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container && !container.contains(activeElement)) {
      activeElement.blur()
    }
    focusTerminal()
  }

  const handleLinkClick = (event: MouseEvent) => {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
    if (event.altKey) return
    if (event.button !== 0) return

    const t = term
    if (!t) return

    const text = getHoveredLinkText(t)
    if (!text) return

    event.preventDefault()
    event.stopImmediatePropagation()
    platform.openLink(text)
  }

  onMount(() => {
    const run = async () => {
      const loaded = await loadGhostty()
      if (disposed) return

      const mod = loaded.mod
      const g = loaded.ghostty

      // Validate buffer belongs to this PTY: only restore if we have a matching
      // cursor (indicates the buffer was saved from this PTY's session). A buffer
      // without a valid cursor may have been misassigned from another terminal.
      const hasValidCursor = typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor)
      const restore = typeof local.pty.buffer === "string" && (hasValidCursor || !local.pty.cursor) ? local.pty.buffer : ""
      if (typeof local.pty.buffer === "string" && !restore) {
        debugTerminal("discarded buffer for PTY", local.pty.id, "— cursor validation failed")
      }
      const restoreSize =
        restore &&
        typeof local.pty.cols === "number" &&
        Number.isSafeInteger(local.pty.cols) &&
        local.pty.cols > 0 &&
        typeof local.pty.rows === "number" &&
        Number.isSafeInteger(local.pty.rows) &&
        local.pty.rows > 0
          ? { cols: local.pty.cols, rows: local.pty.rows }
          : undefined

      const t = new mod.Terminal({
        cursorBlink: settings.terminal.cursorBlink(),
        cursorStyle: settings.terminal.cursorStyle(),
        cols: restoreSize?.cols,
        rows: restoreSize?.rows,
        fontSize: settings.terminal.fontSize(),
        fontFamily: monoFontFamily(settings.appearance.font()),
        allowTransparency: false,
        convertEol: false,
        theme: terminalColors(),
        scrollback: settings.terminal.scrollback(),
        ghostty: g,
      })
      cleanups.push(() => t.dispose())
      if (disposed) {
        cleanup()
        return
      }
      ghostty = g
      term = t
      output = terminalWriter((data, done) => t.write(data, done))

      t.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase()

        if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "c") {
          document.execCommand("copy")
          return true
        }

        // allow for toggle terminal keybinds in parent
        const config = settings.keybinds.get(TOGGLE_TERMINAL_ID) ?? DEFAULT_TOGGLE_TERMINAL_KEYBIND
        const keybinds = parseKeybind(config)

        return matchKeybind(keybinds, event)
      })

      const fit = new mod.FitAddon()
      const serializer = new SerializeAddon()
      cleanups.push(() => disposeIfDisposable(fit))
      t.loadAddon(serializer)
      t.loadAddon(fit)
      fitAddon = fit
      serializeAddon = serializer

      t.open(container)
      const onImagePaste = (file: File) => {
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          const attachment: ImageAttachmentPart = {
            type: "image",
            id: uuid(),
            filename: file.name,
            mime: file.type,
            dataUrl,
          }
          prompt.set([...prompt.current(), attachment], prompt.cursor())
        }
        reader.readAsDataURL(file)
      }

      useTerminalUiBindings({
        container,
        term: t,
        cleanups,
        handlePointerDown,
        handleLinkClick,
        onImagePaste,
        readClipboardImage: platform.readClipboardImage,
        readClipboardText: platform.readClipboardText,
      })

      focusTerminal()

      if (typeof document !== "undefined" && document.fonts) {
        document.fonts.ready.then(scheduleFit)
      }

      const onResize = t.onResize((size) => {
        scheduleSize(size.cols, size.rows)
      })
      cleanups.push(() => disposeIfDisposable(onResize))
      const onData = t.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      })
      cleanups.push(() => disposeIfDisposable(onData))
      const onKey = t.onKey((key) => {
        if (key.key == "Enter") {
          props.onSubmit?.()
        }
      })
      cleanups.push(() => disposeIfDisposable(onKey))

      const startResize = () => {
        fit.observeResize()
        handleResize = scheduleFit
        window.addEventListener("resize", handleResize)
        cleanups.push(() => window.removeEventListener("resize", handleResize))
      }

      const write = (data: string) =>
        new Promise<void>((resolve) => {
          if (!output) {
            resolve()
            return
          }
          output.push(data)
          output.flush(resolve)
        })

      // When restoring a buffer, keep the container hidden until the WebSocket
      // connection succeeds. This prevents a brief flash of stale content if the
      // PTY is dead and the buffer gets cleared before clone.
      let revealPending = false
      const revealTerminal = () => {
        if (!revealPending) return
        revealPending = false
        requestAnimationFrame(() => {
          if (!disposed) container.style.visibility = ""
        })
      }

      if (restore && restoreSize) {
        container.style.visibility = "hidden"
        revealPending = true
        try {
          await write(restore)
        } catch (err) {
          debugTerminal("failed to restore terminal buffer", err)
          t.clear()
        }
        fit.fit()
        scheduleSize(t.cols, t.rows)
        if (typeof local.pty.scrollY === "number") t.scrollToLine(local.pty.scrollY)
        startResize()
      } else if (restore) {
        container.style.visibility = "hidden"
        revealPending = true
        fit.fit()
        scheduleSize(t.cols, t.rows)
        try {
          await write(restore)
        } catch (err) {
          debugTerminal("failed to restore terminal buffer", err)
          t.clear()
        }
        if (typeof local.pty.scrollY === "number") t.scrollToLine(local.pty.scrollY)
        startResize()
      } else {
        fit.fit()
        scheduleSize(t.cols, t.rows)
        startResize()
      }

      // t.onScroll((ydisp) => {
      // console.log("Scroll position:", ydisp)
      // })

      let startupSent = false
      let reconnectDelay = 1000
      let reconnectAttempts = 0
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined
      let currentSocketCleanup: VoidFunction | undefined
      let isFirstConnect = true
      let hasEverConnected = false
      const decoder = new TextDecoder()
      const initialCursor = start !== undefined ? start : local.pty.buffer ? -1 : 0
      const MAX_RECONNECT_ATTEMPTS = 5

      const connectSocket = () => {
        if (disposed) return

        currentSocketCleanup?.()

        const url = new URL(sdk.url + `/pty/${local.pty.id}/connect`)
        url.searchParams.set("directory", sdk.directory)
        // First connection uses saved/initial cursor; reconnections use tracked position
        const serverCursor = isFirstConnect ? initialCursor : cursor
        isFirstConnect = false
        url.searchParams.set("cursor", String(serverCursor))
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        url.username = server.current?.http.username ?? ""
        url.password = server.current?.http.password ?? ""

        const socket = new WebSocket(url)
        socket.binaryType = "arraybuffer"
        ws = socket
        let closing = false
        let lastMessageAt = Date.now()

        // Detect stale connections: server sends heartbeat every 30s,
        // so no messages for 45s means the connection is dead.
        const staleCheck = setInterval(() => {
          if (disposed || closing) {
            clearInterval(staleCheck)
            return
          }
          if (socket.readyState !== WebSocket.OPEN) return
          if (Date.now() - lastMessageAt > 45_000) {
            debugTerminal("connection stale, forcing reconnect")
            clearInterval(staleCheck)
            socket.close(4000, "stale")
          }
        }, 15_000)

        const handleOpen = () => {
          hasEverConnected = true
          reconnectDelay = 1000
          // Connection succeeded — safe to show the restored buffer
          revealTerminal()
          local.onConnect?.()
          scheduleSize(t.cols, t.rows)

          if (!startupSent) {
            const cmd = settings.terminal.startupCommand()
            const isClaude = cmd ? isClaudeCommand(cmd) : false
            // Don't inject session flags if user already manages their own
            const userManaged = isClaude && hasClaudeSessionFlags(cmd!)

            if (!restore) {
              // Normal first launch — send startup command
              startupSent = true
              if (cmd) {
                let finalCmd = cmd
                // If startup command is Claude CLI, inject --session-id for session tracking
                if (isClaude && !userManaged && !claudeSessionId) {
                  claudeSessionId = uuid()
                  finalCmd = `${stripClaudeSessionFlags(cmd)} --session-id ${claudeSessionId}`
                }
                setTimeout(() => {
                  if (disposed) return
                  if (socket.readyState === WebSocket.OPEN) {
                    socket.send(finalCmd + "\n")
                  }
                }, 50)
              }
            } else if (claudeSessionId && isClaude && !userManaged) {
              // Restart with restored buffer — resume the Claude session
              // Preserve original flags (e.g. --model, --permission-mode) from startup command
              startupSent = true
              const resumeCmd = `${stripClaudeSessionFlags(cmd!)} --resume ${claudeSessionId}`
              setTimeout(() => {
                if (disposed) return
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(resumeCmd + "\n")
                }
              }, 50)
            } else if (claudeSessionId && !isClaude) {
              // Startup command changed away from Claude — clear stale session ID
              claudeSessionId = undefined
            }
          }
        }
        socket.addEventListener("open", handleOpen)
        if (socket.readyState === WebSocket.OPEN) handleOpen()

        const handleMessage = (event: MessageEvent) => {
          if (disposed) return
          if (closing) return
          lastMessageAt = Date.now()
          reconnectAttempts = 0

          if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data)
            if (bytes[0] !== 0) return
            const json = decoder.decode(bytes.subarray(1))
            try {
              const meta = JSON.parse(json) as { cursor?: unknown }
              const next = meta?.cursor
              if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
                // Validate monotonic cursor: a backward jump indicates
                // the server buffer was reset (e.g. server restart) or
                // a session mismatch. Log for debugging but trust the server.
                if (next < cursor) {
                  debugTerminal(
                    "cursor jumped backward:",
                    cursor,
                    "->",
                    next,
                    "for PTY",
                    local.pty.id,
                  )
                }
                cursor = next
              }
            } catch (err) {
              debugTerminal("invalid websocket control frame", err)
            }
            return
          }

          const data = typeof event.data === "string" ? event.data : ""
          if (!data) return
          output?.push(data)
          cursor += data.length
        }
        socket.addEventListener("message", handleMessage)

        const handleError = (error: Event) => {
          if (disposed) return
          if (closing) return
          debugTerminal("WebSocket error:", error)
        }
        socket.addEventListener("error", handleError)

        const handleClose = (event: CloseEvent) => {
          if (disposed) return
          if (closing) return
          clearInterval(staleCheck)

          // Normal closure (code 1000) means PTY process exited
          if (event.code === 1000) return

          // Never connected (e.g. stale PTY after restart) — skip retries.
          // Clear the terminal immediately so stale buffer content is not
          // visible while the error handler (e.g. clone) processes.
          if (!hasEverConnected) {
            t.clear()
            // Reveal the (now empty) terminal — the error handler will
            // typically clone a new PTY that remounts this component.
            revealTerminal()
            local.onConnectError?.(new Error("PTY not found on server"))
            return
          }

          // Abnormal close — attempt reconnection with exponential backoff
          reconnectAttempts++
          if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            local.onConnectError?.(new Error(`Connection lost after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`))
            return
          }

          debugTerminal("connection lost (code", event.code + "), reconnecting in", reconnectDelay, "ms")
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined
            if (disposed) return
            connectSocket()
          }, reconnectDelay)
          reconnectDelay = Math.min(reconnectDelay * 2, 10_000)
        }
        socket.addEventListener("close", handleClose)

        currentSocketCleanup = () => {
          closing = true
          clearInterval(staleCheck)
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
        }
      }

      connectSocket()

      // On wake from sleep, tear down stale WebSocket and reconnect immediately.
      // The periodic stale check (15s interval) would eventually catch this, but
      // forcing it here avoids a visible delay after resuming from sleep.
      const handleWake = () => {
        if (disposed) return
        currentSocketCleanup?.()
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = undefined
        }
        reconnectAttempts = 0
        reconnectDelay = 1000
        connectSocket()
      }
      window.addEventListener("opencode:wake", handleWake)

      cleanups.push(() => {
        window.removeEventListener("opencode:wake", handleWake)
        if (reconnectTimer) clearTimeout(reconnectTimer)
        currentSocketCleanup?.()
      })
    }

    void run().catch((err) => {
      if (disposed) return
      showToast({
        variant: "error",
        title: language.t("terminal.connectionLost.title"),
        description: err instanceof Error ? err.message : language.t("terminal.connectionLost.description"),
      })
      local.onConnectError?.(err)
    })
  })

  onCleanup(() => {
    disposed = true
    container.style.visibility = "hidden"

    // Stop Ghostty's render loop immediately. The deferred disposal
    // (via output.flush) means t.dispose() runs later — Ghostty's RAF
    // loop would keep painting stale frames until then. Cancel it now.
    if (term) {
      const t = term as unknown as Record<string, unknown>
      if (typeof t.animationFrameId === "number") {
        cancelAnimationFrame(t.animationFrameId)
        t.animationFrameId = undefined
      }
      if (typeof t.scrollAnimationFrame === "number") {
        cancelAnimationFrame(t.scrollAnimationFrame)
        t.scrollAnimationFrame = undefined
      }
    }
    // Hide canvas element directly — prevents stale GPU content from compositing
    const canvas = container.querySelector("canvas")
    if (canvas) canvas.style.display = "none"

    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
    if (sizeTimer !== undefined) clearTimeout(sizeTimer)
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close(1000)

    let finalized = false
    const finalize = () => {
      if (finalized) return
      finalized = true
      persistTerminal({ term, addon: serializeAddon, cursor, pty: ptyAtMount, claudeSessionId, onCleanup: props.onCleanup })
      cleanup()
    }

    if (!output) {
      finalize()
      return
    }

    output.flush(finalize)
    setTimeout(finalize, 100)
  })

  return (
    <div
      ref={container}
      data-component="terminal"
      data-prevent-autofocus
      tabIndex={-1}
      style={{ "background-color": terminalColors().background }}
      classList={{
        ...(local.classList ?? {}),
        "select-text": true,
        "size-full px-6 py-3 font-mono relative overflow-hidden": true,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}
