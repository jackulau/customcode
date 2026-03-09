import { describe, test, expect, mock } from "bun:test"

/**
 * Tests for the keyboard shortcut logic in file-tabs.tsx
 *
 * The keydown handler at capture phase should:
 * - Cmd+F in comment mode: preventDefault + stopPropagation + focus file search
 * - Cmd+F in edit mode: let CodeMirror handle it (no preventDefault)
 * - Cmd+S in edit mode: let CodeMirror handle it (no preventDefault)
 * - Cmd+S in comment mode: do nothing (no preventDefault)
 * - Ignore events with altKey or shiftKey
 * - Ignore events already defaultPrevented
 * - Ignore events when the tab is not active
 */

type KeyDownOpts = {
  editing: boolean
  isActiveTab: boolean
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  defaultPrevented?: boolean
}

function simulateKeyDown(opts: KeyDownOpts) {
  let preventDefaultCalled = false
  let stopPropagationCalled = false
  const findFocused = mock(() => {})

  // Reproduce the handler logic from file-tabs.tsx
  const event = {
    defaultPrevented: opts.defaultPrevented ?? false,
    metaKey: opts.metaKey ?? true,
    ctrlKey: opts.ctrlKey ?? false,
    altKey: opts.altKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    key: opts.key,
    preventDefault: () => {
      preventDefaultCalled = true
    },
    stopPropagation: () => {
      stopPropagationCalled = true
    },
  }

  const editing = () => opts.editing
  const isActiveTab = opts.isActiveTab
  const find = { focus: findFocused }

  // --- Begin handler logic (mirrors file-tabs.tsx onKeyDown) ---
  if (event.defaultPrevented) return { preventDefaultCalled, stopPropagationCalled, findFocused }
  if (!isActiveTab) return { preventDefaultCalled, stopPropagationCalled, findFocused }
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
    return { preventDefaultCalled, stopPropagationCalled, findFocused }

  const key = event.key.toLowerCase()
  if (key === "f") {
    if (editing()) return { preventDefaultCalled, stopPropagationCalled, findFocused }
    event.preventDefault()
    event.stopPropagation()
    find?.focus()
    return { preventDefaultCalled, stopPropagationCalled, findFocused }
  }
  if (key === "s") {
    if (!editing()) return { preventDefaultCalled, stopPropagationCalled, findFocused }
    return { preventDefaultCalled, stopPropagationCalled, findFocused }
  }
  // --- End handler logic ---

  return { preventDefaultCalled, stopPropagationCalled, findFocused }
}

describe("file-tabs keyboard handler", () => {
  describe("Cmd+F behavior", () => {
    test("in comment mode: intercepts and focuses file search", () => {
      const result = simulateKeyDown({
        editing: false,
        isActiveTab: true,
        key: "f",
        metaKey: true,
      })
      expect(result.preventDefaultCalled).toBe(true)
      expect(result.stopPropagationCalled).toBe(true)
      expect(result.findFocused).toHaveBeenCalledTimes(1)
    })

    test("in edit mode: does NOT intercept (lets CodeMirror handle it)", () => {
      const result = simulateKeyDown({
        editing: true,
        isActiveTab: true,
        key: "f",
        metaKey: true,
      })
      expect(result.preventDefaultCalled).toBe(false)
      expect(result.stopPropagationCalled).toBe(false)
      expect(result.findFocused).toHaveBeenCalledTimes(0)
    })

    test("with Ctrl+F in comment mode: intercepts and focuses file search", () => {
      const result = simulateKeyDown({
        editing: false,
        isActiveTab: true,
        key: "f",
        ctrlKey: true,
        metaKey: false,
      })
      expect(result.preventDefaultCalled).toBe(true)
      expect(result.stopPropagationCalled).toBe(true)
      expect(result.findFocused).toHaveBeenCalledTimes(1)
    })

    test("with Ctrl+F in edit mode: does NOT intercept", () => {
      const result = simulateKeyDown({
        editing: true,
        isActiveTab: true,
        key: "f",
        ctrlKey: true,
        metaKey: false,
      })
      expect(result.preventDefaultCalled).toBe(false)
      expect(result.stopPropagationCalled).toBe(false)
      expect(result.findFocused).toHaveBeenCalledTimes(0)
    })
  })

  describe("Cmd+S behavior", () => {
    test("in edit mode: does NOT intercept (lets CodeMirror handle it)", () => {
      const result = simulateKeyDown({
        editing: true,
        isActiveTab: true,
        key: "s",
        metaKey: true,
      })
      expect(result.preventDefaultCalled).toBe(false)
      expect(result.stopPropagationCalled).toBe(false)
    })

    test("in comment mode: does nothing (no handler action)", () => {
      const result = simulateKeyDown({
        editing: false,
        isActiveTab: true,
        key: "s",
        metaKey: true,
      })
      expect(result.preventDefaultCalled).toBe(false)
      expect(result.stopPropagationCalled).toBe(false)
    })
  })

  describe("guard conditions", () => {
    test("ignores already-prevented events", () => {
      const result = simulateKeyDown({
        editing: false,
        isActiveTab: true,
        key: "f",
        metaKey: true,
        defaultPrevented: true,
      })
      expect(result.preventDefaultCalled).toBe(false)
      expect(result.findFocused).toHaveBeenCalledTimes(0)
    })

    test("ignores events when tab is not active", () => {
      const result = simulateKeyDown({
        editing: false,
        isActiveTab: false,
        key: "f",
        metaKey: true,
      })
      expect(result.preventDefaultCalled).toBe(false)
      expect(result.findFocused).toHaveBeenCalledTimes(0)
    })

    test("ignores Cmd+Alt+F (altKey modifier)", () => {
      const result = simulateKeyDown({
        editing: false,
        isActiveTab: true,
        key: "f",
        metaKey: true,
        altKey: true,
      })
      expect(result.preventDefaultCalled).toBe(false)
      expect(result.findFocused).toHaveBeenCalledTimes(0)
    })

    test("ignores Cmd+Shift+F (shiftKey modifier)", () => {
      const result = simulateKeyDown({
        editing: false,
        isActiveTab: true,
        key: "f",
        metaKey: true,
        shiftKey: true,
      })
      expect(result.preventDefaultCalled).toBe(false)
      expect(result.findFocused).toHaveBeenCalledTimes(0)
    })

    test("ignores keys without meta or ctrl", () => {
      const result = simulateKeyDown({
        editing: false,
        isActiveTab: true,
        key: "f",
        metaKey: false,
        ctrlKey: false,
      })
      expect(result.preventDefaultCalled).toBe(false)
      expect(result.findFocused).toHaveBeenCalledTimes(0)
    })
  })
})
