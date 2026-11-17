/*
The following file has the messages between the side panel and the content script on the page
- applying a widget, and splicing a page change into the one already showing
- taking a screenshot of the widget for the study records
- listening for changes to the page's questions, completion updates and widget errors
*/

import { extensionChrome, type RuntimeMessage } from '../../lib/extension'
import { cropScreenshot, type FrameRect } from '../../lib/screenshot'
import type { WidgetItem } from '../../lib/widget-items'
import type { PageChange, Widget } from './types'

const RETRY_DELAYS_MS = [400, 900, 1600]

/*
Sends a widget (or null to remove it) to the page, retrying while the content script loads
*/
export function pushWebpageInterface(widget: Widget | null, attempt = 0) {
  extensionChrome?.tabs?.query({ active: true, currentWindow: true }, tabs => {
    const tabId = tabs[0]?.id
    if (tabId === undefined) return
    extensionChrome.tabs?.sendMessage(tabId, { type: 'APPLY_WEBPAGE_INTERFACE', tree: widget }, () => {
      const lastError = extensionChrome.runtime?.lastError
      if (!lastError) return
      if (attempt < RETRY_DELAYS_MS.length) {
        window.setTimeout(() => pushWebpageInterface(widget, attempt + 1), RETRY_DELAYS_MS[attempt])
      } else {
        console.error(`Unable to apply the webpage interface after ${RETRY_DELAYS_MS.length} retries; the content script may not be loaded on this tab:`, lastError.message)
      }
    })
  })
}

/*
Sends a widget and resolves once the page reports whether it actually landed
*/
export const applyWidgetAndWait = (widget: Widget): Promise<boolean> => new Promise(resolve => {
  let done = false
  const finish = (ok: boolean) => {
    if (done) return
    done = true
    window.clearTimeout(timer)
    extensionChrome?.runtime?.onMessage?.removeListener(listener)
    resolve(ok)
  }
  const listener = (msg: RuntimeMessage) => { if (msg?.type === 'WEBPAGE_INTERFACE_APPLIED') finish(msg.ok !== false) }
  const timer = window.setTimeout(() => finish(false), 15000)
  extensionChrome?.runtime?.onMessage?.addListener(listener)
  pushWebpageInterface(widget)
})

/*
Splices added and removed questions into the widget on the page, without regenerating it
*/
export type ItemUpdate = { ok: boolean; added: number; removed: number }
export const updateWidgetItemsOnPage = (add: WidgetItem[], remove: string[]): Promise<ItemUpdate> => new Promise(resolve => {
  const failed: ItemUpdate = { ok: false, added: 0, removed: 0 }
  extensionChrome?.tabs?.query({ active: true, currentWindow: true }, tabs => {
    const tabId = tabs[0]?.id
    if (tabId === undefined) return resolve(failed)
    extensionChrome.tabs?.sendMessage(tabId, { type: 'UPDATE_WIDGET_ITEMS', add, remove }, (response?: unknown) => {
      resolve(extensionChrome.runtime?.lastError || !response ? failed : response as ItemUpdate)
    })
  })
})

/*
Listens for the page's messages: an item's completion flipping, and a change to the page's
questions. Returns the function that stops listening.
*/
export function listenToPage(handlers: {
  onCompletionChanged: () => void
  onPageChanged: (change: PageChange, structural: boolean, formControlsAdded: number) => void
  onWidgetError: (message: string) => void
}): () => void {
  const listener = (message: RuntimeMessage) => {
    if (message.type === 'WIDGET_STATE_CHANGED') return handlers.onCompletionChanged()
    if (message.type === 'WIDGET_ERROR') return handlers.onWidgetError(message.message ?? '')
    if (message.type !== 'PAGE_CHANGED' || !message.event) return
    const event = message.event
    const mutations = (event.payload?.mutations as Array<{ formControlsAdded?: number }> | undefined) || []
    handlers.onPageChanged({
      fieldsAdded: Number(event.fieldsAdded) || 0,
      added: event.addedFields ?? [],
      removed: event.removedFields ?? [],
      revealed: event.revealedFields ?? [],
      containers: event.addedContainers ?? [],
    }, event.structural === true, mutations.reduce((n, m) => n + (m.formControlsAdded || 0), 0))
  }
  extensionChrome?.runtime?.onMessage?.addListener(listener)
  return () => extensionChrome?.runtime?.onMessage?.removeListener(listener)
}

/*
A screenshot of just the widget on the active tab, cut out of a screenshot of the tab so nothing
else on the page is kept. Null when no widget is showing.
*/
export async function captureInterface(): Promise<string | null> {
  const tab = await new Promise<{ id?: number; windowId?: number } | undefined>(resolve =>
    extensionChrome?.tabs?.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0])))
  if (tab?.id === undefined || tab.windowId === undefined || !extensionChrome?.tabs?.captureVisibleTab) return null
  const rect = await new Promise<FrameRect | null>(resolve =>
    extensionChrome.tabs?.sendMessage(tab.id!, { type: 'GET_INTERFACE_RECT' }, (response?: unknown) => {
      void extensionChrome.runtime?.lastError
      resolve((response as FrameRect | null | undefined) ?? null)
    }))
  if (!rect) return null
  return cropScreenshot(await extensionChrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), rect)
}

/*
Pictures of every step of a widget that shows one step at a time, drawn inside its sandbox so the
user sees nothing change. Null when the widget has no steps.
*/
export async function captureInterfaceSteps(): Promise<string[] | null> {
  const tab = await new Promise<{ id?: number } | undefined>(resolve =>
    extensionChrome?.tabs?.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0])))
  if (tab?.id === undefined) return null
  const pictures = await new Promise<{ images?: unknown } | null>(resolve =>
    extensionChrome.tabs?.sendMessage(tab.id!, { type: 'CAPTURE_INTERFACE_STEPS' }, (response?: unknown) => {
      void extensionChrome.runtime?.lastError
      resolve((response as { images?: unknown } | null | undefined) ?? null)
    }))
  if (!Array.isArray(pictures?.images)) return null
  return pictures.images.filter((image): image is string => typeof image === 'string' && image.startsWith('data:image/png'))
}
