import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { LineComment } from "./comments"
import type { MappedLine } from "@/utils/line-mapping"

let createCommentSessionForTest: typeof import("./comments").createCommentSessionForTest

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
  const mod = await import("./comments")
  createCommentSessionForTest = mod.createCommentSessionForTest
})

function line(file: string, id: string, time: number): LineComment {
  return {
    id,
    file,
    comment: id,
    time,
    selection: { start: 1, end: 1 },
  }
}

describe("comments session indexing", () => {
  test("keeps file list behavior and aggregate chronological order", () => {
    createRoot((dispose) => {
      const now = Date.now()
      const comments = createCommentSessionForTest({
        "a.ts": [line("a.ts", "a-late", now + 20_000), line("a.ts", "a-early", now + 1_000)],
        "b.ts": [line("b.ts", "b-mid", now + 10_000)],
      })

      expect(comments.list("a.ts").map((item) => item.id)).toEqual(["a-late", "a-early"])
      expect(comments.all().map((item) => item.id)).toEqual(["a-early", "b-mid", "a-late"])

      const next = comments.add({
        file: "b.ts",
        comment: "next",
        selection: { start: 2, end: 2 },
      })

      expect(comments.list("b.ts").at(-1)?.id).toBe(next.id)
      expect(comments.all().map((item) => item.time)).toEqual(
        comments
          .all()
          .map((item) => item.time)
          .slice()
          .sort((a, b) => a - b),
      )

      dispose()
    })
  })

  test("remove updates file and aggregate indexes consistently", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [line("a.ts", "a1", 10), line("a.ts", "shared", 20)],
        "b.ts": [line("b.ts", "shared", 30)],
      })

      comments.setFocus({ file: "a.ts", id: "shared" })
      comments.setActive({ file: "a.ts", id: "shared" })
      comments.remove("a.ts", "shared")

      expect(comments.list("a.ts").map((item) => item.id)).toEqual(["a1"])
      expect(
        comments
          .all()
          .filter((item) => item.id === "shared")
          .map((item) => item.file),
      ).toEqual(["b.ts"])
      expect(comments.focus()).toBeNull()
      expect(comments.active()).toEqual({ file: "a.ts", id: "shared" })

      dispose()
    })
  })

  test("clear resets file and aggregate indexes plus focus state", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [line("a.ts", "a1", 10)],
      })

      const next = comments.add({
        file: "b.ts",
        comment: "next",
        selection: { start: 2, end: 2 },
      })

      comments.setActive({ file: "b.ts", id: next.id })
      comments.clear()

      expect(comments.list("a.ts")).toEqual([])
      expect(comments.list("b.ts")).toEqual([])
      expect(comments.all()).toEqual([])
      expect(comments.focus()).toBeNull()
      expect(comments.active()).toBeNull()

      dispose()
    })
  })

  test("remove keeps focus when same comment id exists in another file", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [line("a.ts", "shared", 10)],
        "b.ts": [line("b.ts", "shared", 20)],
      })

      comments.setFocus({ file: "b.ts", id: "shared" })
      comments.remove("a.ts", "shared")

      expect(comments.focus()).toEqual({ file: "b.ts", id: "shared" })
      expect(comments.list("a.ts")).toEqual([])
      expect(comments.list("b.ts").map((item) => item.id)).toEqual(["shared"])

      dispose()
    })
  })

  test("setFocus and setActive updater callbacks receive current state", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest()

      comments.setFocus({ file: "a.ts", id: "a1" })
      comments.setFocus((current) => {
        expect(current).toEqual({ file: "a.ts", id: "a1" })
        return { file: "b.ts", id: "b1" }
      })

      comments.setActive({ file: "c.ts", id: "c1" })
      comments.setActive((current) => {
        expect(current).toEqual({ file: "c.ts", id: "c1" })
        return null
      })

      expect(comments.focus()).toEqual({ file: "b.ts", id: "b1" })
      expect(comments.active()).toBeNull()

      dispose()
    })
  })

  test("update changes only the targeted comment body", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [line("a.ts", "a1", 10), line("a.ts", "a2", 20)],
      })

      comments.update("a.ts", "a2", "edited")

      expect(comments.list("a.ts").map((item) => item.comment)).toEqual(["a1", "edited"])

      dispose()
    })
  })

  test("replace swaps comment state and clears focus state", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [line("a.ts", "a1", 10)],
      })

      comments.setFocus({ file: "a.ts", id: "a1" })
      comments.setActive({ file: "a.ts", id: "a1" })
      comments.replace([line("b.ts", "b1", 30)])

      expect(comments.list("a.ts")).toEqual([])
      expect(comments.list("b.ts").map((item) => item.id)).toEqual(["b1"])
      expect(comments.focus()).toBeNull()
      expect(comments.active()).toBeNull()

      dispose()
    })
  })
})

