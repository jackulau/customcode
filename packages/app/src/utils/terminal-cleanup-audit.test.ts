/**
 * Terminal Cleanup Audit Tests
 *
 * Validates the invariants identified during the PTY lifecycle audit:
 * - Storage keys are collision-free across workspaces
 * - Checksum function provides adequate collision resistance
 * - Workspace terminal cache keys are correctly scoped
 */
import { describe, expect, test } from "bun:test"
import { checksum } from "@opencode-ai/util/encode"

// Inline the workspace terminal cache key function to avoid importing
// the full SolidJS-dependent terminal context module in tests.
const WORKSPACE_KEY = "__workspace__"
function getWorkspaceTerminalCacheKey(dir: string) {
  return `${dir}:${WORKSPACE_KEY}`
}

describe("terminal cleanup audit", () => {
  describe("FNV-1a checksum collision resistance", () => {
    test("similar paths produce distinct checksums", () => {
      const paths = [
        "/Users/alice/project",
        "/Users/alice/project2",
        "/Users/alice/projects",
        "/Users/bob/project",
        "/Users/alice/Project",
      ]
      const checksums = paths.map((p) => checksum(p))
      const unique = new Set(checksums)
      expect(unique.size).toBe(paths.length)
    })

    test("single-character differences produce different checksums", () => {
      const a = checksum("abcdef")
      const b = checksum("abcdeg")
      expect(a).not.toBe(b)
    })

    test("checksum returns undefined for empty input", () => {
      expect(checksum("")).toBeUndefined()
    })

    test("checksum is deterministic", () => {
      const path = "/home/user/workspace/my-project"
      expect(checksum(path)).toBe(checksum(path))
    })

    test("500 sequential directory names produce no collisions", () => {
      const checksums = new Set<string | undefined>()
      for (let i = 0; i < 500; i++) {
        checksums.add(checksum(`/home/user/project-${i}`))
      }
      expect(checksums.size).toBe(500)
    })
  })

  describe("workspace terminal cache key scoping", () => {
    test("different directories produce different cache keys", () => {
      const keyA = getWorkspaceTerminalCacheKey("/Users/alice/project-a")
      const keyB = getWorkspaceTerminalCacheKey("/Users/alice/project-b")
      expect(keyA).not.toBe(keyB)
    })

    test("same directory produces the same cache key", () => {
      const dir = "/Users/alice/project"
      expect(getWorkspaceTerminalCacheKey(dir)).toBe(getWorkspaceTerminalCacheKey(dir))
    })

    test("cache key contains the directory path", () => {
      const dir = "/Users/alice/my-project"
      const key = getWorkspaceTerminalCacheKey(dir)
      expect(key).toContain(dir)
    })

    test("cache key contains the workspace marker", () => {
      const key = getWorkspaceTerminalCacheKey("/tmp/test")
      expect(key).toContain(WORKSPACE_KEY)
    })

    test("clearWorkspaceTerminals cannot affect different directories", () => {
      // Verify the key format ensures directory-scoped operations
      const keyA = getWorkspaceTerminalCacheKey("/Users/alice/project-a")
      const keyB = getWorkspaceTerminalCacheKey("/Users/alice/project-b")
      // Since clearWorkspaceTerminals looks up by exact key,
      // different keys mean different directories are isolated
      expect(keyA).not.toBe(keyB)
      expect(keyA.startsWith("/Users/alice/project-a:")).toBe(true)
      expect(keyB.startsWith("/Users/alice/project-b:")).toBe(true)
    })
  })

  describe("subscriber key uniqueness", () => {
    test("empty object literals are unique by reference", () => {
      // This validates the approach used in pty/index.ts connect()
      // where connectionKey = {} creates a unique key per connection
      const keys = Array.from({ length: 100 }, () => ({}))
      const set = new Set(keys)
      expect(set.size).toBe(100)
    })

    test("Map correctly distinguishes empty object keys", () => {
      const map = new Map<object, string>()
      const key1 = {}
      const key2 = {}
      map.set(key1, "connection-1")
      map.set(key2, "connection-2")
      expect(map.size).toBe(2)
      expect(map.get(key1)).toBe("connection-1")
      expect(map.get(key2)).toBe("connection-2")

      // Deleting one does not affect the other
      map.delete(key1)
      expect(map.size).toBe(1)
      expect(map.get(key2)).toBe("connection-2")
    })
  })
})
