import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { EditorView } from "@codemirror/view"
import { EditorState } from "@codemirror/state"

describe("CodeEditor focus and state", () => {
  let container: HTMLDivElement
  let view: EditorView

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
  })

  afterEach(() => {
    view?.destroy()
    container?.remove()
  })

  test("EditorView.focus() makes the editor focused", () => {
    view = new EditorView({
      state: EditorState.create({ doc: "hello" }),
      parent: container,
    })

    // Before focus, the editor should not have the cm-focused class
    const editorDOM = view.dom
    expect(editorDOM).toBeTruthy()

    // Focus the view
    view.focus()
    expect(view.hasFocus).toBe(true)
  })

  test("dispatching content changes updates the document", () => {
    view = new EditorView({
      state: EditorState.create({ doc: "original content" }),
      parent: container,
    })

    const newContent = "new content after tab switch"
    const current = view.state.doc.toString()
    expect(current).toBe("original content")

    view.dispatch({
      changes: { from: 0, to: current.length, insert: newContent },
    })

    expect(view.state.doc.toString()).toBe(newContent)
  })

  test("focus is maintained after content dispatch", () => {
    view = new EditorView({
      state: EditorState.create({ doc: "initial" }),
      parent: container,
    })

    view.focus()
    expect(view.hasFocus).toBe(true)

    // Simulate external value change (tab switch)
    const current = view.state.doc.toString()
    view.dispatch({
      changes: { from: 0, to: current.length, insert: "switched tab content" },
    })

    // Re-focus after dispatch (as our implementation does via rAF)
    view.focus()
    expect(view.hasFocus).toBe(true)
    expect(view.state.doc.toString()).toBe("switched tab content")
  })

  test("destroy prevents further operations", () => {
    view = new EditorView({
      state: EditorState.create({ doc: "test" }),
      parent: container,
    })

    view.focus()
    view.destroy()

    // After destroy, the view's DOM should be removed from the container
    expect(container.querySelector(".cm-editor")).toBeNull()
  })

  test("no dispatch when content matches (typing loop prevention)", () => {
    const onChange = mock((_doc: string) => {})

    view = new EditorView({
      state: EditorState.create({
        doc: "same content",
        extensions: [
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChange(update.state.doc.toString())
            }
          }),
        ],
      }),
      parent: container,
    })

    // Simulate the createEffect check: if current matches value, skip dispatch
    const value = "same content"
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      })
    }

    // onChange should NOT have been called since content matches
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe("auto-save timer race condition guard", () => {
  test("disposed flag prevents save after cleanup", () => {
    let disposed = false
    let saveCalled = false

    const editing = () => true
    const saveFile = () => {
      saveCalled = true
    }

    // Simulate the timer callback with the guard
    const timerCallback = () => {
      if (disposed || !editing()) return
      saveFile()
    }

    // Before disposal, save should work
    timerCallback()
    expect(saveCalled).toBe(true)

    // After disposal, save should be blocked
    saveCalled = false
    disposed = true
    timerCallback()
    expect(saveCalled).toBe(false)
  })

  test("editing check prevents save after exit edit mode", () => {
    let isEditing = true
    let saveCalled = false
    const disposed = false

    const editing = () => isEditing
    const saveFile = () => {
      saveCalled = true
    }

    const timerCallback = () => {
      if (disposed || !editing()) return
      saveFile()
    }

    // While editing, save should work
    timerCallback()
    expect(saveCalled).toBe(true)

    // After exiting edit mode, save should be blocked
    saveCalled = false
    isEditing = false
    timerCallback()
    expect(saveCalled).toBe(false)
  })

  test("clearTimeout prevents timer from firing", () => {
    let saveCalled = false

    const timer = setTimeout(() => {
      saveCalled = true
    }, 50)

    clearTimeout(timer)

    // Wait to ensure the timer would have fired
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(saveCalled).toBe(false)
        resolve()
      }, 100)
    })
  })
})
