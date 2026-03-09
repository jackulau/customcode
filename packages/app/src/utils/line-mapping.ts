import type { SelectedLineRange } from "@/context/file"

/**
 * Result of mapping a single line number from old content to new content.
 * `null` indicates the line was deleted.
 */
export type MappedLine = number | null

/**
 * Represents a range of lines that changed between old and new content.
 * - `oldStart` / `oldCount`: lines removed from the old content
 * - `newStart` / `newCount`: lines inserted in the new content
 */
type Hunk = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

/**
 * Compute a minimal set of diff hunks between two arrays of lines using
 * a simple LCS-based approach. Returns hunks in order of appearance.
 */
function computeHunks(oldLines: string[], newLines: string[]): Hunk[] {
  const oldLen = oldLines.length
  const newLen = newLines.length

  // For very large files, fall back to a simpler linear scan
  // to avoid O(n*m) memory/time
  if (oldLen * newLen > 1_000_000) {
    return computeHunksLinear(oldLines, newLines)
  }

  // Standard LCS via DP table
  const dp: number[][] = Array.from({ length: oldLen + 1 }, () => new Array(newLen + 1).fill(0))

  for (let i = oldLen - 1; i >= 0; i--) {
    for (let j = newLen - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  // Walk the DP table to find matching regions and derive hunks
  const hunks: Hunk[] = []
  let oi = 0
  let ni = 0
  let oldStart = -1
  let oldCount = 0
  let newStart = -1
  let newCount = 0

  const flushHunk = () => {
    if (oldCount > 0 || newCount > 0) {
      hunks.push({ oldStart, oldCount, newStart, newCount })
      oldCount = 0
      newCount = 0
    }
  }

  while (oi < oldLen && ni < newLen) {
    if (oldLines[oi] === newLines[ni]) {
      flushHunk()
      oi++
      ni++
    } else if (dp[oi + 1][ni] >= dp[oi][ni + 1]) {
      // Delete from old
      if (oldCount === 0 && newCount === 0) {
        oldStart = oi
        newStart = ni
      }
      oldCount++
      oi++
    } else {
      // Insert in new
      if (oldCount === 0 && newCount === 0) {
        oldStart = oi
        newStart = ni
      }
      newCount++
      ni++
    }
  }

  // Remaining lines
  if (oi < oldLen || ni < newLen) {
    if (oldCount === 0 && newCount === 0) {
      oldStart = oi
      newStart = ni
    }
    oldCount += oldLen - oi
    newCount += newLen - ni
  }

  flushHunk()
  return hunks
}

/**
 * Simple linear hunk computation for large files.
 * Matches lines greedily from top and bottom, treats the middle as one big hunk.
 */
function computeHunksLinear(oldLines: string[], newLines: string[]): Hunk[] {
  const oldLen = oldLines.length
  const newLen = newLines.length

  // Match from the top
  let top = 0
  while (top < oldLen && top < newLen && oldLines[top] === newLines[top]) {
    top++
  }

  // Match from the bottom
  let bottom = 0
  while (
    bottom < oldLen - top &&
    bottom < newLen - top &&
    oldLines[oldLen - 1 - bottom] === newLines[newLen - 1 - bottom]
  ) {
    bottom++
  }

  const oldMiddle = oldLen - top - bottom
  const newMiddle = newLen - top - bottom

  if (oldMiddle === 0 && newMiddle === 0) return []

  return [
    {
      oldStart: top,
      oldCount: oldMiddle,
      newStart: top,
      newCount: newMiddle,
    },
  ]
}

/**
 * Build a line mapping function from old content to new content.
 * Returns a function that maps a 1-based old line number to a 1-based new line number,
 * or `null` if the line was deleted.
 */
export function buildLineMapping(oldContent: string, newContent: string): (oldLine: number) => MappedLine {
  if (oldContent === newContent) {
    return (line) => line
  }

  const oldLines = oldContent.split("\n")
  const newLines = newContent.split("\n")
  const hunks = computeHunks(oldLines, newLines)

  return (oldLine: number): MappedLine => {
    // Convert to 0-based index for hunk comparison
    const idx = oldLine - 1
    let offset = 0

    for (const hunk of hunks) {
      if (idx < hunk.oldStart) {
        // Line is before this hunk, apply accumulated offset
        return oldLine + offset
      }

      if (idx < hunk.oldStart + hunk.oldCount) {
        // Line falls within a deleted/replaced region
        return null
      }

      // Line is after this hunk, accumulate the offset
      offset += hunk.newCount - hunk.oldCount
    }

    // Line is after all hunks
    return oldLine + offset
  }
}

/**
 * Result of reconciling a comment's selection after an edit.
 */
export type ReconcileResult =
  | { type: "updated"; selection: SelectedLineRange }
  | { type: "deleted" }
  | { type: "unchanged"; selection: SelectedLineRange }

/**
 * Apply a line mapping to a comment's selection range.
 * Returns the reconciled result indicating whether the selection was updated,
 * deleted (all referenced lines removed), or unchanged.
 */
export function reconcileSelection(
  selection: SelectedLineRange,
  mapLine: (oldLine: number) => MappedLine,
): ReconcileResult {
  const startLine = Math.min(selection.start, selection.end)
  const endLine = Math.max(selection.start, selection.end)
  const reversed = selection.start > selection.end

  const newStart = mapLine(startLine)
  const newEnd = mapLine(endLine)

  // If both endpoints are deleted, the comment is invalidated
  if (newStart === null && newEnd === null) {
    return { type: "deleted" }
  }

  // If start is deleted but end is not, anchor to the end's position
  const resolvedStart = newStart ?? newEnd!
  // If end is deleted but start is not, anchor to the start's position
  const resolvedEnd = newEnd ?? newStart!

  // Check if anything actually changed
  if (resolvedStart === startLine && resolvedEnd === endLine) {
    return {
      type: "unchanged",
      selection: { ...selection },
    }
  }

  const next: SelectedLineRange = {
    start: reversed ? resolvedEnd : resolvedStart,
    end: reversed ? resolvedStart : resolvedEnd,
  }

  if (selection.side) next.side = selection.side
  if (selection.endSide) next.endSide = selection.endSide

  return { type: "updated", selection: next }
}
