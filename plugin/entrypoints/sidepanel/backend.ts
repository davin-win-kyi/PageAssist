/*
The following file has the calls from the side panel to the backend
- a call that fails throws an error with the backend's own message, such as a failed model
  call, so the panel can show it to the user
- the study records: screenshots of the interfaces, errors and events
*/

import { API_URL, ANALYZE_TIMEOUT_MS, LLM_CALL_TIMEOUT_MS, fetchWithTimeout } from '../../lib/api'
import type { PageContainer, PageElement, PageElementsResponse } from '../../lib/extension'
import type { WidgetItem } from '../../lib/widget-items'
import type { ChatResponse, InterfaceRepresentationResponse, SavedInterface, TaskNode, Widget } from './types'

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const site = (id: string) => encodeURIComponent(id)

/*
Sends a request and returns its JSON. A non-OK response throws with the backend's `detail`.
*/
async function request<T>(path: string, init: RequestInit = {}, timeoutMs = LLM_CALL_TIMEOUT_MS): Promise<T> {
  const response = await fetchWithTimeout(`${API_URL}${path}`, init, timeoutMs)
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    const detail = typeof body?.detail === 'string' ? body.detail : `${response.status} ${response.statusText}`
    throw new Error(detail)
  }
  return response.json() as Promise<T>
}

// The message to show for a failed call
export const errorText = (error: unknown): string =>
  error instanceof Error ? (error.name === 'AbortError' ? 'the request timed out' : error.message) : String(error)

/*************************************************************************************************
Task representation
*************************************************************************************************/

export const analyzePage = (id: string, page: PageElementsResponse | undefined) =>
  request<TaskNode>(`/task-representations/${site(id)}/analyze`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...page, page_text: page?.pageText ?? '' }),
  }, ANALYZE_TIMEOUT_MS)

export type PatchResponse = TaskNode & { changed?: boolean; added_items?: WidgetItem[] }
export const patchPage = (id: string, added: PageElement[], removed: string[], revealed: PageElement[][], containers: PageContainer[]) =>
  request<PatchResponse>(`/task-representations/${site(id)}/patch`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ added, removed, revealed, containers }),
  })

/*************************************************************************************************
Widget and chat
*************************************************************************************************/

// `reason` says why the widget is built, for the study records
export const generateWidget = (id: string, reason: 'chat' | 'saved' | 'page-change') =>
  request<Widget>(`/webpage-interfaces/${site(id)}/generate?reason=${reason}`, { method: 'POST' }, ANALYZE_TIMEOUT_MS)

export const sendChat = (message: string, history: { role: string; content: string }[]) =>
  request<ChatResponse>('/chat', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ message, history }) })

/*************************************************************************************************
Interface representations: the working tree and the saved ones
*************************************************************************************************/

export const resetInterface = () => request<InterfaceRepresentationResponse>('/interface-representation/reset', { method: 'POST' })

export const listSaved = () => request<SavedInterface[]>('/interface-representations')

// `recordId` is the interface showing when it's saved, which the study records file the save with
export const saveCurrent = (name: string, recordId: string | null) =>
  request<SavedInterface>('/interface-representations', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name, record_id: recordId }) })

export const updateSaved = (id: string, recordId: string | null) =>
  request<SavedInterface>(`/interface-representations/${site(id)}/update`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ record_id: recordId }) })

export const deleteSaved = (id: string) => request<{ ok: boolean }>(`/interface-representations/${site(id)}`, { method: 'DELETE' })

export const activateSaved = (id: string) =>
  request<InterfaceRepresentationResponse>(`/interface-representations/${site(id)}/activate`, { method: 'POST' })

/*************************************************************************************************
Study records, kept for each session in user_study/ at the top of the repo
*************************************************************************************************/

// Saving to the records never interrupts the user, so a failure is only logged. It can be awaited
// when the next step depends on it being filed first.
const quietly = (call: Promise<unknown>): Promise<void> =>
  call.then(() => undefined, (error) => console.warn('PageAssist: could not save to the records', error))

// "final" is the interface as it was last seen, replaced each time
export const recordScreenshot = (recordId: string, reason: 'applied' | 'updated' | 'saved' | 'final', image: string) =>
  quietly(request('/records/screenshots', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ record_id: recordId, reason, image }) }))

export const recordError = (where: string, message: string, source: 'panel' | 'widget' = 'panel') =>
  quietly(request('/records/errors', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ source, where, message }) }))

export const recordEvent = (kind: string, details: Record<string, unknown>) =>
  quietly(request('/records/events', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ kind, details }) }))
