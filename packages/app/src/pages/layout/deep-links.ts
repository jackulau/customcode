export const deepLinkEvent = "opencode:deep-link"

export type DeepLink =
  | { type: "open-project"; directory: string }
  | { type: "notify"; title?: string; body?: string; directory?: string; session?: string }

export const parseDeepLink = (input: string): DeepLink | undefined => {
  if (!input.startsWith("opencode://")) return
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return
  const url = (() => {
    try {
      return new URL(input)
    } catch {
      return undefined
    }
  })()
  if (!url) return

  if (url.hostname === "open-project") {
    const directory = url.searchParams.get("directory")
    if (!directory) return
    return { type: "open-project", directory }
  }

  if (url.hostname === "notify") {
    return {
      type: "notify",
      title: url.searchParams.get("title") ?? undefined,
      body: url.searchParams.get("body") ?? undefined,
      directory: url.searchParams.get("directory") ?? undefined,
      session: url.searchParams.get("session") ?? undefined,
    }
  }

  return undefined
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls
    .map(parseDeepLink)
    .filter((link): link is DeepLink & { type: "open-project" } => link?.type === "open-project")
    .map((link) => link.directory)

export const collectNotifyDeepLinks = (urls: string[]) =>
  urls
    .map(parseDeepLink)
    .filter((link): link is DeepLink & { type: "notify" } => link?.type === "notify")

type OpenCodeWindow = Window & {
  __OPENCODE__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: OpenCodeWindow) => {
  const pending = target.__OPENCODE__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__OPENCODE__) target.__OPENCODE__.deepLinks = []
  return pending
}
