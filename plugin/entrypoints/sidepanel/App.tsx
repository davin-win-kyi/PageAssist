import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Send, Sparkles } from 'lucide-react'
import { API_URL, ANALYZE_TIMEOUT_MS, LLM_CALL_TIMEOUT_MS, fetchWithTimeout } from '../../lib/api'
import {
  extensionChrome,
  requestPageElements,
  type PageElement as TaskElement,
  type RuntimeMessage,
  type TabUpdatedListener,
  type TabActivatedListener,
  type WebNavListener,
} from '../../lib/extension'

type InterfaceNode = {
  component: string
  // One plain sentence on what the support is and does — the human-readable "what/why", distinct from
  // the short `component` slug. Root node only. Falls back to as a save name for user-authored concepts.
  description?: string
  style: Record<string, string>
  // Page-agnostic phrases describing what this node shows / how it behaves. (Was `content`.)
  preferences: Record<string, string> | string[]
  // Grounds a node in a real page element for the model's own reference; never displayed as text.
  selector?: string
  children: InterfaceNode[]
}
type InterfaceRepresentationResponse = { tree: InterfaceNode; agreed: boolean }
// The concrete, page-grounded result of combining preferences + a task representation — model-generated
// CODE now, not a declarative tree the panel/content script interpret. "style" is host-applied position/
// size for the outer frame only; "code" runs inside the sandboxed widget iframe (see entrypoints/sandbox);
// "state" is what that code's render(state) receives, and what the content script keeps live afterward.
type WidgetItem = { selector: string; label?: string; complete?: boolean }
type WidgetState = { items?: WidgetItem[]; [key: string]: unknown }
type Widget = { style: Record<string, string>; code: string; state: WidgetState }
type Importance = 'primary' | 'supporting' | 'peripheral'
// Two-tier semantic model of the current page (see backend/task/representation.py). `tasks` are coarse
// goals; `components` carry per-question granularity — each form field is its own component.
type TaskItem = {
  task_id: string
  label: string
  description?: string
  task_type: string
  parent_task_id?: string | null
  component_ids?: string[]
  importance?: Importance
}
type TaskComponent = {
  component_id: string
  semantic_role: string
  label?: string
  description?: string
  dom_selector: string
  member_selectors?: string[]
  associated_task_ids?: string[]
  required_for_task?: 'true' | 'false' | 'unknown'
  importance?: Importance
}
type TaskNode = {
  page_purpose?: string
  page_type?: string
  tasks?: TaskItem[]
  components?: TaskComponent[]
  modeling_notes?: string
}
type ChatEntry = { id: string; role: 'user' | 'assistant'; text: string; suggestions?: string[]; offerSave?: boolean; suggestedName?: string }
type ChatResponse = {
  reply: string
  suggestions: string[]
  interface_representation: InterfaceNode
  agreed: boolean
  offer_save?: boolean
  suggested_name?: string
}
type SavedInterface = { id: string; name: string }

// The intro is a plain prompt with no quick-reply chips. (Per-turn `suggestions` from /chat still
// render.)
const INTRO = {
  text: 'I can help create interface support for this webpage. Describe something that’s difficult about the current task, or describe a support you already have in mind — I may ask you to confirm how I’ve understood it.',
}

// A stable accent (emoji + hue) per saved entry, derived from its id — so a long Saved list is
// scannable at a glance. Keyed on the id, not the name, so renaming doesn't reshuffle the colours.
const SAVED_EMOJIS = ['📋', '🎯', '🧭', '📝', '🗂️', '🔖', '⭐', '🧩', '📌', '🧾', '📊', '🏷️', '🪧', '🧠', '🕹️', '🎛️', '📎', '🗒️', '🚦', '🧵']
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
function savedAccent(id: string): { emoji: string; hue: number } {
  const h = hashString(id)
  return { emoji: SAVED_EMOJIS[h % SAVED_EMOJIS.length] ?? '📋', hue: h % 360 }
}

// Is there an actual concept in this tree yet (vs. the blank default)? Gate on this before generating
// an on-page widget, so an "agreed" flag set too early can't produce an empty one.
function treeHasContent(tree?: InterfaceNode): boolean {
  if (!tree) return false
  const prefs = tree.preferences
  const prefCount = Array.isArray(prefs) ? prefs.length : Object.keys(prefs || {}).length
  return !!tree.component?.trim() || !!tree.description?.trim() || prefCount > 0 || (tree.children?.length ?? 0) > 0
}

