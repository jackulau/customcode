import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { LocalPTY } from "@/context/terminal"

type PersistTerminalFn = typeof import("./terminal").persistTerminal

let persistTerminal: PersistTerminalFn

beforeAll(async () => {
  // Mock heavy dependencies that terminal.tsx imports at the top level.
  // persistTerminal itself doesn't use these — it's a pure function that
  // operates on the objects passed to it.
  mock.module("@opencode-ai/ui/theme", () => ({
    resolveThemeVariant: () => ({}),
    useTheme: () => ({}),
    withAlpha: (hex: string) => hex,
  }))
  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: () => undefined,
  }))
  mock.module("@/context/command", () => ({
    matchKeybind: () => false,
    parseKeybind: () => [],
  }))
  mock.module("@/context/language", () => ({
    useLanguage: () => ({ t: (k: string) => k }),
  }))
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ openLink: () => undefined }),
  }))
  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({ current: () => [], set: () => undefined, cursor: () => 0 }),
  }))
  mock.module("@/context/sdk", () => ({
    useSDK: () => ({ client: { pty: { update: () => Promise.resolve() } }, url: "", directory: "" }),
  }))
  mock.module("@/context/server", () => ({
    useServer: () => ({ current: null }),
  }))
  mock.module("@/context/settings", () => ({
    monoFontFamily: () => "monospace",
    useSettings: () => ({
      appearance: { font: () => "monospace" },
      terminal: {
        fontSize: () => 14,
        cursorStyle: () => "block",
        cursorBlink: () => true,
        scrollback: () => 1000,
        startupCommand: () => "",
      },
      keybinds: { get: () => undefined },
    }),
  }))
  mock.module("@/utils/runtime-adapters", () => ({
    disposeIfDisposable: () => undefined,
    getHoveredLinkText: () => null,
    setOptionIfSupported: () => undefined,
  }))
  mock.module("@/utils/uuid", () => ({
    uuid: () => "mock-uuid",
  }))

  const mod = await import("./terminal")
  persistTerminal = mod.persistTerminal
})

/**
 * Create a minimal mock Term object with the fields persistTerminal reads.
 */
function mockTerm(overrides?: { rows?: number; cols?: number; viewportY?: number }) {
  return {
    rows: overrides?.rows ?? 24,
    cols: overrides?.cols ?? 80,
    getViewportY: () => overrides?.viewportY ?? 0,
  } as unknown as import("ghostty-web").Terminal
}

/**
 * Create a minimal mock SerializeAddon that returns a given buffer string.
 */
function mockAddon(buffer: string) {
  return {
    serialize: () => buffer,
  } as unknown as import("@/addons/serialize").SerializeAddon
}

/**
 * Create a minimal mock SerializeAddon that throws on serialize().
 */
function mockAddonThatThrows() {
  return {
    serialize: () => {
      throw new Error("serialize failed")
    },
  } as unknown as import("@/addons/serialize").SerializeAddon
}

