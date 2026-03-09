import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createLineCommentState } from "@opencode-ai/ui/line-comment-annotations"

type SelectedLineRange = {
  start: number
  end: number
  side?: "additions" | "deletions"
  endSide?: "additions" | "deletions"
}

/**
 * Tests for the comment state cleanup during mode transitions in file-tabs.
 *
 * In the FileTabContent component, switching between "comment" and "edit" modes
 * must reset the comment UI state to prevent stale popovers, drafts, or
 * selections from leaking across modes.
 *
 * These tests verify the contract that `commentsUi.note.reset()` clears all
 * comment-related state, which is the mechanism used by `enterEditMode` and
 * `exitEditMode`.
 */

function createTestCommentState() {
  const [store, setStore] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    selected: null as SelectedLineRange | null,
  })

  const note = createLineCommentState<string>({
    opened: () => store.openedComment,
    setOpened: (id) => setStore("openedComment", id),
    selected: () => store.selected,
    setSelected: (range) => setStore("selected", range),
    commenting: () => store.commenting,
    setCommenting: (range) => setStore("commenting", range),
  })

  return { note, store, setStore }
}

describe("comment state cleanup on mode transitions", () => {
  test("reset clears an open comment popover", () => {
    createRoot((dispose) => {
      const { note, store } = createTestCommentState()

      // Simulate opening a comment
      note.openComment("comment-1", { start: 5, end: 10 })
      expect(store.openedComment).toBe("comment-1")
      expect(store.selected).toEqual({ start: 5, end: 10 })

      // Simulate entering edit mode (calls reset)
      note.reset()

      expect(store.openedComment).toBeNull()
      expect(store.selected).toBeNull()
      expect(store.commenting).toBeNull()
      expect(note.draft()).toBe("")

      dispose()
    })
  })

  test("reset clears an active draft", () => {
    createRoot((dispose) => {
      const { note, store } = createTestCommentState()

      // Simulate opening a draft
      note.openDraft({ start: 1, end: 3 })
      note.setDraft("This is a draft comment")

      expect(store.commenting).toEqual({ start: 1, end: 3 })
      expect(note.draft()).toBe("This is a draft comment")

      // Simulate entering edit mode (calls reset)
      note.reset()

      expect(store.commenting).toBeNull()
      expect(note.draft()).toBe("")
      expect(store.openedComment).toBeNull()
      expect(store.selected).toBeNull()

      dispose()
    })
  })

  test("reset clears editing state (comment editor)", () => {
    createRoot((dispose) => {
      const { note, store } = createTestCommentState()

      // Simulate editing an existing comment
      note.openEditor("comment-2", { start: 15, end: 20 }, "existing comment text")
      expect(note.editing()).toBe("comment-2")
      expect(note.draft()).toBe("existing comment text")

      // Simulate entering edit mode (calls reset)
      note.reset()

      expect(note.editing()).toBeNull()
      expect(note.draft()).toBe("")
      expect(store.openedComment).toBeNull()
      expect(store.selected).toBeNull()
      expect(store.commenting).toBeNull()

      dispose()
    })
  })

  test("reset is idempotent (double call does not error)", () => {
    createRoot((dispose) => {
      const { note, store } = createTestCommentState()

      // Set up some state
      note.openComment("comment-1", { start: 1, end: 5 })
      note.setDraft("something")

      // First reset (enterEditMode)
      note.reset()
      // Second reset (exitEditMode) -- should not throw
      note.reset()

      expect(store.openedComment).toBeNull()
      expect(store.selected).toBeNull()
      expect(store.commenting).toBeNull()
      expect(note.draft()).toBe("")
      expect(note.editing()).toBeNull()

      dispose()
    })
  })

  test("after reset, comment state can be reopened fresh", () => {
    createRoot((dispose) => {
      const { note, store } = createTestCommentState()

      // Set up some state and reset (simulate edit mode round-trip)
      note.openDraft({ start: 10, end: 15 })
      note.setDraft("old draft")
      note.reset() // enterEditMode
      note.reset() // exitEditMode

      // Now simulate returning to comment mode and opening a new comment
      note.openComment("comment-new", { start: 20, end: 25 })

      expect(store.openedComment).toBe("comment-new")
      expect(store.selected).toEqual({ start: 20, end: 25 })
      expect(note.draft()).toBe("")

      dispose()
    })
  })

  test("reset clears selection that may reference stale line numbers", () => {
    createRoot((dispose) => {
      const { note, store } = createTestCommentState()

      // Simulate selecting lines in comment mode
      note.select({ start: 42, end: 50 })
      expect(store.selected).toEqual({ start: 42, end: 50 })

      // Simulate entering edit mode then editing and exiting
      note.reset() // enterEditMode clears state
      // (user edits code, changing line numbers)
      note.reset() // exitEditMode clears state again

      // Stale selection from line 42-50 should not persist
      expect(store.selected).toBeNull()

      dispose()
    })
  })
})

describe("mode transition guard for draft popover focus out", () => {
  test("editing signal prevents stale commenting state clear", () => {
    createRoot((dispose) => {
      const [editing, setEditing] = createSignal(false)
      const [store, setStore] = createStore({
        commenting: { start: 1, end: 5 } as SelectedLineRange | null,
      })

      // Simulate the onDraftPopoverFocusOut handler logic
      const simulateFocusOutHandler = () => {
        // This mirrors the guard added to the setTimeout callback:
        // if (editing()) return
        if (editing()) return
        setStore("commenting", null)
      }

      // When not editing, focus out should clear commenting
      simulateFocusOutHandler()
      expect(store.commenting).toBeNull()

      // Reset state
      setStore("commenting", { start: 1, end: 5 })

      // When editing (mode switched), focus out should NOT clear commenting
      setEditing(true)
      simulateFocusOutHandler()
      expect(store.commenting).toEqual({ start: 1, end: 5 })

      dispose()
    })
  })
})
