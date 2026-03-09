import { createEffect, onCleanup, onMount, on } from "solid-js"
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands"
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from "@codemirror/language"
import { tags as t } from "@lezer/highlight"
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"

import { javascript } from "@codemirror/lang-javascript"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { json } from "@codemirror/lang-json"
import { python } from "@codemirror/lang-python"
import { markdown } from "@codemirror/lang-markdown"
import { xml } from "@codemirror/lang-xml"
import { rust } from "@codemirror/lang-rust"
import { cpp } from "@codemirror/lang-cpp"
import { java } from "@codemirror/lang-java"
import { sql } from "@codemirror/lang-sql"
import { go } from "@codemirror/lang-go"

const langMap: Record<string, () => ReturnType<typeof javascript>> = {
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  mjs: () => javascript(),
  mts: () => javascript({ typescript: true }),
  cjs: () => javascript(),
  cts: () => javascript({ typescript: true }),
  css: () => css(),
  html: () => html(),
  htm: () => html(),
  svelte: () => html(),
  vue: () => html(),
  json: () => json(),
  jsonc: () => json(),
  py: () => python(),
  pyw: () => python(),
  md: () => markdown(),
  mdx: () => markdown(),
  xml: () => xml(),
  svg: () => xml(),
  rs: () => rust(),
  c: () => cpp(),
  h: () => cpp(),
  cpp: () => cpp(),
  cc: () => cpp(),
  cxx: () => cpp(),
  hpp: () => cpp(),
  hxx: () => cpp(),
  java: () => java(),
  sql: () => sql(),
  go: () => go(),
}

function getLang(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase()
  if (!ext) return undefined
  return langMap[ext]?.()
}

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "var(--background-stronger)",
    color: "var(--text-strong)",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    padding: "8px 0",
    caretColor: "var(--text-strong)",
  },
  ".cm-gutters": {
    border: "none",
    backgroundColor: "transparent",
    color: "var(--text-weak)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--text-base)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--surface-base)",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--text-strong)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--surface-base-active) !important",
  },
  ".cm-scroller": {
    overflow: "auto",
  },
  ".cm-matchingBracket": {
    backgroundColor: "var(--surface-base-hover)",
    outline: "none",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--surface-base-active)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--surface-base)",
    border: "none",
    color: "var(--text-weak)",
  },
})

const syntaxTheme = HighlightStyle.define([
  { tag: t.comment, color: "var(--syntax-comment)" },
  { tag: t.lineComment, color: "var(--syntax-comment)" },
  { tag: t.blockComment, color: "var(--syntax-comment)" },
  { tag: t.docComment, color: "var(--syntax-comment)" },
  { tag: t.string, color: "var(--syntax-string)" },
  { tag: t.special(t.string), color: "var(--syntax-string)" },
  { tag: t.regexp, color: "var(--syntax-regexp)" },
  { tag: t.keyword, color: "var(--syntax-keyword)" },
  { tag: t.controlKeyword, color: "var(--syntax-keyword)" },
  { tag: t.operatorKeyword, color: "var(--syntax-keyword)" },
  { tag: t.definitionKeyword, color: "var(--syntax-keyword)" },
  { tag: t.moduleKeyword, color: "var(--syntax-keyword)" },
  { tag: t.operator, color: "var(--syntax-operator)" },
  { tag: t.punctuation, color: "var(--syntax-punctuation)" },
  { tag: t.separator, color: "var(--syntax-punctuation)" },
  { tag: t.bracket, color: "var(--syntax-punctuation)" },
  { tag: t.variableName, color: "var(--syntax-variable)" },
  { tag: t.definition(t.variableName), color: "var(--syntax-variable)" },
  { tag: t.propertyName, color: "var(--syntax-property)" },
  { tag: t.definition(t.propertyName), color: "var(--syntax-property)" },
  { tag: t.typeName, color: "var(--syntax-type)" },
  { tag: t.className, color: "var(--syntax-type)" },
  { tag: t.namespace, color: "var(--syntax-type)" },
  { tag: t.number, color: "var(--syntax-primitive)" },
  { tag: t.integer, color: "var(--syntax-primitive)" },
  { tag: t.float, color: "var(--syntax-primitive)" },
  { tag: t.bool, color: "var(--syntax-primitive)" },
  { tag: t.null, color: "var(--syntax-primitive)" },
  { tag: t.atom, color: "var(--syntax-constant)" },
  { tag: t.constant(t.variableName), color: "var(--syntax-constant)" },
  { tag: t.tagName, color: "var(--syntax-property)" },
  { tag: t.attributeName, color: "var(--syntax-variable)" },
  { tag: t.attributeValue, color: "var(--syntax-string)" },
  { tag: t.function(t.variableName), color: "var(--syntax-variable)" },
  { tag: t.function(t.propertyName), color: "var(--syntax-property)" },
  { tag: t.meta, color: "var(--syntax-comment)" },
  { tag: t.invalid, color: "var(--syntax-critical)" },
])

export function CodeEditor(props: {
  value: string
  filename: string
  onChange: (value: string) => void
  onSave?: () => void
  class?: string
}) {
  let container!: HTMLDivElement
  let view: EditorView | undefined

  const buildExtensions = () => {
    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      foldGutter(),
      editorTheme,
      syntaxHighlighting(syntaxTheme),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...closeBracketsKeymap,
        ...foldKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          props.onChange(update.state.doc.toString())
        }
      }),
    ]

    if (props.onSave) {
      const save = props.onSave
      extensions.push(
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              save()
              return true
            },
          },
        ]),
      )
    }

    const lang = getLang(props.filename)
    if (lang) {
      extensions.push(lang)
    }

    return extensions
  }

  onMount(() => {
    view = new EditorView({
      state: EditorState.create({
        doc: props.value,
        extensions: buildExtensions(),
      }),
      parent: container,
    })
    // Auto-focus so the cursor is immediately visible and blinking
    // Use requestAnimationFrame to ensure the DOM is fully laid out
    requestAnimationFrame(() => {
      view?.focus()
    })
  })

  createEffect(
    on(
      () => props.value,
      (value) => {
        if (!view) return
        const current = view.state.doc.toString()
        if (current !== value) {
          // External value change (e.g., tab switch) — update content and re-focus
          view.dispatch({
            changes: { from: 0, to: current.length, insert: value },
          })
          // Re-focus after external content swap so the cursor stays active
          requestAnimationFrame(() => {
            view?.focus()
          })
        }
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    view?.destroy()
  })

  return <div ref={container} class={props.class} />
}
