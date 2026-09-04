// Chrome extension plumbing for the side panel: the narrow slice of the `chrome.*` API the panel
// actually uses, and the one-shot request that asks the active tab's content script for its page
// elements.

export type PageElement = { id: string; selector: string; tag: string; text: string; role?: string; accessibleName?: string; visible?: boolean }
export type PageElementsResponse = { url: string; title: string; elements: PageElement[]; pageText?: string; frames?: { sameOrigin: number; crossOrigin: number } }
export type RuntimeMessage = {
  type?: string
  ok?: boolean
  event?: {
    type: string; url: string; structural?: boolean
    fieldsAdded?: number; fieldsRemoved?: number
    addedFields?: PageElement[]; removedFields?: string[]
    target?: Record<string, unknown>; payload?: Record<string, unknown>
  }
}

type TabInfo = { id?: number; active?: boolean }
export type TabUpdatedListener = (tabId: number, changeInfo: { status?: string; url?: string }, tab: TabInfo) => void
export type TabActivatedListener = (activeInfo: { tabId: number }) => void
type WebNavDetails = { tabId: number; frameId: number; url: string }
export type WebNavListener = (details: WebNavDetails) => void

export type ExtensionChrome = {
  tabs?: {
    query: (options: object, callback: (tabs: TabInfo[]) => void) => void
    sendMessage: (tabId: number, message: object, callback?: (response?: PageElementsResponse) => void) => void
    onUpdated?: { addListener: (listener: TabUpdatedListener) => void; removeListener: (listener: TabUpdatedListener) => void }
    onActivated?: { addListener: (listener: TabActivatedListener) => void; removeListener: (listener: TabActivatedListener) => void }
  }
  runtime?: {
    onMessage?: { addListener: (listener: (message: RuntimeMessage) => void) => void; removeListener: (listener: (message: RuntimeMessage) => void) => void }
    lastError?: { message?: string }
  }
  webNavigation?: {
    // Fires for single-page apps that change the URL via history.pushState/replaceState — a normal
    // full navigation does NOT trigger this (that's tabs.onUpdated's job instead).
    onHistoryStateUpdated?: { addListener: (listener: WebNavListener) => void; removeListener: (listener: WebNavListener) => void }
  }
  storage?: {
    local?: {
      get: (keys: string | string[] | null, callback: (items: Record<string, unknown>) => void) => void
      set: (items: object, callback?: () => void) => void
    }
  }
  scripting?: {
    executeScript: (injection: { target: { tabId: number }; files: string[] }) => Promise<unknown[]>
  }
}

export const extensionChrome = (globalThis as typeof globalThis & { chrome?: ExtensionChrome }).chrome

const activeTabId = (): Promise<number | undefined> => new Promise(resolve => {
  if (!extensionChrome?.tabs) { resolve(undefined); return }
  extensionChrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0]?.id))
})

const sendGetPageElements = (tabId: number, timeoutMs: number): Promise<PageElementsResponse | undefined> => new Promise(resolve => {
  const timeout = window.setTimeout(() => resolve(undefined), timeoutMs)
  extensionChrome?.tabs?.sendMessage(tabId, { type: 'GET_PAGE_ELEMENTS' }, response => {
    void extensionChrome?.runtime?.lastError // acknowledge to avoid an unchecked-error console warning
    window.clearTimeout(timeout)
    resolve(response)
  })
})

// Chrome only auto-injects a declared content script into pages that load AFTER the extension is
// installed/reloaded — so a tab that was already open when you (re)loaded the extension has no content
// script and can't be read until it's refreshed. Force-inject into the active tab; the script guards
// against running twice (see content.ts). No-op if `scripting` isn't available.
async function ensureContentScriptInjected(tabId: number): Promise<void> {
  try {
    await extensionChrome?.scripting?.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] })
  } catch {
    // Restricted URL (chrome://, the Web Store, a PDF viewer, …) — nothing to inject into.
  }
}

export async function requestPageElements(): Promise<PageElementsResponse | undefined> {
  const tabId = await activeTabId()
  if (tabId === undefined) return undefined
  const first = await sendGetPageElements(tabId, 6000)
  if (first) return first
  // No answer — the content script probably isn't there yet. Inject it, give it a moment, try once more.
  await ensureContentScriptInjected(tabId)
  await new Promise(r => window.setTimeout(r, 400))
  return sendGetPageElements(tabId, 6000)
}
