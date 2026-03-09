import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSignal } from "solid-js"

import type { createWorkspaceTerminalSession as CreateWorkspaceTerminalSessionFn } from "./terminal"

let getWorkspaceTerminalCacheKey: (dir: string) => string
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let createWorkspaceTerminalSession: typeof CreateWorkspaceTerminalSessionFn

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))
  mock.module("@/utils/persist", () => ({
    Persist: {
      workspace: (_dir: string, _key: string, _legacy?: string[]) => ({
        storage: "test",
        key: "test:workspace:terminal",
      }),
    },
    persisted: (_target: unknown, store: [unknown, unknown]) => {
      const [readySignal] = createSignal(true)
      return [store[0], store[1], null, readySignal]
    },
    removePersisted: () => {},
  }))
  const mod = await import("./terminal")
  getWorkspaceTerminalCacheKey = mod.getWorkspaceTerminalCacheKey
  getLegacyTerminalStorageKeys = mod.getLegacyTerminalStorageKeys
  createWorkspaceTerminalSession = mod.createWorkspaceTerminalSession
})

describe("getWorkspaceTerminalCacheKey", () => {
  test("uses workspace-only directory cache key", () => {
    expect(getWorkspaceTerminalCacheKey("/repo")).toBe("/repo:__workspace__")
  })
})

describe("getLegacyTerminalStorageKeys", () => {
  test("keeps workspace storage path when no legacy session id", () => {
    expect(getLegacyTerminalStorageKeys("/repo")).toEqual(["/repo/terminal.v1"])
  })

  test("includes legacy session path before workspace path", () => {
    expect(getLegacyTerminalStorageKeys("/repo", "session-123")).toEqual([
      "/repo/terminal/session-123.v1",
      "/repo/terminal.v1",
    ])
  })
})

