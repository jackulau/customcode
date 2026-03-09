import { describe, expect, test } from "bun:test"
import { buildLineMapping, reconcileSelection } from "./line-mapping"

describe("buildLineMapping", () => {
  test("identical content returns identity mapping", () => {
    const content = "line1\nline2\nline3"
    const map = buildLineMapping(content, content)
    expect(map(1)).toBe(1)
    expect(map(2)).toBe(2)
    expect(map(3)).toBe(3)
  })

  test("inserting lines at the top shifts all lines down", () => {
    const old = "a\nb\nc"
    const next = "x\ny\na\nb\nc"
    const map = buildLineMapping(old, next)
    expect(map(1)).toBe(3) // a -> line 3
    expect(map(2)).toBe(4) // b -> line 4
    expect(map(3)).toBe(5) // c -> line 5
  })

  test("inserting lines in the middle shifts subsequent lines", () => {
    const old = "a\nb\nc"
    const next = "a\nx\ny\nb\nc"
    const map = buildLineMapping(old, next)
    expect(map(1)).toBe(1) // a unchanged
    expect(map(2)).toBe(4) // b shifted to 4
    expect(map(3)).toBe(5) // c shifted to 5
  })

  test("deleting lines from the top shifts lines up", () => {
    const old = "x\ny\na\nb\nc"
    const next = "a\nb\nc"
    const map = buildLineMapping(old, next)
    expect(map(1)).toBe(null) // x deleted
    expect(map(2)).toBe(null) // y deleted
    expect(map(3)).toBe(1)    // a -> line 1
    expect(map(4)).toBe(2)    // b -> line 2
    expect(map(5)).toBe(3)    // c -> line 3
  })

  test("deleting lines in the middle shifts subsequent lines up", () => {
    const old = "a\nb\nc\nd\ne"
    const next = "a\nd\ne"
    const map = buildLineMapping(old, next)
    expect(map(1)).toBe(1)    // a unchanged
    expect(map(2)).toBe(null) // b deleted
    expect(map(3)).toBe(null) // c deleted
    expect(map(4)).toBe(2)    // d -> line 2
    expect(map(5)).toBe(3)    // e -> line 3
  })

  test("replacing lines returns null for deleted and shifts remainder", () => {
    const old = "a\nb\nc\nd"
    const next = "a\nx\ny\nz\nd"
    const map = buildLineMapping(old, next)
    expect(map(1)).toBe(1)    // a unchanged
    expect(map(2)).toBe(null) // b replaced
    expect(map(3)).toBe(null) // c replaced
    expect(map(4)).toBe(5)    // d -> line 5
  })

  test("appending lines does not affect existing line numbers", () => {
    const old = "a\nb"
    const next = "a\nb\nc\nd"
    const map = buildLineMapping(old, next)
    expect(map(1)).toBe(1) // a unchanged
    expect(map(2)).toBe(2) // b unchanged
  })

  test("removing lines from the end does not affect earlier lines", () => {
    const old = "a\nb\nc\nd"
    const next = "a\nb"
    const map = buildLineMapping(old, next)
    expect(map(1)).toBe(1)    // a unchanged
    expect(map(2)).toBe(2)    // b unchanged
    expect(map(3)).toBe(null) // c deleted
    expect(map(4)).toBe(null) // d deleted
  })

  test("empty old content", () => {
    const old = ""
    const next = "a\nb"
    const map = buildLineMapping(old, next)
    // The single empty line maps to null (deleted/replaced)
    expect(map(1)).toBe(null)
  })

  test("empty new content", () => {
    const old = "a\nb"
    const next = ""
    const map = buildLineMapping(old, next)
    expect(map(1)).toBe(null) // a deleted
    expect(map(2)).toBe(null) // b deleted
  })

  test("single line change", () => {
    const old = "a\nb\nc"
    const next = "a\nB\nc"
    const map = buildLineMapping(old, next)
    expect(map(1)).toBe(1)    // a unchanged
    expect(map(2)).toBe(null) // b changed to B -> deleted
    expect(map(3)).toBe(3)    // c unchanged
  })

  test("multiple disjoint edits", () => {
    const old = "a\nb\nc\nd\ne\nf"
    const next = "a\nX\nc\nd\nY\nZ\nf"
    const map = buildLineMapping(old, next)
    expect(map(1)).toBe(1)    // a unchanged
    expect(map(2)).toBe(null) // b -> X (replaced)
    expect(map(3)).toBe(3)    // c unchanged
    expect(map(4)).toBe(4)    // d unchanged
    expect(map(5)).toBe(null) // e -> Y,Z (replaced, line deleted)
    expect(map(6)).toBe(7)    // f -> line 7 (shifted by 1)
  })
})

