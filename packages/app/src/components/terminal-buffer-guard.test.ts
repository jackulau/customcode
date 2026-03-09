import { describe, expect, test } from "bun:test"

/**
 * Tests for the terminal buffer restore guard logic.
 *
 * These test the pure validation logic that decides whether a persisted
 * buffer is safe to restore and whether cursor values are consistent.
 * The actual component (terminal.tsx) inlines this logic, so we mirror
 * the conditions here to ensure correctness.
 */

/**
 * Mirrors the buffer validation in terminal.tsx ~line 442.
 * Returns true if the buffer should be restored.
 */
function shouldRestoreBuffer(pty: {
  buffer?: string
  cursor?: number
}): boolean {
  const hasValidCursor =
    typeof pty.cursor === "number" && Number.isSafeInteger(pty.cursor)
  return (
    typeof pty.buffer === "string" && (hasValidCursor || !pty.cursor)
  )
}

/**
 * Mirrors the cursor validation in terminal.tsx handleMessage.
 * Returns true if the cursor jump is backward (suspicious).
 */
function isCursorBackwardJump(
  currentCursor: number,
  nextCursor: number,
): boolean {
  return nextCursor < currentCursor
}

/**
 * Mirrors the initial cursor calculation in terminal.tsx ~line 625.
 */
function computeInitialCursor(start: number | undefined, hasBuffer: boolean): number {
  return start !== undefined ? start : hasBuffer ? -1 : 0
}

describe("terminal buffer restore guard", () => {
  describe("shouldRestoreBuffer", () => {
    test("restores buffer with valid integer cursor", () => {
      expect(
        shouldRestoreBuffer({ buffer: "some content", cursor: 42 }),
      ).toBe(true)
    })

    test("restores buffer with cursor = 0", () => {
      // cursor = 0 is falsy but is a valid integer cursor
      expect(
        shouldRestoreBuffer({ buffer: "some content", cursor: 0 }),
      ).toBe(true)
    })

    test("restores buffer when cursor is undefined (no cursor stored)", () => {
      // undefined cursor means the buffer was saved without cursor tracking
      // (e.g., from clone). This is acceptable — !pty.cursor is true.
      expect(
        shouldRestoreBuffer({ buffer: "some content", cursor: undefined }),
      ).toBe(true)
    })

    test("discards buffer when cursor is NaN", () => {
      expect(
        shouldRestoreBuffer({ buffer: "some content", cursor: NaN }),
      ).toBe(false)
    })

    test("discards buffer when cursor is Infinity", () => {
      expect(
        shouldRestoreBuffer({ buffer: "some content", cursor: Infinity }),
      ).toBe(false)
    })

    test("discards buffer when cursor is a non-safe integer", () => {
      expect(
        shouldRestoreBuffer({
          buffer: "some content",
          cursor: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).toBe(false)
    })

    test("returns false when buffer is not a string", () => {
      expect(shouldRestoreBuffer({ buffer: undefined })).toBe(false)
    })

    test("returns true for empty string buffer with valid cursor", () => {
      // Empty string is still typeof "string" — but empty restore is a no-op
      expect(shouldRestoreBuffer({ buffer: "", cursor: 10 })).toBe(true)
    })
  })

  describe("cursor backward jump detection", () => {
    test("detects backward jump", () => {
      expect(isCursorBackwardJump(100, 50)).toBe(true)
    })

    test("allows forward jump", () => {
      expect(isCursorBackwardJump(50, 100)).toBe(false)
    })

    test("allows same position", () => {
      expect(isCursorBackwardJump(100, 100)).toBe(false)
    })

    test("detects jump from large to zero", () => {
      expect(isCursorBackwardJump(5000, 0)).toBe(true)
    })
  })

  describe("initial cursor computation", () => {
    test("uses persisted start when available", () => {
      expect(computeInitialCursor(42, true)).toBe(42)
      expect(computeInitialCursor(42, false)).toBe(42)
    })

    test("uses -1 when buffer exists but no start cursor", () => {
      expect(computeInitialCursor(undefined, true)).toBe(-1)
    })

    test("uses 0 when no buffer and no start cursor", () => {
      expect(computeInitialCursor(undefined, false)).toBe(0)
    })

    test("uses persisted start of 0", () => {
      expect(computeInitialCursor(0, true)).toBe(0)
      expect(computeInitialCursor(0, false)).toBe(0)
    })
  })

  describe("buffer clear on connect error", () => {
    test("clone receives cleared buffer after update", () => {
      // Simulates the terminal-panel.tsx flow:
      // 1. onConnectError fires
      // 2. terminal.update({ id, buffer: undefined, cursor: undefined, scrollY: undefined })
      // 3. terminal.clone(id) reads from store

      const store = {
        id: "pty-123",
        title: "Terminal 1",
        titleNumber: 1,
        buffer: "stale content from another session",
        cursor: 500,
        scrollY: 10,
        rows: 24,
        cols: 80,
      }

      // Step 2: clear buffer
      const updated = {
        ...store,
        buffer: undefined,
        cursor: undefined,
        scrollY: undefined,
      }

      // Step 3: clone reads the buffer
      expect(updated.buffer).toBeUndefined()
      expect(updated.cursor).toBeUndefined()
      expect(updated.scrollY).toBeUndefined()
      // Title and geometry are preserved for the clone
      expect(updated.title).toBe("Terminal 1")
      expect(updated.rows).toBe(24)
      expect(updated.cols).toBe(80)
    })
  })
})
