import { describe, expect, test } from "bun:test"
import { terminalWriter } from "./terminal-writer"

describe("terminalWriter", () => {
  test("buffers and flushes once per schedule", () => {
    const calls: string[] = []
    const scheduled: VoidFunction[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls.push(data)
        done?.()
      },
      (flush) => scheduled.push(flush),
    )

    writer.push("a")
    writer.push("b")
    writer.push("c")

    expect(calls).toEqual([])
    expect(scheduled).toHaveLength(1)

    scheduled[0]?.()
    expect(calls).toEqual(["abc"])
  })

  test("flush is a no-op when empty", () => {
    const calls: string[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls.push(data)
        done?.()
      },
      (flush) => flush(),
    )
    writer.flush()
    expect(calls).toEqual([])
  })

  test("flush waits for pending write completion", () => {
    const calls: string[] = []
    let done: VoidFunction | undefined
    const writer = terminalWriter(
      (data, finish) => {
        calls.push(data)
        done = finish
      },
      (flush) => flush(),
    )

    writer.push("a")

    let settled = false
    writer.flush(() => {
      settled = true
    })

    expect(calls).toEqual(["a"])
    expect(settled).toBe(false)

    done?.()
    expect(settled).toBe(true)
  })

  test("flush callback fires synchronously when no writes are pending", () => {
    const writer = terminalWriter(
      (data, done) => {
        done?.()
      },
      (flush) => flush(),
    )

    let callCount = 0
    writer.flush(() => {
      callCount++
    })
    expect(callCount).toBe(1)
  })

  test("multiple flush callbacks all fire after write completes", () => {
    let writeDone: VoidFunction | undefined
    const writer = terminalWriter(
      (_data, done) => {
        writeDone = done
      },
      (flush) => flush(),
    )

    writer.push("data")

    const settled: number[] = []
    writer.flush(() => settled.push(1))
    writer.flush(() => settled.push(2))

    expect(settled).toEqual([])

    writeDone?.()
    expect(settled).toEqual([1, 2])
  })

  test("finalized flag pattern prevents double execution", () => {
    // This simulates the terminal.tsx onCleanup pattern where both
    // output.flush(finalize) and setTimeout(finalize, 100) are called,
    // and only one should execute.
    let writeDone: VoidFunction | undefined
    const writer = terminalWriter(
      (_data, done) => {
        writeDone = done
      },
      (flush) => flush(),
    )

    writer.push("terminal content")

    let executions = 0
    let finalized = false
    const finalize = () => {
      if (finalized) return
      finalized = true
      executions++
    }

    writer.flush(finalize)

    // Simulate the setTimeout fallback calling finalize
    // before the flush callback fires
    finalize()
    expect(executions).toBe(1)
    expect(finalized).toBe(true)

    // Now the flush callback fires (writeDone)
    writeDone?.()
    // finalize was already called, so executions stays at 1
    expect(executions).toBe(1)
  })

  test("flush callback fires after write even when new data arrives during write", () => {
    const calls: string[] = []
    let writeDone: VoidFunction | undefined
    const scheduled: VoidFunction[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls.push(data)
        writeDone = done
      },
      (flush) => scheduled.push(flush),
    )

    writer.push("first")
    // Run the scheduled flush
    scheduled.shift()?.()
    expect(calls).toEqual(["first"])

    // While write is in progress, push more data and request flush
    writer.push("second")
    let settled = false
    writer.flush(() => {
      settled = true
    })

    // Complete the first write - should schedule another for "second"
    writeDone?.()
    expect(settled).toBe(false)

    // Run the next scheduled flush
    scheduled.shift()?.()
    expect(calls).toEqual(["first", "second"])

    // Complete the second write
    writeDone?.()
    expect(settled).toBe(true)
  })
})