describe("reconcileSelection", () => {
  test("unchanged mapping returns unchanged result", () => {
    const identity = (line: number) => line
    const result = reconcileSelection({ start: 5, end: 10 }, identity)
    expect(result.type).toBe("unchanged")
    if (result.type === "unchanged") {
      expect(result.selection.start).toBe(5)
      expect(result.selection.end).toBe(10)
    }
  })

  test("shifted lines return updated result", () => {
    // Simulate 2 lines inserted above: all lines shift by +2
    const map = (line: number) => line + 2
    const result = reconcileSelection({ start: 5, end: 10 }, map)
    expect(result.type).toBe("updated")
    if (result.type === "updated") {
      expect(result.selection.start).toBe(7)
      expect(result.selection.end).toBe(12)
    }
  })

  test("both endpoints deleted returns deleted result", () => {
    const map = () => null
    const result = reconcileSelection({ start: 5, end: 10 }, map)
    expect(result.type).toBe("deleted")
  })

  test("start deleted but end exists anchors to end position", () => {
    const map = (line: number) => (line === 5 ? null : line + 1)
    const result = reconcileSelection({ start: 5, end: 10 }, map)
    expect(result.type).toBe("updated")
    if (result.type === "updated") {
      expect(result.selection.start).toBe(11)
      expect(result.selection.end).toBe(11)
    }
  })

  test("end deleted but start exists anchors to start position", () => {
    const map = (line: number) => (line === 10 ? null : line + 1)
    const result = reconcileSelection({ start: 5, end: 10 }, map)
    expect(result.type).toBe("updated")
    if (result.type === "updated") {
      expect(result.selection.start).toBe(6)
      expect(result.selection.end).toBe(6)
    }
  })

  test("preserves reversed selection direction", () => {
    const map = (line: number) => line + 3
    const result = reconcileSelection({ start: 10, end: 5 }, map)
    expect(result.type).toBe("updated")
    if (result.type === "updated") {
      // Reversed: start > end, so after mapping start stays "higher"
      expect(result.selection.start).toBe(13)
      expect(result.selection.end).toBe(8)
    }
  })

  test("preserves side properties", () => {
    const map = (line: number) => line + 1
    const result = reconcileSelection(
      { start: 5, end: 10, side: "additions", endSide: "deletions" },
      map,
    )
    expect(result.type).toBe("updated")
    if (result.type === "updated") {
      expect(result.selection.side).toBe("additions")
      expect(result.selection.endSide).toBe("deletions")
    }
  })

  test("integration with buildLineMapping - lines inserted above comment", () => {
    const old = "a\nb\nc\nd\ne"
    const next = "x\ny\na\nb\nc\nd\ne"
    const map = buildLineMapping(old, next)
    const result = reconcileSelection({ start: 2, end: 4 }, map)
    expect(result.type).toBe("updated")
    if (result.type === "updated") {
      expect(result.selection.start).toBe(4) // b -> line 4
      expect(result.selection.end).toBe(6)   // d -> line 6
    }
  })

  test("integration with buildLineMapping - comment lines deleted", () => {
    const old = "a\nb\nc\nd\ne"
    const next = "a\ne"
    const map = buildLineMapping(old, next)
    const result = reconcileSelection({ start: 2, end: 4 }, map)
    // b, c, d all deleted
    expect(result.type).toBe("deleted")
  })

  test("integration with buildLineMapping - partial deletion anchors to surviving endpoint", () => {
    const old = "a\nb\nc\nd\ne"
    const next = "a\nc\nd\ne"
    const map = buildLineMapping(old, next)
    // Comment on lines 2-3 (b-c). b is deleted, c survives at line 2
    const result = reconcileSelection({ start: 2, end: 3 }, map)
    expect(result.type).toBe("updated")
    if (result.type === "updated") {
      expect(result.selection.start).toBe(2) // c is now at line 2
      expect(result.selection.end).toBe(2)   // anchored to the surviving line
    }
  })
})