describe("persistTerminal", () => {
  test("calls onCleanup with serialized buffer data", () => {
    const pty: LocalPTY = { id: "pty-1", title: "Terminal 1", titleNumber: 1 }
    let persisted: LocalPTY | undefined

    persistTerminal({
      term: mockTerm({ rows: 30, cols: 100, viewportY: 5 }),
      addon: mockAddon("hello world"),
      cursor: 42,
      pty,
      claudeSessionId: "session-abc",
      onCleanup: (p) => {
        persisted = p
      },
      allPtys: [pty],
    })

    expect(persisted).toBeDefined()
    expect(persisted!.id).toBe("pty-1")
    expect(persisted!.buffer).toBe("hello world")
    expect(persisted!.cursor).toBe(42)
    expect(persisted!.rows).toBe(30)
    expect(persisted!.cols).toBe(100)
    expect(persisted!.scrollY).toBe(5)
    expect(persisted!.claudeSessionId).toBe("session-abc")
  })

  test("skips persistence when PTY is not in allPtys", () => {
    const pty: LocalPTY = { id: "pty-removed", title: "Terminal 1", titleNumber: 1 }
    const otherPty: LocalPTY = { id: "pty-other", title: "Terminal 2", titleNumber: 2 }
    let called = false

    persistTerminal({
      term: mockTerm(),
      addon: mockAddon("should not persist"),
      cursor: 0,
      pty,
      onCleanup: () => {
        called = true
      },
      allPtys: [otherPty],
    })

    expect(called).toBe(false)
  })

  test("skips persistence when allPtys is empty", () => {
    const pty: LocalPTY = { id: "pty-1", title: "Terminal 1", titleNumber: 1 }
    let called = false

    persistTerminal({
      term: mockTerm(),
      addon: mockAddon("should not persist"),
      cursor: 0,
      pty,
      onCleanup: () => {
        called = true
      },
      allPtys: [],
    })

    expect(called).toBe(false)
  })

  test("allows persistence when allPtys is not provided (backwards compat)", () => {
    const pty: LocalPTY = { id: "pty-1", title: "Terminal 1", titleNumber: 1 }
    let called = false

    persistTerminal({
      term: mockTerm(),
      addon: mockAddon("buffer data"),
      cursor: 0,
      pty,
      onCleanup: () => {
        called = true
      },
      // allPtys intentionally omitted
    })

    expect(called).toBe(true)
  })

  test("does not call onCleanup when addon is undefined", () => {
    const pty: LocalPTY = { id: "pty-1", title: "Terminal 1", titleNumber: 1 }
    let called = false

    persistTerminal({
      term: mockTerm(),
      addon: undefined,
      cursor: 0,
      pty,
      onCleanup: () => {
        called = true
      },
      allPtys: [pty],
    })

    expect(called).toBe(false)
  })

  test("does not call onCleanup when term is undefined", () => {
    const pty: LocalPTY = { id: "pty-1", title: "Terminal 1", titleNumber: 1 }
    let called = false

    persistTerminal({
      term: undefined,
      addon: mockAddon("buffer"),
      cursor: 0,
      pty,
      onCleanup: () => {
        called = true
      },
      allPtys: [pty],
    })

    expect(called).toBe(false)
  })

  test("does not call onCleanup when onCleanup is undefined", () => {
    const pty: LocalPTY = { id: "pty-1", title: "Terminal 1", titleNumber: 1 }

    // Should not throw
    persistTerminal({
      term: mockTerm(),
      addon: mockAddon("buffer"),
      cursor: 0,
      pty,
      onCleanup: undefined,
      allPtys: [pty],
    })
  })

  test("handles serialization failure gracefully", () => {
    const pty: LocalPTY = { id: "pty-1", title: "Terminal 1", titleNumber: 1 }
    let persisted: LocalPTY | undefined

    persistTerminal({
      term: mockTerm(),
      addon: mockAddonThatThrows(),
      cursor: 10,
      pty,
      onCleanup: (p) => {
        persisted = p
      },
      allPtys: [pty],
    })

    expect(persisted).toBeDefined()
    expect(persisted!.buffer).toBe("")
  })

  test("persists correct PTY when multiple PTYs exist", () => {
    const pty1: LocalPTY = { id: "pty-1", title: "Terminal 1", titleNumber: 1 }
    const pty2: LocalPTY = { id: "pty-2", title: "Terminal 2", titleNumber: 2 }
    const pty3: LocalPTY = { id: "pty-3", title: "Terminal 3", titleNumber: 3 }
    let persisted: LocalPTY | undefined

    persistTerminal({
      term: mockTerm(),
      addon: mockAddon("buffer for pty-2"),
      cursor: 5,
      pty: pty2,
      onCleanup: (p) => {
        persisted = p
      },
      allPtys: [pty1, pty2, pty3],
    })

    expect(persisted).toBeDefined()
    expect(persisted!.id).toBe("pty-2")
    expect(persisted!.buffer).toBe("buffer for pty-2")
  })

  test("preserves pty identity fields in persisted output", () => {
    const pty: LocalPTY = {
      id: "pty-x",
      title: "My Terminal",
      titleNumber: 7,
      claudeSessionId: "old-session",
    }
    let persisted: LocalPTY | undefined

    persistTerminal({
      term: mockTerm({ rows: 40, cols: 120 }),
      addon: mockAddon("content"),
      cursor: 99,
      pty,
      claudeSessionId: "new-session",
      onCleanup: (p) => {
        persisted = p
      },
      allPtys: [pty],
    })

    expect(persisted).toBeDefined()
    expect(persisted!.id).toBe("pty-x")
    expect(persisted!.title).toBe("My Terminal")
    expect(persisted!.titleNumber).toBe(7)
    // claudeSessionId from the input param overrides the one in pty
    expect(persisted!.claudeSessionId).toBe("new-session")
  })

  test("does not write buffer to wrong PTY after close/reorder", () => {
    // Simulate the scenario where terminal A was at index 0, was closed,
    // and terminal B slid into index 0. The cleanup for A fires after B
    // is already in position. The allPtys guard should prevent A's buffer
    // from being written because A's ID is no longer in the store.
    const ptyA: LocalPTY = { id: "pty-a", title: "Terminal A", titleNumber: 1 }
    const ptyB: LocalPTY = { id: "pty-b", title: "Terminal B", titleNumber: 2 }
    let persisted: LocalPTY | undefined

    // ptyA is the PTY that was mounted (ptyAtMount), but the store now only has ptyB
    persistTerminal({
      term: mockTerm(),
      addon: mockAddon("A's buffer content"),
      cursor: 100,
      pty: ptyA,
      onCleanup: (p) => {
        persisted = p
      },
      allPtys: [ptyB], // ptyA was removed, only ptyB remains
    })

    // Should NOT have persisted — ptyA is not in the store
    expect(persisted).toBeUndefined()
  })
})