function commentAt(file: string, id: string, start: number, end: number): LineComment {
  return {
    id,
    file,
    comment: `comment ${id}`,
    time: Date.now(),
    selection: { start, end },
  }
}

describe("updatePositions", () => {
  test("shifts comment positions when lines are inserted above", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [commentAt("a.ts", "c1", 5, 10)],
      })

      // Simulate 2 lines inserted above: all lines shift by +2
      const mapLine = (line: number): MappedLine => line + 2
      const result = comments.updatePositions("a.ts", mapLine)

      expect(result.updated).toEqual([{ id: "c1", selection: { start: 7, end: 12 } }])
      expect(result.deleted).toEqual([])

      const updated = comments.list("a.ts")
      expect(updated[0].selection.start).toBe(7)
      expect(updated[0].selection.end).toBe(12)

      dispose()
    })
  })

  test("removes comments when both endpoints are deleted", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [commentAt("a.ts", "c1", 3, 5), commentAt("a.ts", "c2", 10, 12)],
      })

      // Only delete lines 3-5, keep lines 10-12 shifted by -3
      const mapLine = (line: number): MappedLine => {
        if (line >= 3 && line <= 5) return null
        return line - 3
      }
      const result = comments.updatePositions("a.ts", mapLine)

      expect(result.deleted).toEqual(["c1"])
      expect(result.updated).toEqual([{ id: "c2", selection: { start: 7, end: 9 } }])

      const remaining = comments.list("a.ts")
      expect(remaining.length).toBe(1)
      expect(remaining[0].id).toBe("c2")

      dispose()
    })
  })

  test("returns empty result when no comments exist for file", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({})
      const result = comments.updatePositions("a.ts", (line) => line + 1)
      expect(result.updated).toEqual([])
      expect(result.deleted).toEqual([])
      dispose()
    })
  })

  test("does not modify comments in other files", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [commentAt("a.ts", "c1", 5, 10)],
        "b.ts": [commentAt("b.ts", "c2", 5, 10)],
      })

      const mapLine = (line: number): MappedLine => line + 3
      comments.updatePositions("a.ts", mapLine)

      // a.ts comments should be updated
      expect(comments.list("a.ts")[0].selection.start).toBe(8)
      // b.ts comments should be unchanged
      expect(comments.list("b.ts")[0].selection.start).toBe(5)

      dispose()
    })
  })

  test("clears focus and active when referenced comment is deleted", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [commentAt("a.ts", "c1", 3, 5)],
      })

      comments.setFocus({ file: "a.ts", id: "c1" })
      comments.setActive({ file: "a.ts", id: "c1" })

      const mapLine = (): MappedLine => null
      comments.updatePositions("a.ts", mapLine)

      expect(comments.focus()).toBeNull()
      expect(comments.active()).toBeNull()

      dispose()
    })
  })

  test("preserves focus and active when comment is updated but not deleted", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [commentAt("a.ts", "c1", 5, 10)],
      })

      comments.setFocus({ file: "a.ts", id: "c1" })
      comments.setActive({ file: "a.ts", id: "c1" })

      const mapLine = (line: number): MappedLine => line + 2
      comments.updatePositions("a.ts", mapLine)

      // Focus and active should still point to the comment
      expect(comments.focus()).toEqual({ file: "a.ts", id: "c1" })
      expect(comments.active()).toEqual({ file: "a.ts", id: "c1" })

      dispose()
    })
  })

  test("returns unchanged type when mapping is identity", () => {
    createRoot((dispose) => {
      const comments = createCommentSessionForTest({
        "a.ts": [commentAt("a.ts", "c1", 5, 10)],
      })

      const mapLine = (line: number): MappedLine => line
      const result = comments.updatePositions("a.ts", mapLine)

      expect(result.updated).toEqual([])
      expect(result.deleted).toEqual([])

      // Comment should remain unchanged
      expect(comments.list("a.ts")[0].selection.start).toBe(5)
      expect(comments.list("a.ts")[0].selection.end).toBe(10)

      dispose()
    })
  })
})
