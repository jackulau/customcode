import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

type PersistTestingType = typeof import("./persist").PersistTesting

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  readonly events: string[] = []
  readonly calls = { get: 0, set: 0, remove: 0 }

  clear() {
    this.values.clear()
  }

  get length() {
    return this.values.size
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  getItem(key: string) {
    this.calls.get += 1
    this.events.push(`get:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage get failed")
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.calls.set += 1
    this.events.push(`set:${key}`)
    if (key.startsWith("opencode.quota")) throw new DOMException("quota", "QuotaExceededError")
    if (key.startsWith("opencode.throw")) throw new Error("storage set failed")
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.calls.remove += 1
    this.events.push(`remove:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage remove failed")
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()

let persistTesting: PersistTestingType

beforeAll(async () => {
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))

  const mod = await import("./persist")
  persistTesting = mod.PersistTesting
})

beforeEach(() => {
  storage.clear()
  storage.events.length = 0
  storage.calls.get = 0
  storage.calls.set = 0
  storage.calls.remove = 0
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  })
})

describe("persist localStorage resilience", () => {
  test("does not cache values as persisted when quota write and eviction fail", () => {
    const storageApi = persistTesting.localStorageWithPrefix("opencode.quota.scope")
    storageApi.setItem("value", '{"value":1}')

    expect(storage.getItem("opencode.quota.scope:value")).toBeNull()
    expect(storageApi.getItem("value")).toBeNull()
  })

  test("disables only the failing scope when storage throws", () => {
    const bad = persistTesting.localStorageWithPrefix("opencode.throw.scope")
    bad.setItem("value", '{"value":1}')

    const before = storage.calls.set
    bad.setItem("value", '{"value":2}')
    expect(storage.calls.set).toBe(before)
    expect(bad.getItem("value")).toBeNull()

    const healthy = persistTesting.localStorageWithPrefix("opencode.safe.scope")
    healthy.setItem("value", '{"value":3}')
    expect(storage.getItem("opencode.safe.scope:value")).toBe('{"value":3}')
  })

  test("failing fallback scope does not poison direct storage scope", () => {
    const broken = persistTesting.localStorageWithPrefix("opencode.throw.scope2")
    broken.setItem("value", '{"value":1}')

    const direct = persistTesting.localStorageDirect()
    direct.setItem("direct-value", '{"value":5}')

    expect(storage.getItem("direct-value")).toBe('{"value":5}')
  })

  test("normalizer rejects malformed JSON payloads", () => {
    const result = persistTesting.normalize({ value: "ok" }, '{"value":"\\x"}')
    expect(result).toBeUndefined()
  })
})

describe("workspace storage key uniqueness", () => {
  test("different directories produce different storage keys", () => {
    const dirs = [
      "/Users/alice/project-a",
      "/Users/alice/project-b",
      "/Users/bob/project-a",
      "/home/user/workspace",
      "/tmp/test",
    ]
    const keys = dirs.map((dir) => persistTesting.workspaceStorage(dir))
    const unique = new Set(keys)
    expect(unique.size).toBe(dirs.length)
  })

  test("directories sharing a common prefix produce different keys", () => {
    const keyA = persistTesting.workspaceStorage("/Users/alice/projects/alpha")
    const keyB = persistTesting.workspaceStorage("/Users/alice/projects/beta")
    expect(keyA).not.toBe(keyB)
  })

  test("same directory always produces the same key", () => {
    const dir = "/Users/alice/my-project"
    const key1 = persistTesting.workspaceStorage(dir)
    const key2 = persistTesting.workspaceStorage(dir)
    expect(key1).toBe(key2)
  })

  test("empty directory uses fallback head", () => {
    const key = persistTesting.workspaceStorage("")
    expect(key).toContain("workspace")
  })

  test("storage key format is valid", () => {
    const key = persistTesting.workspaceStorage("/Users/alice/project")
    expect(key).toMatch(/^opencode\.workspace\..+\..+\.dat$/)
  })

  test("directories differing only by trailing slash produce different keys", () => {
    const keyA = persistTesting.workspaceStorage("/Users/alice/project")
    const keyB = persistTesting.workspaceStorage("/Users/alice/project/")
    // These should differ because the full path differs (checksum is of the whole string)
    expect(keyA).not.toBe(keyB)
  })

  test("large batch of similar directories does not produce collisions", () => {
    // Generate 200 similar directory paths to verify no collisions in a realistic scenario
    const dirs = Array.from({ length: 200 }, (_, i) => `/Users/alice/projects/project-${i}`)
    const keys = dirs.map((dir) => persistTesting.workspaceStorage(dir))
    const unique = new Set(keys)
    expect(unique.size).toBe(dirs.length)
  })
})