// Helper to create a mock SDK for terminal session tests
function createMockSDK(options?: {
  createResponse?: (title: string) => Promise<{ data?: { id?: string; title?: string } }>
}) {
  const listeners = new Map<string, Set<(event: unknown) => void>>()

  return {
    client: {
      pty: {
        create: (args: { title: string }) => {
          if (options?.createResponse) {
            return options.createResponse(args.title)
          }
          const id = `new-pty-${Math.random().toString(36).slice(2, 8)}`
          return Promise.resolve({ data: { id, title: args.title } })
        },
        update: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    },
    event: {
      on: (type: string, handler: (event: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(handler)
        return () => {
          listeners.get(type)?.delete(handler)
        }
      },
    },
  }
}

// Helper: run a test inside a SolidJS reactive root and wait for completion
function withRoot(fn: (dispose: VoidFunction) => Promise<void>): Promise<void> {
  return new Promise<void>((done, fail) => {
    createRoot(async (dispose) => {
      try {
        await fn(dispose)
      } catch (err) {
        fail(err)
      } finally {
        dispose()
        done()
      }
    })
  })
}

describe("terminal clone safety", () => {
  test("clone re-looks up entry by ID after async gap, not stale index", async () => {
    let resolveCreate: ((v: { data: { id: string; title: string } }) => void) | undefined

    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      // Create 2 terminals with immediate resolution
      let count = 0
      sdk.client.pty.create = (args: { title: string }) => {
        count++
        return Promise.resolve({ data: { id: `pty-${count}`, title: args.title } })
      }
      session.new()
      session.new()
      await new Promise((r) => setTimeout(r, 10))

      expect(session.all().length).toBe(2)
      expect(session.all()[0].id).toBe("pty-1")
      expect(session.all()[1].id).toBe("pty-2")

      // Set up delayed create for cloning pty-1
      sdk.client.pty.create = (_args: { title: string }) => {
        return new Promise((r) => {
          resolveCreate = r
        })
      }

      const clonePromise = session.clone("pty-1")

      // Resolve the clone creation
      resolveCreate!({ data: { id: "cloned-pty-1", title: "Terminal 1" } })
      await clonePromise

      // Verify pty-1 was replaced with cloned-pty-1 at the correct position
      const afterClone = session.all()
      expect(afterClone.length).toBe(2)
      expect(afterClone[0].id).toBe("cloned-pty-1")
      expect(afterClone[0].title).toBe("Terminal 1")
      // pty-2 should be untouched
      expect(afterClone[1].id).toBe("pty-2")
    })
  })

  test("clone does not copy buffer from old PTY (starts fresh)", async () => {
    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      session.new()
      await new Promise((r) => setTimeout(r, 10))

      const originalId = session.all()[0].id

      // Update it with a buffer and scroll position
      session.update({
        id: originalId,
        buffer: "some terminal output that should NOT be carried over",
        scrollY: 42,
        cursor: 100,
      })

      // Reset create for clone
      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "cloned-1", title: args.title } })

      await session.clone(originalId)

      const cloned = session.all()[0]
      expect(cloned.id).toBe("cloned-1")
      // Buffer should NOT be copied (fresh start since old PTY is gone)
      expect(cloned.buffer).toBeUndefined()
      expect(cloned.scrollY).toBeUndefined()
      expect(cloned.cursor).toBeUndefined()
    })
  })

  test("clone preserves title, titleNumber, rows, cols, and claudeSessionId", async () => {
    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      session.new()
      await new Promise((r) => setTimeout(r, 10))

      const originalId = session.all()[0].id

      session.update({
        id: originalId,
        rows: 24,
        cols: 80,
        claudeSessionId: "session-abc",
      })

      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "cloned-1", title: args.title } })

      await session.clone(originalId)

      const cloned = session.all()[0]
      expect(cloned.id).toBe("cloned-1")
      expect(cloned.rows).toBe(24)
      expect(cloned.cols).toBe(80)
      expect(cloned.claudeSessionId).toBe("session-abc")
    })
  })

  test("double-clone of the same terminal is prevented (idempotent)", async () => {
    let createCallCount = 0
    let resolveCreate: ((v: { data: { id: string; title: string } }) => void) | undefined

    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      // Create a terminal with immediate resolution
      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "pty-1", title: args.title } })
      session.new()
      await new Promise((r) => setTimeout(r, 10))

      expect(session.all().length).toBe(1)
      expect(session.all()[0].id).toBe("pty-1")

      // Set up delayed creates for cloning
      createCallCount = 0
      sdk.client.pty.create = (args: { title: string }) => {
        createCallCount++
        return new Promise((r) => {
          resolveCreate = r
        })
      }

      // Start two concurrent clones for the same PTY
      const clone1 = session.clone("pty-1")
      const clone2 = session.clone("pty-1") // Should be rejected by the guard

      // Only one create call should have been made
      expect(createCallCount).toBe(1)

      // Resolve the first clone
      resolveCreate!({ data: { id: "cloned-pty-1", title: "Terminal 1" } })
      await clone1
      await clone2

      // Only one terminal should exist (no duplicates)
      const all = session.all()
      expect(all.length).toBe(1)
      expect(all[0].id).toBe("cloned-pty-1")
    })
  })

  test("concurrent clones for different terminals don't interfere", async () => {
    const createResults = new Map<string, (v: { data: { id: string; title: string } }) => void>()
    let createCallCount = 0

    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      // Create 3 terminals
      let count = 0
      sdk.client.pty.create = (args: { title: string }) => {
        count++
        return Promise.resolve({ data: { id: `pty-${count}`, title: args.title } })
      }
      session.new()
      session.new()
      session.new()
      await new Promise((r) => setTimeout(r, 10))

      expect(session.all().length).toBe(3)

      // Update with distinct buffers
      session.update({ id: "pty-1", buffer: "buffer-1" })
      session.update({ id: "pty-2", buffer: "buffer-2" })
      session.update({ id: "pty-3", buffer: "buffer-3" })

      // Set up delayed creates for cloning
      createCallCount = 0
      createResults.clear()
      sdk.client.pty.create = (args: { title: string }) => {
        createCallCount++
        return new Promise((r) => {
          createResults.set(args.title, r)
        })
      }

      // Clone all 3 concurrently
      const c1 = session.clone("pty-1")
      const c2 = session.clone("pty-2")
      const c3 = session.clone("pty-3")

      // All 3 should have triggered create calls
      expect(createCallCount).toBe(3)

      // Resolve in reverse order to stress test
      createResults.get("Terminal 3")!({ data: { id: "cloned-3", title: "Terminal 3" } })
      await new Promise((r) => setTimeout(r, 5))
      createResults.get("Terminal 1")!({ data: { id: "cloned-1", title: "Terminal 1" } })
      await new Promise((r) => setTimeout(r, 5))
      createResults.get("Terminal 2")!({ data: { id: "cloned-2", title: "Terminal 2" } })

      await Promise.all([c1, c2, c3])

      const all = session.all()
      expect(all.length).toBe(3)

      // Each terminal should have its own new ID
      const ids = all.map((t) => t.id)
      expect(ids).toContain("cloned-1")
      expect(ids).toContain("cloned-2")
      expect(ids).toContain("cloned-3")

      // No buffers should have been copied (fresh start for all)
      for (const t of all) {
        expect(t.buffer).toBeUndefined()
      }
    })
  })

  test("clone updates active terminal when the cloned terminal was active", async () => {
    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "pty-1", title: args.title } })
      session.new()
      await new Promise((r) => setTimeout(r, 10))

      session.open("pty-1")
      expect(session.active()).toBe("pty-1")

      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "cloned-1", title: args.title } })
      await session.clone("pty-1")

      expect(session.all()[0].id).toBe("cloned-1")
      // Active should have been updated to the new cloned ID
      expect(session.active()).toBe("cloned-1")
    })
  })

  test("clone does not update active when a different terminal was active", async () => {
    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      let count = 0
      sdk.client.pty.create = (args: { title: string }) => {
        count++
        return Promise.resolve({ data: { id: `pty-${count}`, title: args.title } })
      }
      session.new()
      session.new()
      await new Promise((r) => setTimeout(r, 10))

      // Set active to pty-2
      session.open("pty-2")
      expect(session.active()).toBe("pty-2")

      // Clone pty-1 (which is NOT active)
      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "cloned-1", title: args.title } })
      await session.clone("pty-1")

      // Active should still be pty-2
      expect(session.active()).toBe("pty-2")
    })
  })

  test("clone bails out if entry was removed during async gap", async () => {
    let resolveCreate: ((v: { data: { id: string; title: string } }) => void) | undefined

    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "pty-1", title: args.title } })
      session.new()
      await new Promise((r) => setTimeout(r, 10))

      // Set up delayed create for clone
      sdk.client.pty.create = (_args: { title: string }) => {
        return new Promise((r) => {
          resolveCreate = r
        })
      }

      const clonePromise = session.clone("pty-1")

      // Close the terminal while clone is in progress
      sdk.client.pty.remove = () => Promise.resolve()
      await session.close("pty-1")
      expect(session.all().length).toBe(0)

      // Now resolve the clone
      resolveCreate!({ data: { id: "orphan-clone", title: "Terminal 1" } })
      await clonePromise

      // The clone should have bailed out since the entry was removed
      expect(session.all().length).toBe(0)
    })
  })

  test("clone for non-existent PTY ID is a no-op", async () => {
    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "pty-1", title: args.title } })
      session.new()
      await new Promise((r) => setTimeout(r, 10))

      const before = session.all().length
      await session.clone("non-existent-pty")
      expect(session.all().length).toBe(before)
    })
  })

  test("titleNumber is preserved correctly across clone", async () => {
    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      let count = 0
      sdk.client.pty.create = (args: { title: string }) => {
        count++
        return Promise.resolve({ data: { id: `pty-${count}`, title: args.title } })
      }
      session.new() // Terminal 1
      session.new() // Terminal 2
      session.new() // Terminal 3
      await new Promise((r) => setTimeout(r, 10))

      const all = session.all()
      expect(all[0].titleNumber).toBe(1)
      expect(all[1].titleNumber).toBe(2)
      expect(all[2].titleNumber).toBe(3)

      // Clone terminal 2
      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "cloned-2", title: args.title } })
      await session.clone("pty-2")

      const afterClone = session.all()
      expect(afterClone.length).toBe(3)
      // Terminal numbers should be preserved
      expect(afterClone[0].titleNumber).toBe(1)
      expect(afterClone[1].titleNumber).toBe(2) // Cloned terminal keeps its number
      expect(afterClone[1].id).toBe("cloned-2")
      expect(afterClone[2].titleNumber).toBe(3)
    })
  })

  test("clone allows re-cloning after previous clone completes", async () => {
    const sdk = createMockSDK()

    await withRoot(async () => {
      const session = createWorkspaceTerminalSession(sdk as any, "/test")

      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "pty-1", title: args.title } })
      session.new()
      await new Promise((r) => setTimeout(r, 10))

      // First clone
      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "cloned-1", title: args.title } })
      await session.clone("pty-1")
      expect(session.all()[0].id).toBe("cloned-1")

      // Second clone of the new ID should work (not blocked by old clone)
      sdk.client.pty.create = (args: { title: string }) =>
        Promise.resolve({ data: { id: "cloned-2", title: args.title } })
      await session.clone("cloned-1")
      expect(session.all()[0].id).toBe("cloned-2")
    })
  })
})