function App() {
  const [siteId, setSiteId] = useState('')
  const [pageTitle, setPageTitle] = useState<string | undefined>(undefined)
  const [taskRepresentation, setTaskRepresentation] = useState<TaskNode | undefined>(undefined)
  const [message, setMessage] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  // The generate-and-apply-to-page step. 'applying' = user just agreed/activated; 'syncing' = a page
  // change was detected and the support is catching up; 'done'/'failed' = a brief result line.
  const [applyPhase, setApplyPhase] = useState<'idle' | 'applying' | 'syncing' | 'done' | 'failed'>('idle')
  const [applyResultText, setApplyResultText] = useState('')
  const applyResetRef = useRef<number | undefined>(undefined)
  const applyPhaseRef = useRef<'idle' | 'applying' | 'syncing' | 'done' | 'failed'>('idle')
  const busy = isThinking || applyPhase === 'applying'
  // A live completion flag on the on-page widget just flipped (a field got filled / a choice made).
  const [liveUpdate, setLiveUpdate] = useState(false)
  const liveUpdateAtRef = useRef(0)
  const liveUpdateTimerRef = useRef<number | undefined>(undefined)
  const syncingRef = useRef(false)
  const structuralCooldownRef = useRef(0) // ms — min gap between structural re-analyze+regenerate runs
  // The content script can't read this page → nothing can be analyzed or applied. Gate the chat.
  const [pageUnavailable, setPageUnavailable] = useState(false)
  // Show a result line for a beat, then go quiet.
  const finishApply = (ok: boolean, doneText = '✓ Support applied to the page.') => {
    setApplyResultText(ok ? doneText : 'Couldn’t apply it to the page — reload the tab and try again.')
    setApplyPhase(ok ? 'done' : 'failed')
    window.clearTimeout(applyResetRef.current)
    applyResetRef.current = window.setTimeout(() => setApplyPhase('idle'), 3500)
  }
  const [synced, setSynced] = useState(true)
  const [agreed, setAgreed] = useState(false)
  const [transcript, setTranscript] = useState<ChatEntry[]>([{ id: 'intro', role: 'assistant', text: INTRO.text }])
  const [ready, setReady] = useState(false)
  const [activeTab, setActiveTab] = useState<'chat' | 'saved'>('chat')
  const [savedRepresentations, setSavedRepresentations] = useState<SavedInterface[]>([])
  const [savedSearch, setSavedSearch] = useState('')
  const [saveNameDraft, setSaveNameDraft] = useState('')
  const [savingCurrent, setSavingCurrent] = useState(false)

  // Which saved entry the working tree came from (via activate), so the save affordance can offer
  // "update that one" vs "save as new". Empty when the tree was built fresh in chat.
  const [activeSourceId, setActiveSourceId] = useState('')
  const [activeSourceName, setActiveSourceName] = useState('')
  // The working tree's root `component` (e.g. "checklist") and `description` — used to derive a
  // readable default save name (description wins for user-authored concepts with no obvious slug).
  const [interfaceComponent, setInterfaceComponent] = useState('')
  const [interfaceDescription, setInterfaceDescription] = useState('')

  const logRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const siteIdRef = useRef('')
  const agreedRef = useRef(false)
  // The site_id that currently has a widget on the page (set by pushWebpageInterface). A widget is
  // only ever auto-refreshed on the page it's actually showing on — never carried to a new page.
  const widgetSiteIdRef = useRef('')
  // JSON of the interface-representation tree the on-page widget was last generated from. Guards
  // against re-triggering "applying…" when a chat turn resends a tree unchanged (a "looks good" /
  // save confirmation) instead of an actual edit — belt-and-suspenders alongside the prompt telling
  // the model to send `interface_representation: null` on a turn that doesn't change it.
  const appliedTreeJsonRef = useRef('')
  const taskRepresentationRef = useRef<TaskNode | undefined>(undefined)
  const lastAnalyzeAtRef = useRef(0)  // ms — rate-limits the "form just hydrated" re-analyze
  // A structural page change was seen since the last successful analyze → the stored task
  // representation is stale. Anything about to generate a widget must re-analyze first.
  const staleTaskRepRef = useRef(false)

  // use effect when the agreed state changes
  useEffect(() => { agreedRef.current = agreed }, [agreed])
  useEffect(() => { taskRepresentationRef.current = taskRepresentation }, [taskRepresentation])
  useEffect(() => { applyPhaseRef.current = applyPhase }, [applyPhase])

  // The content script can take a variable amount of time to finish injecting/registering its
  // listener right after a page loads — confirmed live that a single 500ms retry still isn't always
  // enough. Retries with backoff a few times before actually giving up.
  const RETRY_DELAYS_MS = [400, 900, 1600]
  const pushWebpageInterface = (widget: Widget | null, attempt = 0) => {
    if (attempt === 0) widgetSiteIdRef.current = widget ? siteIdRef.current : ''
    extensionChrome?.tabs?.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id
      if (tabId === undefined) return
      extensionChrome.tabs?.sendMessage(tabId, { type: 'APPLY_WEBPAGE_INTERFACE', tree: widget }, () => {
        const lastError = extensionChrome.runtime?.lastError
        if (!lastError) return
        if (attempt < RETRY_DELAYS_MS.length) {
          window.setTimeout(() => pushWebpageInterface(widget, attempt + 1), RETRY_DELAYS_MS[attempt])
        } else {
          console.error(`Unable to apply the webpage interface after ${RETRY_DELAYS_MS.length} retries — the content script may not be loaded on this tab (try reloading it):`, lastError.message)
        }
      })
    })
  }

  // Push a widget and resolve with whether the content script confirmed it's actually on the page
  // (false on a WEBPAGE_INTERFACE_APPLIED{ok:false} or a 15s safety timeout). Lets the indicator track
  // reality, not just the /generate call.
  const applyWidgetAndWait = (widget: Widget): Promise<boolean> => new Promise(resolve => {
    let done = false
    const finish = (ok: boolean) => { if (done) return; done = true; window.clearTimeout(timer); extensionChrome?.runtime?.onMessage?.removeListener(listener); resolve(ok) }
    const listener = (msg: RuntimeMessage) => { if (msg?.type === 'WEBPAGE_INTERFACE_APPLIED') finish(msg.ok !== false) }
    const timer = window.setTimeout(() => finish(false), 15000)
    extensionChrome?.runtime?.onMessage?.addListener(listener)
    pushWebpageInterface(widget)
  })

  // `degraded` = the backend's model call failed and it returned the deterministic fallback widget;
  // the panel says so plainly rather than pretending it's a normal result.
  const generateWebpageInterface = async (id: string): Promise<{ applied: boolean; degraded: boolean }> => {
    try {
      const response = await fetchWithTimeout(`${API_URL}/webpage-interfaces/${encodeURIComponent(id)}/generate`, { method: 'POST' }, ANALYZE_TIMEOUT_MS)
      if (!response.ok) throw new Error(`Generate failed: ${response.status}`)
      const widget: Widget & { degraded?: boolean } = await response.json()
      return { applied: await applyWidgetAndWait(widget), degraded: widget.degraded === true }
    } catch (error) {
      console.error('Unable to generate webpage interface', error)
      return { applied: false, degraded: false }
    }
  }
  const DEGRADED_TEXT = '⚠ Couldn’t generate the full support — showing a basic field list.'

  const refreshSavedList = async (): Promise<SavedInterface[]> => {
    try {
      const response = await fetch(`${API_URL}/interface-representations`)
      if (!response.ok) throw new Error(`List failed: ${response.status}`)
      const items: SavedInterface[] = await response.json()
      setSavedRepresentations(items)
      return items
    } catch (error) {
      console.error('Unable to load saved interface representations', error)
      return []
    }
  }

  // Grabs the current active tab's page elements, and — only if it's a genuinely different site than
  // last time (or `force`, for the very first call) — re-analyzes it into a fresh task representation.
  // Always re-analyzes rather than loading any previously stored one, since the page may have changed.
  // `onChangeDetected` fires as soon as a real change is confirmed, before the slow analyze call, so a
  // caller can show a loading state for the actual duration of the wait rather than just its tail end.
  const INPUTISH_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'spinbutton'])
  const countInputish = (elements?: TaskElement[]) =>
    (elements || []).filter(e => ['input', 'textarea', 'select'].includes(e.tag) || (e.role && INPUTISH_ROLES.has(e.role))).length

  const analyzeCurrentSite = async (force = false, onChangeDetected?: () => void): Promise<{ id: string; hasPage: boolean; changed: boolean; task?: TaskNode; inputish: number; sameOriginFrames: number; elementCount: number }> => {
    const pageResponse = await requestPageElements()
    const inputish = countInputish(pageResponse?.elements)
    const sameOriginFrames = pageResponse?.frames?.sameOrigin ?? 0
    const elementCount = pageResponse?.elements?.length ?? 0
    lastAnalyzeAtRef.current = Date.now()
    let id = ''
    if (pageResponse?.url) {
      try {
        // Hostname + path + query string, not hostname alone — two different pages on the same site
        // (e.g. a job listing vs. its application form, or ?job=123 vs. ?job=456 on the same path) are
        // genuinely different tasks and need their own analysis. This id is used as a single URL path
        // segment (e.g. /task-representations/{id}/analyze), so it must not contain a literal "/" —
        // FastAPI/Starlette won't match %2F across a plain path parameter (confirmed live: it 404s), so
        // any "/" in the path is replaced with "~" here. It's purely an opaque lookup key either way,
        // never parsed back into a URL.
        const url = new URL(pageResponse.url)
        id = `${url.hostname}${url.pathname}${url.search}`.replace(/\/$/, '').replace(/\//g, '~')
      } catch {
        // unparseable URL — treated below as "no usable page yet"
      }
    }

    // Couldn't reach the content script (still injecting, mid-navigation, or a page it can't run on).
    // Report it so analyzeCurrentSiteWithRetry comes back around, but DON'T overwrite a known-good
    // siteIdRef / task representation with a fallback id — that's what left /generate and
    // /events/process calling the backend with an id it never analyzed, i.e. the 404.
    if (!id) return { id: siteIdRef.current, hasPage: false, changed: true, inputish, sameOriginFrames, elementCount }

    if (!force && id === siteIdRef.current) return { id, hasPage: true, changed: false, inputish, sameOriginFrames, elementCount }

    onChangeDetected?.()
    siteIdRef.current = id
    setSiteId(id)
    setPageTitle(pageResponse?.title)
    setTaskRepresentation(undefined)

    try {
      const response = await fetchWithTimeout(`${API_URL}/task-representations/${encodeURIComponent(id)}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...pageResponse, page_text: pageResponse?.pageText ?? '' }),
      }, ANALYZE_TIMEOUT_MS)
      if (!response.ok) throw new Error(`Analyze failed: ${response.status}`)
      const task: TaskNode = await response.json()
      setTaskRepresentation(task)
      return { id, hasPage: true, changed: true, task, inputish, sameOriginFrames, elementCount }
    } catch (error) {
      console.error('Unable to analyze page', error)
    }
    return { id, hasPage: true, changed: true, inputish, sameOriginFrames, elementCount }
  }

  // requestPageElements() can race ahead of the content script actually finishing injection/registration
  // right after a real navigation (or the panel just opening) — confirmed this previously failed silently
  // (hasPage:false, no retry, no error shown), leaving the panel stuck on stale/no task data until the
  // user manually reloaded the page. Retries a few times with backoff before actually giving up.
  const ANALYZE_RETRY_DELAYS_MS = [500, 1200, 2500]
  // Slow SPA forms (Ashby etc.) render fields well after the page's load event. If analysis came back
  // with far fewer components than the DOM has form controls, it was almost certainly still hydrating
  // — retry a few times with growing delays until it settles.
  const SPARSE_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000]
  const looksSparse = (site: { task?: TaskNode; inputish: number; sameOriginFrames: number; elementCount: number }) => {
    if (!site.task) return false
    const components = site.task.components?.length ?? 0
    // Few form controls found AND (there are more in the DOM than we modelled, OR a same-origin iframe
    // is present that may still be loading its form, OR the page reads as a form/application with
    // nothing modelled, OR nothing was modelled at all yet the page returned elements — a bare shell
    // still booting). Each points at "still hydrating", not "genuinely a page with no form".
    const formish = /form|application|checkout|onboarding|signup|sign-up/.test((site.task.page_type || '').toLowerCase())
    // A bare JS shell still booting returns only a handful of nodes and nothing modelled — distinct
    // from a real content page (many nodes, no form).
    const looksLikeShell = components === 0 && site.elementCount > 0 && site.elementCount < 15
    return components < 3 && (site.inputish >= 2 || site.sameOriginFrames > 0 || (formish && components === 0) || looksLikeShell)
  }

  const analyzeCurrentSiteWithRetry = async (force: boolean, onChangeDetected?: () => void) => {
    let site = await analyzeCurrentSite(force, onChangeDetected)
    for (let attempt = 0; site.changed && !site.hasPage && attempt < ANALYZE_RETRY_DELAYS_MS.length; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve, ANALYZE_RETRY_DELAYS_MS[attempt]))
      site = await analyzeCurrentSite(true)
    }
    for (let attempt = 0; site.changed && site.hasPage && looksSparse(site) && attempt < SPARSE_RETRY_DELAYS_MS.length; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve, SPARSE_RETRY_DELAYS_MS[attempt]))
      site = await analyzeCurrentSite(true)
    }
    // Gate the chat when the page genuinely can't be read (after retries). A same-page no-op leaves it.
    if (force || site.changed) setPageUnavailable(!site.hasPage)
    return site
  }

  const retryAnalyze = async () => {
    setReady(false)
    await analyzeCurrentSiteWithRetry(true) // clears pageUnavailable itself on success
    setReady(true)
  }

  // Fast path for a structural change: splice just the added/removed fields into the stored task
  // representation server-side (a small model + deterministic fallback) instead of re-modelling the
  // whole page (~30s). Returns the updated representation, or null to fall back to a full re-analyze.
  // `changed: false` means the flagged DOM change turned out cosmetic (e.g. a file-upload button row
  // swapping for a "<filename> ×" chip within an already-modelled question) — the task representation
  // itself didn't gain or lose a component, so there's nothing worth regenerating the widget for.
  const patchTaskRepresentation = async (added: TaskElement[], removed: string[]): Promise<{ task: TaskNode; changed: boolean } | null> => {
    const id = siteIdRef.current
    if (!id || (added.length === 0 && removed.length === 0)) return null
    try {
      const response = await fetchWithTimeout(`${API_URL}/task-representations/${encodeURIComponent(id)}/patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ added, removed }),
      }, LLM_CALL_TIMEOUT_MS)
      if (!response.ok) return null
      const { changed, ...task } = await response.json() as TaskNode & { changed?: boolean }
      setTaskRepresentation(task)
      lastAnalyzeAtRef.current = Date.now()
      return { task, changed: changed !== false }
    } catch (error) {
      console.error('Unable to patch task representation', error)
      return null
    }
  }

  // The intro never pushes past interfaces at the user — it's just the plain prompt. Reusing a saved
  // one is always the user's move, from the Saved tab (hint at it only when some exist).
  const buildFreshIntroEntry = (savedList: SavedInterface[], _task?: TaskNode, note = ''): ChatEntry => {
    const savedHint = savedList.length > 0 ? ' Or pick a saved interface from the Saved tab.' : ''
    return { id: 'intro', role: 'assistant', text: `${INTRO.text}${savedHint}${note}` }
  }

  // this is to initialize the chat when the panel is opened 
  useEffect(() => {
    let cancelled = false

    async function init() {
      const savedListPromise = refreshSavedList()

      // Each session starts from a blank working tree. The reusable database (Saved tab) is the only
      // thing that persists across sessions — the user re-activates a saved concept, or starts fresh.
      const resetPromise = fetch(`${API_URL}/interface-representation/reset`, { method: 'POST' })
        .then(() => { if (!cancelled) { setAgreed(false); agreedRef.current = false; setActiveSourceId(''); setActiveSourceName(''); setInterfaceComponent(''); setInterfaceDescription('') } })
        .catch(error => console.error('Unable to reset interface representation', error))

      const sitePromise = analyzeCurrentSiteWithRetry(true)
      const savedList = await savedListPromise
      await resetPromise
      const site = await sitePromise
      if (cancelled) return

      // A can't-read-the-page state is surfaced by the persistent banner + disabled composer, not here.
      const analyzeFailedNote = site.hasPage && !site.task
        ? " (I couldn't analyze this page just now — it may have timed out — so suggestions won't be grounded in its real content yet.)"
        : ''

      setTranscript([buildFreshIntroEntry(savedList, site.task, analyzeFailedNote)])

      // The on-page interface is applied only as a direct result of the user activating a saved
      // interface or agreeing to one in chat — it is never re-applied automatically on panel open.
      pushWebpageInterface(null)
      if (!cancelled) setReady(true)
    }

    void init()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-analyzes the page whenever the user navigates to a different site while the panel is open.
  useEffect(() => {
    const handleTabChange = async () => {
      const site = await analyzeCurrentSiteWithRetry(false, () => setReady(false))
      if (!site.changed) return
      // Couldn't read the page after retries — don't tear down an agreed concept / task representation
      // over what's almost certainly a transient content-script miss; leave things as they are.
      if (!site.hasPage) { setReady(true); return }
      if (site.hasPage && !site.task) {
        // analyze either failed or timed out — say so rather than silently carrying on as if nothing
        // happened, since the task representation genuinely didn't update.
        setTranscript(current => [...current, { id: `a-analyze-err-${Date.now()}`, role: 'assistant', text: "I couldn't analyze this page (it may have timed out) — you can still describe your difficulty, but suggestions won't be grounded in this page's real content yet." }])
      }
      // A different page now — always pull any widget off (it lingers in the DOM across SPA
      // navigations, and could be a leftover from a previous session). The concept itself is left
      // intact; the user re-applies it on this page if they want it.
      pushWebpageInterface(null)
      setReady(true)
    }
    // Debounced + de-duplicated on purpose: some SPAs sync UI state (filters, tabs, scroll position)
    // into the URL via history.pushState very rapidly, and each one fires onHistoryStateUpdated — without
    // this, a burst of those could trigger a separate real Anthropic /analyze call for each one (this was
    // a real, confirmed source of excess API spend, not just a theoretical risk). Collapsing a burst into
    // one call after things settle, and never running two analyses concurrently, bounds this regardless
    // of how bursty the triggering source turns out to be.
    let scheduledTabChange: number | undefined
    let tabChangeInFlight = false
    const scheduleTabChange = (delayMs: number) => {
      window.clearTimeout(scheduledTabChange)
      scheduledTabChange = window.setTimeout(() => {
        if (tabChangeInFlight) return
        tabChangeInFlight = true
        void handleTabChange().finally(() => { tabChangeInFlight = false })
      }, delayMs)
    }
    const onUpdated: TabUpdatedListener = (_tabId, changeInfo, tab) => {
      if (!tab.active) return
      if (changeInfo.status === 'complete' || changeInfo.url) scheduleTabChange(150)
    }
    const onActivated: TabActivatedListener = () => scheduleTabChange(150)
    // Single-page apps that change the URL via history.pushState/replaceState (very common on
    // multi-step application flows) don't fire tabs.onUpdated at all — confirmed live. This is the
    // event Chrome actually provides for that case; it needs its own "webNavigation" permission.
    const onHistoryStateUpdated: WebNavListener = (details) => {
      if (details.frameId !== 0) return
      extensionChrome?.tabs?.query({ active: true, currentWindow: true }, tabs => {
        if (tabs[0]?.id === details.tabId) scheduleTabChange(800)
      })
    }
    extensionChrome?.tabs?.onUpdated?.addListener(onUpdated)
    extensionChrome?.tabs?.onActivated?.addListener(onActivated)
    extensionChrome?.webNavigation?.onHistoryStateUpdated?.addListener(onHistoryStateUpdated)
    return () => {
      window.clearTimeout(scheduledTabChange)
      extensionChrome?.tabs?.onUpdated?.removeListener(onUpdated)
      extensionChrome?.tabs?.onActivated?.removeListener(onActivated)
      extensionChrome?.webNavigation?.onHistoryStateUpdated?.removeListener(onHistoryStateUpdated)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


  // A structural page change (a field element entered/left the DOM) while a widget is on this page →
  // re-analyze so the new field enters the task representation, then regenerate the widget from it,
  // with a visible "detected a change, updating…" the whole time. Value edits don't reach here —
  // they're not "structural" (see content.ts) and the live checklist state updates separately.
  useEffect(() => {
    const processStructuralChange = async (
      fieldsAdded: number,
      addedFields: TaskElement[] = [],
      removedFields: string[] = [],
    ) => {
      // A genuinely new field (fieldsAdded > 0) always runs; a removal-only change respects a short
      // cooldown so a burst of conditional-field toggling doesn't churn.
      if (syncingRef.current) return
      if (fieldsAdded === 0 && Date.now() - structuralCooldownRef.current < 4000) return
      syncingRef.current = true
      // Show the "detected a change…" progress only when there's a widget on the page to update;
      // otherwise this is just a silent re-analyze (e.g. a form finishing hydration before any agree).
      const hasWidget = widgetSiteIdRef.current === siteId
      if (hasWidget) setApplyPhase('syncing')
      try {
        // Fast path: patch just the changed fields into the stored representation. Fall back to a full
        // re-analyze if we don't have the field descriptors, or the patch call fails.
        let task: TaskNode | undefined
        let noRealChange = false
        if (siteIdRef.current && (addedFields.length > 0 || removedFields.length > 0)) {
          const patched = await patchTaskRepresentation(addedFields, removedFields)
          if (patched) { task = patched.task; noRealChange = !patched.changed }
        }
        if (!task && !noRealChange) {
          const site = await analyzeCurrentSite(true) // full re-model
          task = site.hasPage ? site.task : undefined
        }
        if (task) staleTaskRepRef.current = false
        if (noRealChange) {
          // The DOM change was cosmetic (e.g. a file-upload button row swapping for a "<filename> ×"
          // chip) — the task representation didn't actually gain/lose a component. Settle quietly
          // rather than claiming an update happened, or burning a /generate call for nothing.
          if (hasWidget) setApplyPhase('idle')
        } else if (task && siteIdRef.current && widgetSiteIdRef.current === siteId) {
          const { applied, degraded } = await generateWebpageInterface(siteIdRef.current)
          finishApply(applied, degraded ? DEGRADED_TEXT : '✓ Support updated for the page change.')
        } else if (hasWidget) {
          setApplyPhase('idle')
        }
      } catch (error) {
        console.error('Structural update failed', error)
        if (hasWidget) setApplyPhase('idle')
      } finally {
        syncingRef.current = false
        structuralCooldownRef.current = Date.now()
      }
    }

    const listener = (message: RuntimeMessage) => {
      if (message.type === 'WIDGET_STATE_CHANGED') {
        if (Date.now() - liveUpdateAtRef.current < 1200) return // throttle: one note per ~1.2s
        liveUpdateAtRef.current = Date.now()
        // A completion flag flipped. Hold the passive "✓ updated" line for a beat: if this same edit
        // also turns out to be structural (a field appeared/left), processStructuralChange takes over
        // with its own progress bubble + result line, and this line must NOT show first or alongside
        // it. Only surface it once nothing else has — no sync running, phase back to idle.
        window.clearTimeout(liveUpdateTimerRef.current)
        liveUpdateTimerRef.current = window.setTimeout(() => {
          if (syncingRef.current || applyPhaseRef.current !== 'idle') return
          setLiveUpdate(true)
          window.setTimeout(() => setLiveUpdate(false), 1800)
        }, 900)
        return
      }
      if (message.type !== 'PAGE_CHANGED' || !message.event || !siteId) return

      // Slow SPA form (Ashby etc.) hydrating after the initial analysis: many form controls appeared and
      // the task rep is still thin → re-analyze so the fields get captured (the URL didn't change), and
      // regenerate the widget too if one is already showing. Rate-limited by the last-analyze timestamp
      // (processStructuralChange re-analyzes, which stamps it) so a genuinely sparse page can't churn.
      const mutations = (message.event.payload?.mutations as Array<{ formControlsAdded?: number }> | undefined) || []
      const formControlsAdded = mutations.reduce((n, m) => n + (m.formControlsAdded || 0), 0)
      const repThin = (taskRepresentationRef.current?.components?.length ?? 0) < 4
      if (formControlsAdded >= 3 && repThin && Date.now() - lastAnalyzeAtRef.current > 8000) {
        void processStructuralChange(formControlsAdded)
        return
      }

      // Any structural change marks the stored task representation stale — so the next widget
      // generation (a chat agreement, a saved-interface activation) re-analyzes first, even if no
      // widget is on the page yet for processStructuralChange to refresh.
      if (message.event.structural) staleTaskRepRef.current = true

      if (message.event.structural && widgetSiteIdRef.current === siteId) {
        void processStructuralChange(
          Number(message.event.fieldsAdded) || 0,
          message.event.addedFields ?? [],
          message.event.removedFields ?? [],
        )
      }
    }
    extensionChrome?.runtime?.onMessage?.addListener(listener)
    return () => {
      window.clearTimeout(liveUpdateTimerRef.current)
      extensionChrome?.runtime?.onMessage?.removeListener(listener)
    }
  }, [siteId])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [transcript, isThinking, applyPhase, liveUpdate])


  // Sending a message function
  const sendMessage = (text = message) => {
    const clean = text.trim()
    if (!clean || busy) return

    const history = transcript.map(entry => ({ role: entry.role, content: entry.text }))
    // Drop the standing intro/notice once the conversation actually starts — it's guidance for the
    // empty state, not something to keep pinned above every later turn.
    setTranscript(current => [...current.filter(e => e.id !== 'intro'), { id: `u-${current.length}-${Date.now()}`, role: 'user', text: clean }])
    setMessage('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setIsThinking(true)
    setSynced(false)

    void fetchWithTimeout(`${API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: clean, history }),
    })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`Chat failed: ${response.status}`)))
      .then(async (result: ChatResponse) => {
        const pushReply = () =>
          setTranscript(current => [...current, { id: `a-${current.length}-${Date.now()}`, role: 'assistant', text: result.reply, suggestions: result.suggestions, offerSave: result.offer_save, suggestedName: result.suggested_name }])
        // Generate the on-page widget as soon as there's an agreed, concrete concept. `agreed` is the
        // model's "ready to show" signal (see the prompt); `treeHasContent` guards against an empty
        // widget if it's set a beat early. A trailing refinement question in the reply is fine.
        // The model is told to send `interface_representation: null` on a turn that doesn't change the
        // tree (agreed, once true, stays true on every later turn — including a plain "looks good" or
        // "save it" that isn't itself an edit) — but re-check here too, so a resent-unchanged tree can't
        // re-trigger "Applying the change to the page…" for nothing.
        const treeJson = result.interface_representation ? JSON.stringify(result.interface_representation) : ''
        const willApply = result.agreed && treeHasContent(result.interface_representation) && treeJson !== appliedTreeJsonRef.current
        // When an apply is about to run, hold the reply back until it resolves — otherwise a reply
        // like "Done — …" renders above a still-spinning "Applying the change to the page…", which
        // reads as though the change already landed when it hasn't yet.
        if (!willApply) pushReply()
        setSynced(true)
        setAgreed(result.agreed)
        if (result.interface_representation?.component !== undefined) setInterfaceComponent(result.interface_representation.component)
        if (result.interface_representation?.description) setInterfaceDescription(result.interface_representation.description)
        // Pre-fill the Saved-tab name field with the readable default so it's one click there too.
        if (result.offer_save) setSaveNameDraft(current => current || defaultSaveName(result.suggested_name))
        // Reply is shown (or, if willApply, will be); the generate-and-apply step is separate and
        // slower, tracked by applyPhase (applying → done/failed line → clears). Composer stays disabled.
        setIsThinking(false)
        if (willApply) {
          appliedTreeJsonRef.current = treeJson
          setApplyPhase('applying')
          // Generate from the page as it is NOW. Re-analyze when there's no analysis yet, or a
          // structural change has been seen since the last one — otherwise the widget is built from a
          // task representation captured when the panel first opened, before the user touched the form.
          let id = siteIdRef.current
          if (!id) {
            const site = await analyzeCurrentSiteWithRetry(true)
            id = site.hasPage && site.task ? site.id : ''
          } else if (staleTaskRepRef.current) {
            const site = await analyzeCurrentSite(true)
            if (site.hasPage && site.task) { id = site.id; staleTaskRepRef.current = false }
          }
          if (id) {
            const { applied, degraded } = await generateWebpageInterface(id)
            pushReply()
            finishApply(applied, degraded ? DEGRADED_TEXT : undefined)
          } else {
            pushReply()
            setApplyPhase('idle')
            setTranscript(current => [...current, { id: `a-noapply-${Date.now()}`, role: 'assistant', text: "I've got the concept, but I can't read this page to show it — reload the tab and reopen this panel, then it'll apply." }])
          }
        }
      })
      .catch(error => {
        console.error('Unable to process chat message', error)
        setTranscript(current => [...current, { id: `a-err-${Date.now()}`, role: 'assistant', text: "I couldn't reach the assistant. Please try again." }])
        setSynced(true)
        setIsThinking(false)
        setApplyPhase('idle')
      })
  }

  const handleRestart = () => {
    if (!window.confirm('End this chat and start over? This clears your interface preferences (shared across every site) and removes the current on-page support until you agree on something new.')) return
    void fetch(`${API_URL}/interface-representation/reset`, { method: 'POST' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`Reset failed: ${response.status}`)))
      .then(async () => {
        const savedList = await refreshSavedList()
        setTranscript([buildFreshIntroEntry(savedList, taskRepresentation)])
        setMessage('')
        setAgreed(false)
        setActiveSourceId('')
        setActiveSourceName('')
        setInterfaceComponent('')
        setInterfaceDescription('')
        setSaveNameDraft('')
        appliedTreeJsonRef.current = ''
        pushWebpageInterface(null)
      })
      .catch(error => console.error('Unable to reset interface representation', error))
  }

  // A readable default save name: the model's suggested_name if any, else the tree's own
  // description (best for user-authored concepts), else "<Component> strategy", else numbered.
  const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim()
  const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57).trimEnd()}…` : s)
  const defaultSaveName = (suggested?: string) =>
    (suggested || '').trim()
    || clip((interfaceDescription || '').trim())
    || (interfaceComponent ? `${titleCase(interfaceComponent)} strategy` : '')
    || `Interface ${savedRepresentations.length + 1}`

  const saveCurrentInterface = async (name: string): Promise<SavedInterface | null> => {
    if (!name.trim()) return null
    try {
      const response = await fetch(`${API_URL}/interface-representations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (!response.ok) throw new Error(`Save failed: ${response.status}`)
      const entry: SavedInterface = await response.json()
      await refreshSavedList()
      return entry
    } catch (error) {
      console.error('Unable to save interface representation', error)
      return null
    }
  }

  const updateSavedInterface = async (id: string): Promise<boolean> => {
    try {
      const response = await fetch(`${API_URL}/interface-representations/${encodeURIComponent(id)}/update`, { method: 'POST' })
      if (!response.ok) throw new Error(`Update failed: ${response.status}`)
      await refreshSavedList()
      return true
    } catch (error) {
      console.error('Unable to update saved interface', error)
      return false
    }
  }

  const deleteSavedInterface = async (id: string): Promise<void> => {
    try {
      const response = await fetch(`${API_URL}/interface-representations/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`Delete failed: ${response.status}`)
      await refreshSavedList()
      // Deleting the entry the working tree came from just unlinks it — the tree itself stays.
      if (id === activeSourceId) { setActiveSourceId(''); setActiveSourceName('') }
    } catch (error) {
      console.error('Unable to delete saved interface', error)
    }
  }
  const handleDeleteSaved = (item: SavedInterface) => {
    if (!window.confirm(`Delete “${item.name}” from your saved interfaces? This can’t be undone.`)) return
    void deleteSavedInterface(item.id)
  }

  const handleSaveCurrent = (event: React.FormEvent) => {
    event.preventDefault()
    if (!saveNameDraft.trim() || savingCurrent) return
    setSavingCurrent(true)
    void saveCurrentInterface(saveNameDraft).then(entry => { if (entry) setSaveNameDraft('') }).finally(() => setSavingCurrent(false))
  }

  const clearOfferSave = (entryId: string) =>
    setTranscript(current => current.map(e => e.id === entryId ? { ...e, offerSave: false } : e))

  // "Update the one I'm working from" — only offered when the working tree came from a saved entry.
  const handleUpdateSource = (entryId: string) => {
    if (!activeSourceId) return
    void updateSavedInterface(activeSourceId).then(ok => {
      clearOfferSave(entryId)
      if (ok) setTranscript(current => [...current, { id: `a-saved-${Date.now()}`, role: 'assistant', text: `Updated "${activeSourceName}" with these changes.` }])
    })
  }

  // "Save as a new interface" — prompt-free (a side-panel window.prompt() returns null): saves with a
  // readable default name, then tells the user where to find/rename it.
  const handleSaveAsNew = (entryId: string, suggestedName?: string) => {
    void saveCurrentInterface(defaultSaveName(suggestedName)).then(entry => {
      clearOfferSave(entryId)
      if (entry) {
        setActiveSourceId(entry.id)
        setActiveSourceName(entry.name)
        setTranscript(current => [...current, { id: `a-saved-${Date.now()}`, role: 'assistant', text: `Saved as "${entry.name}" — rename it in the Saved tab. Further changes can update it.` }])
      }
    })
  }

  const handleActivate = (item: SavedInterface) => {
    // Copies the saved entry into the working tree; further chat edits won't modify the saved entry
    // unless the user chooses "update". Reusing a saved concept counts as agreement.
    setApplyPhase('applying')
    void fetch(`${API_URL}/interface-representations/${encodeURIComponent(item.id)}/activate`, { method: 'POST' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`Activate failed: ${response.status}`)))
      .then(async (payload: InterfaceRepresentationResponse) => {
        agreedRef.current = payload.agreed
        setAgreed(payload.agreed)
        setInterfaceComponent(payload.tree?.component || '')
        setInterfaceDescription(payload.tree?.description || '')
        // So a later "looks good" chat turn (if the model resends this same tree) doesn't re-trigger
        // "Applying the change to the page…" — this activation is already applying it.
        appliedTreeJsonRef.current = payload.tree ? JSON.stringify(payload.tree) : ''
        setActiveSourceId(item.id)
        setActiveSourceName(item.name)
        setTranscript([{ id: 'intro', role: 'assistant', text: `Switched to "${item.name}". Continue refining it, or describe something new.` }])
        setActiveTab('chat')
        let ok = true
        let degradedText: string | undefined
        if (payload.agreed) {
          // Generate from a current task representation — re-analyze if none yet or the page changed.
          let id = siteIdRef.current
          if (!id || staleTaskRepRef.current) {
            const site = await analyzeCurrentSite(true)
            if (site.hasPage && site.task) { id = site.id; staleTaskRepRef.current = false }
          }
          if (id) {
            const result = await generateWebpageInterface(id)
            ok = result.applied
            if (result.degraded) degradedText = DEGRADED_TEXT
          } else {
            ok = false
          }
        }
        finishApply(ok, degradedText)
      })
      .catch(error => { console.error('Unable to activate interface representation', error); finishApply(false) })
  }

  const handleMessageChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(event.target.value)
    const el = event.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

  if (!ready) {
    return (
      <main className="chat-app">
        <div className="loading-state" role="status" aria-live="polite">
          <span className="loading-spinner" aria-hidden="true" />
          <p>Analyzing this page…</p>
        </div>
      </main>
    )
  }

  // One short line under the title. Prefer the model's concise page_purpose; fall back to the page's
  // own <title>; trim either so the header never wraps.
  const rawSubtitle = taskRepresentation?.page_purpose || pageTitle || siteId || 'No page analyzed'
  const subtitle = rawSubtitle.length > 64 ? `${rawSubtitle.slice(0, 63).trimEnd()}…` : rawSubtitle
  // While a widget is being generated/applied, hold back the quick-reply chips and save affordances —
  // they shouldn't invite the next action until the current one has actually landed on the page.
  const interfaceApplying = applyPhase === 'applying' || applyPhase === 'syncing'

  const savedQuery = savedSearch.trim().toLowerCase()
  const filteredSaved = savedQuery
    ? savedRepresentations.filter(item => item.name.toLowerCase().includes(savedQuery))
    : savedRepresentations

  return (
    <main className="chat-app">
      <header className="chat-header">
        <div className="chat-header-identity">
          <span className="chat-avatar" aria-hidden="true"><Sparkles size={16} /></span>
          <div>
            <h1>TaskWeb assistant</h1>
            <p className="chat-subtitle">{subtitle}</p>
          </div>
        </div>
        <div className="chat-header-actions">
          <span className={`sync-pill ${synced ? 'is-synced' : 'is-syncing'}`} role="status">
            <span className="sync-dot" aria-hidden="true" />
            {synced ? 'Saved' : 'Saving…'}
          </span>
        </div>
      </header>

      <div className="tab-bar" role="tablist" aria-label="TaskWeb views">
        <button type="button" role="tab" id="tab-chat" aria-selected={activeTab === 'chat'} aria-controls="panel-chat" onClick={() => setActiveTab('chat')}>Chat</button>
        <button type="button" role="tab" id="tab-saved" aria-selected={activeTab === 'saved'} aria-controls="panel-saved" onClick={() => setActiveTab('saved')}>Saved</button>
      </div>

      {activeTab === 'chat' ? (
        <>
          <div className="chat-log" id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" ref={logRef} aria-live="polite">
            {transcript.map(entry => (
              <div className={`bubble-row ${entry.role}`} key={entry.id}>
                <div className="bubble">
                  <p>{entry.text}</p>
                </div>
                {entry.suggestions && entry.suggestions.length > 0 && !interfaceApplying && !isThinking && (
                  <div className="suggestion-row">
                    {entry.suggestions.map(suggestion => (
                      <button key={suggestion} type="button" onClick={() => sendMessage(suggestion)}>{suggestion}</button>
                    ))}
                  </div>
                )}
                {entry.offerSave && !interfaceApplying && (
                  <div className="suggestion-row">
                    {activeSourceId && (
                      <button type="button" onClick={() => handleUpdateSource(entry.id)}>Update “{activeSourceName}”</button>
                    )}
                    <button type="button" onClick={() => handleSaveAsNew(entry.id, entry.suggestedName)}>{activeSourceId ? 'Save as new' : `Save${entry.suggestedName ? ` as “${entry.suggestedName}”` : ' this interface'}`}</button>
                  </div>
                )}
              </div>
            ))}
            {isThinking && (
              <div className="bubble-row assistant">
                <div className="bubble typing" aria-label="TaskWeb is typing">
                  <span /><span /><span />
                </div>
              </div>
            )}
            {(applyPhase === 'applying' || applyPhase === 'syncing') && !isThinking && (
              <div className="bubble-row assistant">
                <div className="bubble progress" role="status">
                  {applyPhase === 'syncing' ? 'Detected a change on the page — updating the support' : 'Applying the change to the page'}
                  <span className="dots"><span /><span /><span /></span>
                </div>
              </div>
            )}
            {(applyPhase === 'done' || applyPhase === 'failed') && (
              <div className="bubble-row assistant">
                <div className="bubble" role="status">{applyResultText}</div>
              </div>
            )}
            {liveUpdate && applyPhase === 'idle' && !isThinking && (
              <div className="bubble-row assistant">
                <div className="bubble" role="status">✓ Support updated for a change on the page.</div>
              </div>
            )}
          </div>

          {pageUnavailable && (
            <div className="page-unavailable" role="alert">
              <span>Can’t read this page, so there’s nothing to build support for. Reload the tab and reopen this panel.</span>
              <button type="button" onClick={retryAnalyze}>Retry</button>
            </div>
          )}

          <form
            className="composer"
            onSubmit={event => { event.preventDefault(); sendMessage() }}
          >
            <label htmlFor="chat-input" className="sr-only">Message</label>
            <textarea
              id="chat-input"
              ref={textareaRef}
              value={message}
              onChange={handleMessageChange}
              onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage() } }}
              placeholder={pageUnavailable ? 'Analyze a page to continue…' : busy ? 'Working…' : agreed ? 'Respond or refine the support…' : 'Describe what you’re struggling with…'}
              rows={1}
              disabled={busy || pageUnavailable}
            />
            <button type="submit" className="send-button" aria-label="Send message" disabled={!message.trim() || busy || pageUnavailable}>
              <Send size={18} />
            </button>
          </form>

          <button type="button" className="end-chat-link" onClick={handleRestart}>
            <RefreshCw size={13} aria-hidden="true" />
            End chat &amp; start over
          </button>
        </>
      ) : (
        <div className="saved-panel" id="panel-saved" role="tabpanel" aria-labelledby="tab-saved">
          <form className="save-current-form" onSubmit={handleSaveCurrent}>
            <label htmlFor="save-name" className="sr-only">Name the task interface</label>
            <input
              id="save-name"
              value={saveNameDraft}
              onChange={event => setSaveNameDraft(event.target.value)}
              placeholder="Name the task interface…"
            />
            <button type="submit" disabled={!saveNameDraft.trim() || savingCurrent}>Save</button>
          </form>

          {savedRepresentations.length > 5 && (
            <input
              className="saved-search"
              type="search"
              value={savedSearch}
              onChange={event => setSavedSearch(event.target.value)}
              placeholder="Search saved…"
              aria-label="Search saved interfaces"
            />
          )}

          {savedRepresentations.length === 0 ? (
            <p className="saved-empty">No task interfaces made yet. Shape one in Chat, then save it here to reuse on other sites.</p>
          ) : filteredSaved.length === 0 ? (
            <p className="saved-empty">No saved interface matches “{savedSearch}”.</p>
          ) : (
            <ul className="saved-list">
              {filteredSaved.map(item => {
                const accent = savedAccent(item.id)
                return (
                  <li key={item.id} className="saved-row" style={{ '--saved-hue': accent.hue } as React.CSSProperties}>
                    <button type="button" className="saved-item" onClick={() => handleActivate(item)}>
                      <span className="saved-item-emoji" aria-hidden="true">{accent.emoji}</span>
                      <span className="saved-item-name">{item.name}</span>
                    </button>
                    <button type="button" className="saved-item-delete" aria-label={`Delete ${item.name}`} title="Delete" onClick={() => handleDeleteSaved(item)}>
                      ×
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </main>
  )
}

export default App
