import { Show, Match, Switch, createMemo, createEffect, on, untrack } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { Select } from "@opencode-ai/ui/select"
import { Mark } from "@opencode-ai/ui/logo"

import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { checksum } from "@opencode-ai/util/encode"
import { useLanguage } from "@/context/language"
import { useParams } from "@solidjs/router"
import { UserMessage } from "@opencode-ai/sdk/v2"
import { useSDK } from "@/context/sdk"
import { useComments } from "@/context/comments"
import { SessionHeader } from "@/components/session"
import { same } from "@/utils/same"
import { createOpenReviewFile } from "@/pages/session/helpers"
import { SessionReviewTab, type DiffStyle, type SessionReviewTabProps } from "@/pages/session/review-tab"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { SessionSidePanel } from "@/pages/session/session-side-panel"

export default function Page() {
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const language = useLanguage()
  const params = useParams()
  const sdk = useSDK()
  const comments = useComments()

  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const desktopReviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopFileTreeOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const desktopSidePanelOpen = createMemo(() => desktopReviewOpen() || desktopFileTreeOpen())

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  createEffect(() => {
    const active = tabs().active()
    if (!active) return

    const path = file.pathFromTab(active)
    if (path) file.load(path)
  })

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const sessionDiffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const workingDiffs = createMemo(() => sync.data.working_diff ?? [])
  const diffs = createMemo(() => (sessionDiffs().length > 0 ? sessionDiffs() : workingDiffs()))
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    [] as UserMessage[],
    { equals: same },
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    [] as UserMessage[],
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        if (msg.agent) local.agent.set(msg.agent)
        if (msg.model) local.model.set(msg.model)
      },
    ),
  )

  const [store, setStore] = createStore({
    changes: "working" as "working" | "session" | "turn",
  })

  const turnDiffs = createMemo(() => lastUserMessage()?.summary?.diffs ?? [])
  const reviewDiffs = createMemo(() => {
    if (store.changes === "working") return workingDiffs()
    if (store.changes === "turn") return turnDiffs()
    return sessionDiffs()
  })

  const diffsReady = createMemo(() => {
    if (store.changes === "working") return true
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })
  const reviewEmptyKey = createMemo(() => {
    const project = sync.project
    if (!project || project.vcs) return "session.review.empty"
    return "session.review.noVcs"
  })

  createEffect(
    on([() => sdk.directory, () => params.id] as const, ([, id]) => {
      if (!id) return
      untrack(() => {
        void sync.session.sync(id)
        void sync.session.todo(id)
      })
    }),
  )

  // Fetch working directory diffs on mount and when directory changes
  createEffect(
    on(
      () => sdk.directory,
      () => {
        void sync.workingDiff.fetch()
      },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("changes", "working")
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    const start = Math.max(1, Math.min(selection.startLine, selection.endLine))
    const end = Math.max(selection.startLine, selection.endLine)
    const lines = content.split("\n").slice(start - 1, end)
    if (lines.length === 0) return undefined
    return lines.slice(0, 2).join("\n")
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const openedTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => tab !== "context" && tab !== "review"),
  )

  const reviewTab = createMemo(() => isDesktop())

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({ reviewScroll: undefined, pendingDiff: undefined, activeDiff: undefined })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    loadFile: file.load,
  })

  const changesOptions = ["working", "session", "turn"] as const
  const changesOptionsList = [...changesOptions]

  const changesLabel = (option: (typeof changesOptions)[number]) => {
    if (option === "working") return language.t("ui.sessionReview.title.workingTree")
    if (option === "turn") return language.t("ui.sessionReview.title.lastTurn")
    return language.t("ui.sessionReview.title")
  }

  const changesTitle = () => (
    <Select
      options={changesOptionsList}
      current={store.changes}
      label={changesLabel}
      onSelect={(option) => option && setStore("changes", option)}
      variant="ghost"
      size="small"
      valueClass="text-14-medium"
    />
  )

  const emptyTurn = () => (
    <div class="h-full pb-30 flex flex-col items-center justify-center text-center gap-6">
      <Mark class="w-14 opacity-10" />
      <div class="text-14-regular text-text-weak max-w-56">{language.t("session.review.noChanges")}</div>
    </div>
  )

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Switch>
      <Match when={store.changes === "working" || (store.changes === "turn" && !!params.id)}>
        <SessionReviewTab
          title={changesTitle()}
          empty={emptyTurn()}
          diffs={reviewDiffs}
          view={view}
          diffStyle={input.diffStyle}
          onDiffStyleChange={input.onDiffStyleChange}
          onScrollRef={(el) => setTree("reviewScroll", el)}
          focusedFile={tree.activeDiff}
          onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
          onLineCommentUpdate={updateCommentInContext}
          onLineCommentDelete={removeCommentFromContext}
          lineCommentActions={reviewCommentActions()}
          comments={comments.all()}
          focusedComment={comments.focus()}
          onFocusedCommentChange={comments.setFocus}
          onViewFile={openReviewFile}
          classes={input.classes}
        />
      </Match>
      <Match when={hasReview()}>
        <Show
          when={diffsReady()}
          fallback={<div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>}
        >
          <SessionReviewTab
            title={changesTitle()}
            diffs={reviewDiffs}
            view={view}
            diffStyle={input.diffStyle}
            onDiffStyleChange={input.onDiffStyleChange}
            onScrollRef={(el) => setTree("reviewScroll", el)}
            focusedFile={tree.activeDiff}
            onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
            onLineCommentUpdate={updateCommentInContext}
            onLineCommentDelete={removeCommentFromContext}
            lineCommentActions={reviewCommentActions()}
            comments={comments.all()}
            focusedComment={comments.focus()}
            onFocusedCommentChange={comments.setFocus}
            onViewFile={openReviewFile}
            classes={input.classes}
          />
        </Show>
      </Match>
      <Match when={true}>
        <SessionReviewTab
          title={changesTitle()}
          empty={
            store.changes === "turn" ? (
              emptyTurn()
            ) : (
              <div class={input.emptyClass}>
                <Mark class="w-14 opacity-10" />
                <div class="text-14-regular text-text-weak max-w-56">{language.t(reviewEmptyKey())}</div>
              </div>
            )
          }
          diffs={reviewDiffs}
          view={view}
          diffStyle={input.diffStyle}
          onDiffStyleChange={input.onDiffStyleChange}
          onScrollRef={(el) => setTree("reviewScroll", el)}
          focusedFile={tree.activeDiff}
          onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
          onLineCommentUpdate={updateCommentInContext}
          onLineCommentDelete={removeCommentFromContext}
          lineCommentActions={reviewCommentActions()}
          comments={comments.all()}
          focusedComment={comments.focus()}
          onFocusedCommentChange={comments.setFocus}
          onViewFile={openReviewFile}
          classes={input.classes}
        />
      </Match>
    </Switch>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-30 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      () => tabs().active(),
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        if (!file.pathFromTab(active)) return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    openReviewPanel()
    const current = view().review.open() ?? []
    if (!current.includes(path)) view().review.setOpen([...current, path])
    setTree({ activeDiff: path, pendingDiff: path })
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!diffsReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  const activeTab = createMemo(() => {
    const active = tabs().active()
    if (active === "context") return "context"
    if (active === "review" && reviewTab()) return "review"
    if (active && file.pathFromTab(active)) return normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (reviewTab() && hasReview()) return "review"
    return "empty"
  })

  createEffect(() => {
    if (!layout.ready()) return
    if (tabs().active()) return
    if (openedTabs().length === 0 && !contextOpen() && !(reviewTab() && hasReview())) return

    const next = activeTab()
    if (next === "empty") return
    tabs().setActive(next)
  })

  createEffect(
    on(
      () => layout.fileTree.opened(),
      (opened, prev) => {
        if (prev === undefined) return
        if (!isDesktop()) return

        if (opened) {
          const active = tabs().active()
          const tab = active === "review" || (!active && hasReview()) ? "changes" : "all"
          layout.fileTree.setTab(tab)
        }
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const id = params.id

    const wants = isDesktop()
      ? desktopFileTreeOpen() || (desktopReviewOpen() && activeTab() === "review")
      : false
    if (!wants) return
    if (sync.status === "loading") return

    if (id && sync.data.session_diff[id] === undefined) {
      void sync.session.diff(id)
    }

    // Also fetch working diffs for the review panel
    if (sync.data.working_diff.length === 0) {
      void sync.workingDiff.fetch()
    }
  })

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk.directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        void file.tree.list("")

        const active = tabs().active()
        if (!active) return
        const path = file.pathFromTab(active)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  return (
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
      <SessionHeader />
      <div class="flex-1 min-h-0 flex">
        <SessionSidePanel reviewPanel={reviewPanel} activeDiff={tree.activeDiff} focusReviewDiff={focusReviewDiff} />
      </div>
      <TerminalPanel onSubmit={() => sync.workingDiff.schedule(2000)} />
    </div>
  )
}
