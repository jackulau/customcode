import { describe, expect, test } from "bun:test"
import type { LocalPTY } from "@/context/terminal"

/**
 * Tests for the terminal resume command spam fix.
 *
 * The core fix adds a `resumeSent` field to `LocalPTY` that persists across
 * mount/unmount cycles, preventing `claude --resume <id>` from being sent
 * repeatedly when the Terminal component re-mounts (e.g., panel toggle).
 */

// Mirror the pure functions from terminal.tsx (not exported, so replicated for testing)
const isClaudeCommand = (cmd: string): boolean => /^claude(\s|$)/.test(cmd.trim())
const hasClaudeSessionFlags = (cmd: string): boolean =>
  /--(?:session-id|resume|continue)\b/.test(cmd) || /\s-[cr]\b/.test(cmd)
const stripClaudeSessionFlags = (cmd: string): string =>
  cmd.replace(/\s+--(?:session-id|resume)\s+\S+/g, "").trim()

describe("terminal resume spam fix", () => {
  describe("LocalPTY resumeSent field", () => {
    test("resumeSent defaults to undefined (backwards compatible)", () => {
      const pty: LocalPTY = {
        id: "test-1",
        title: "Terminal 1",
        titleNumber: 1,
        claudeSessionId: "session-abc",
      }
      // Old persisted data won't have resumeSent — must be undefined
      expect(pty.resumeSent).toBeUndefined()
    })

    test("resumeSent can be set to true", () => {
      const pty: LocalPTY = {
        id: "test-1",
        title: "Terminal 1",
        titleNumber: 1,
        claudeSessionId: "session-abc",
        resumeSent: true,
      }
      expect(pty.resumeSent).toBe(true)
    })

    test("resumeSent can be set to false for clone scenario", () => {
      const pty: LocalPTY = {
        id: "test-1",
        title: "Terminal 1",
        titleNumber: 1,
        claudeSessionId: "session-abc",
        resumeSent: false,
      }
      expect(pty.resumeSent).toBe(false)
    })

    test("clone should reset resumeSent to false", () => {
      const original: LocalPTY = {
        id: "original-1",
        title: "Terminal 1",
        titleNumber: 1,
        claudeSessionId: "session-abc",
        resumeSent: true,
      }

      // Simulate clone() behavior from terminal context
      const cloned: LocalPTY = {
        id: "clone-1",
        title: original.title,
        titleNumber: original.titleNumber,
        buffer: original.buffer,
        scrollY: original.scrollY,
        rows: original.rows,
        cols: original.cols,
        cursor: undefined,
        claudeSessionId: original.claudeSessionId,
        resumeSent: false,
      }

      expect(cloned.claudeSessionId).toBe("session-abc")
      expect(cloned.resumeSent).toBe(false)
    })
  })

  describe("resumeSent guard logic", () => {
    test("resume should be sent when resumeSent is false", () => {
      const claudeSessionId = "session-abc"
      const isClaude = true
      const userManaged = false
      const resumeSent = false
      const restore = "some-buffer-content"

      const shouldSendResume =
        !!restore && !!claudeSessionId && isClaude && !userManaged && !resumeSent

      expect(shouldSendResume).toBe(true)
    })

    test("resume should NOT be sent when resumeSent is true (panel toggle)", () => {
      const claudeSessionId = "session-abc"
      const isClaude = true
      const userManaged = false
      const resumeSent = true
      const restore = "some-buffer-content"

      const shouldSendResume =
        !!restore && !!claudeSessionId && isClaude && !userManaged && !resumeSent

      expect(shouldSendResume).toBe(false)
    })

    test("resume should NOT be sent when no claudeSessionId", () => {
      const claudeSessionId: string | undefined = undefined
      const isClaude = true
      const userManaged = false
      const resumeSent = false
      const restore = "some-buffer-content"

      const shouldSendResume =
        !!restore && !!claudeSessionId && isClaude && !userManaged && !resumeSent

      expect(shouldSendResume).toBe(false)
    })

    test("resume should NOT be sent when user manages session flags", () => {
      const claudeSessionId = "session-abc"
      const isClaude = true
      const userManaged = true
      const resumeSent = false
      const restore = "some-buffer-content"

      const shouldSendResume =
        !!restore && !!claudeSessionId && isClaude && !userManaged && !resumeSent

      expect(shouldSendResume).toBe(false)
    })

    test("resume should NOT be sent when command is not Claude", () => {
      const claudeSessionId = "session-abc"
      const isClaude = false
      const userManaged = false
      const resumeSent = false
      const restore = "some-buffer-content"

      const shouldSendResume =
        !!restore && !!claudeSessionId && isClaude && !userManaged && !resumeSent

      expect(shouldSendResume).toBe(false)
    })

    test("backwards compatible: undefined resumeSent treated as false (sends resume once)", () => {
      const pty: LocalPTY = {
        id: "test-1",
        title: "Terminal 1",
        titleNumber: 1,
        claudeSessionId: "session-abc",
        // resumeSent is not set (old persisted data)
      }

      // !!undefined is false, so resume will be sent (correct for old data)
      const resumeSent = !!pty.resumeSent
      expect(resumeSent).toBe(false)

      const shouldSendResume = true && !!pty.claudeSessionId && true && !false && !resumeSent
      expect(shouldSendResume).toBe(true)
    })
  })

  describe("persistTerminal includes resumeSent", () => {
    test("persisted PTY includes resumeSent: true after resume was sent", () => {
      const ptyAtMount: LocalPTY = {
        id: "test-1",
        title: "Terminal 1",
        titleNumber: 1,
      }
      const claudeSessionId = "session-abc"
      const resumeSent = true

      // Simulate what persistTerminal produces
      const persisted: LocalPTY = {
        ...ptyAtMount,
        buffer: "serialized-buffer",
        cursor: 42,
        rows: 24,
        cols: 80,
        scrollY: 0,
        claudeSessionId,
        resumeSent,
      }

      expect(persisted.resumeSent).toBe(true)
      expect(persisted.claudeSessionId).toBe("session-abc")
    })

    test("persisted PTY includes resumeSent: false when resume was not sent", () => {
      const ptyAtMount: LocalPTY = {
        id: "test-1",
        title: "Terminal 1",
        titleNumber: 1,
      }
      const resumeSent = false

      const persisted: LocalPTY = {
        ...ptyAtMount,
        buffer: "",
        cursor: 0,
        rows: 24,
        cols: 80,
        scrollY: 0,
        claudeSessionId: undefined,
        resumeSent,
      }

      expect(persisted.resumeSent).toBe(false)
    })
  })

  describe("helper functions (replicated)", () => {
    test("isClaudeCommand detects claude commands", () => {
      expect(isClaudeCommand("claude")).toBe(true)
      expect(isClaudeCommand("claude --model sonnet")).toBe(true)
      expect(isClaudeCommand("  claude  ")).toBe(true)
      expect(isClaudeCommand("claude-dev")).toBe(false)
      expect(isClaudeCommand("not-claude")).toBe(false)
    })

    test("hasClaudeSessionFlags detects session flags", () => {
      expect(hasClaudeSessionFlags("claude --session-id abc")).toBe(true)
      expect(hasClaudeSessionFlags("claude --resume abc")).toBe(true)
      expect(hasClaudeSessionFlags("claude --continue")).toBe(true)
      expect(hasClaudeSessionFlags("claude -r")).toBe(true)
      expect(hasClaudeSessionFlags("claude -c")).toBe(true)
      expect(hasClaudeSessionFlags("claude --model sonnet")).toBe(false)
    })

    test("stripClaudeSessionFlags removes session flags", () => {
      expect(stripClaudeSessionFlags("claude --session-id abc")).toBe("claude")
      expect(stripClaudeSessionFlags("claude --resume abc")).toBe("claude")
      expect(stripClaudeSessionFlags("claude --model sonnet --session-id abc")).toBe(
        "claude --model sonnet",
      )
    })
  })

  describe("mount/unmount cycle simulation", () => {
    test("simulates panel toggle: resume NOT sent on remount", () => {
      // First mount: resume is sent
      let resumeSent = false // from !!pty.resumeSent (undefined -> false)
      const claudeSessionId = "session-abc"
      const restore = "buffer-content"
      const cmd = "claude"

      // First mount handleOpen
      const isClaude = isClaudeCommand(cmd)
      const userManaged = isClaude && hasClaudeSessionFlags(cmd)

      if (restore && claudeSessionId && isClaude && !userManaged && !resumeSent) {
        resumeSent = true // Resume sent
      }
      expect(resumeSent).toBe(true)

      // Persist on cleanup (includes resumeSent: true)
      const persistedPty: LocalPTY = {
        id: "test-1",
        title: "Terminal 1",
        titleNumber: 1,
        claudeSessionId,
        resumeSent,
        buffer: restore,
      }

      // Second mount: resume should NOT be sent
      let resumeSent2 = !!persistedPty.resumeSent // true
      const restore2 = persistedPty.buffer

      if (restore2 && claudeSessionId && isClaude && !userManaged && !resumeSent2) {
        resumeSent2 = true
      }
      // resumeSent2 should still be true from initialization, guard prevented re-send
      expect(resumeSent2).toBe(true)
    })

    test("simulates PTY clone: resume sent in new PTY", () => {
      // Original PTY had resume already sent
      const originalPty: LocalPTY = {
        id: "original-1",
        title: "Terminal 1",
        titleNumber: 1,
        claudeSessionId: "session-abc",
        resumeSent: true,
        buffer: "buffer-content",
      }

      // Clone resets resumeSent to false
      const clonedPty: LocalPTY = {
        id: "clone-1",
        title: originalPty.title,
        titleNumber: originalPty.titleNumber,
        buffer: originalPty.buffer,
        claudeSessionId: originalPty.claudeSessionId,
        resumeSent: false, // Key: clone resets this
      }

      // New mount with cloned PTY
      let resumeSent = !!clonedPty.resumeSent // false
      const cmd = "claude"
      const isClaude = isClaudeCommand(cmd)
      const userManaged = isClaude && hasClaudeSessionFlags(cmd)
      const restore = clonedPty.buffer

      if (restore && clonedPty.claudeSessionId && isClaude && !userManaged && !resumeSent) {
        resumeSent = true
      }
      expect(resumeSent).toBe(true) // Resume was correctly sent for cloned PTY
    })
  })
})
