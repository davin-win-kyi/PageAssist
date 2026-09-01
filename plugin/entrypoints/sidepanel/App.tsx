import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Send, Sparkles } from 'lucide-react'

type InterfaceNode = {
  component: string
  style: Record<string, string>
  // A list of phrases describing intent on the reusable, webpage-agnostic preference tree; an object of
  // literal display text once grounded to a specific page's webpage_interface.
  content: Record<string, string> | string[]
  // Grounds a node in a real page element for the model's own reference; the renderer never displays
  // this as text (unlike content, which is shown verbatim).
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
type TaskElement = { id: string; selector: string; tag: string; text: string; role?: string; accessibleName?: string; visible?: boolean }
type TaskNode = {
  task_id: string
  task_name: string
  children_tasks: TaskNode[]
  task_elements: TaskElement[]
  example_difficulties?: string[]
}
type ChatEntry = { id: string; role: 'user' | 'assistant'; text: string; suggestions?: string[]; chooseInterface?: SavedInterface[] }
type ChatResponse = {
  reply: string
  suggestions: string[]
  interface_representation: InterfaceNode
  agreed: boolean
}
type SavedInterface = { id: string; name: string; created_at: string; updated_at: string }

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
type RuntimeMessage = { type?: string; event?: { type: string; url: string; target?: Record<string, unknown>; payload?: Record<string, unknown> } }
type PageElementsResponse = { url: string; title: string; elements: TaskElement[] }
type TabInfo = { id?: number; active?: boolean }
type TabUpdatedListener = (tabId: number, changeInfo: { status?: string; url?: string }, tab: TabInfo) => void
type TabActivatedListener = (activeInfo: { tabId: number }) => void
type WebNavDetails = { tabId: number; frameId: number; url: string }
type WebNavListener = (details: WebNavDetails) => void
type ExtensionChrome = {
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
}
const extensionChrome = (globalThis as typeof globalThis & { chrome?: ExtensionChrome }).chrome

// Quick-reply chips are never hardcoded — they come from the task representation's model-generated
// example_difficulties, so they're grounded in the actual page. Until analysis lands there are none.
const INTRO = {
  text: 'I can help create interface support for this webpage. Describe something that’s difficult about the current task, or describe a support you already have in mind — I may ask you to confirm how I’ve understood it.',
}

// The Anthropic-backed endpoints (analyze/generate/chat) have shown real latency variance in this
// project already, and had NO timeout at all — a slow or hung call left the panel stuck on its loading
// screen indefinitely, with no visible error, since nothing downstream ever ran to clear it.
const LLM_CALL_TIMEOUT_MS = 25000
function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = LLM_CALL_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => window.clearTimeout(timeout))
}

function requestPageElements(): Promise<PageElementsResponse | undefined> {
  return new Promise(resolve => {
    if (!extensionChrome?.tabs) { resolve(undefined); return }
    const timeout = window.setTimeout(() => resolve(undefined), 6000)
    extensionChrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id
      if (tabId === undefined) { window.clearTimeout(timeout); resolve(undefined); return }
      extensionChrome.tabs?.sendMessage(tabId, { type: 'GET_PAGE_ELEMENTS' }, response => {
        void extensionChrome.runtime?.lastError // acknowledge to avoid an unchecked-error console warning when no content script answers
        window.clearTimeout(timeout)
        resolve(response)
      })
    })
  })
}

function hasPreferences(rep: InterfaceNode | undefined): boolean {
  return !!rep && (rep.children.length > 0 || Object.keys(rep.style).length > 0 || Object.keys(rep.content).length > 0)
}

function App() {
  const [siteId, setSiteId] = useState('')
  const [pageTitle, setPageTitle] = useState<string | undefined>(undefined)
  const [taskRepresentation, setTaskRepresentation] = useState<TaskNode | undefined>(undefined)
  const [message, setMessage] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [synced, setSynced] = useState(true)
  const [agreed, setAgreed] = useState(false)
  const [transcript, setTranscript] = useState<ChatEntry[]>([{ id: 'intro', role: 'assistant', text: INTRO.text }])
  const [ready, setReady] = useState(false)
  const [activeTab, setActiveTab] = useState<'chat' | 'saved'>('chat')
  const [savedRepresentations, setSavedRepresentations] = useState<SavedInterface[]>([])
  const [saveNameDraft, setSaveNameDraft] = useState('')
  const [savingCurrent, setSavingCurrent] = useState(false)

  const logRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const siteIdRef = useRef('')
  const agreedRef = useRef(false)

  // use effect when the agreed state changes 
  useEffect(() => { agreedRef.current = agreed }, [agreed])

  // The content script can take a variable amount of time to finish injecting/registering its
  // listener right after a page loads — confirmed live that a single 500ms retry still isn't always
  // enough. Retries with backoff a few times before actually giving up.
  const RETRY_DELAYS_MS = [400, 900, 1600]
  const pushWebpageInterface = (widget: Widget | null, attempt = 0) => {
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

  const generateWebpageInterface = async (id: string) => {
    try {
      const response = await fetchWithTimeout(`${API_URL}/webpage-interfaces/${encodeURIComponent(id)}/generate`, { method: 'POST' })
      if (!response.ok) throw new Error(`Generate failed: ${response.status}`)
      const widget: Widget = await response.json()
      pushWebpageInterface(widget)
    } catch (error) {
      console.error('Unable to generate webpage interface', error)
    }
  }

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
  const analyzeCurrentSite = async (force = false, onChangeDetected?: () => void): Promise<{ id: string; hasPage: boolean; changed: boolean; task?: TaskNode }> => {
    const pageResponse = await requestPageElements()
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
    if (!id) return { id: siteIdRef.current, hasPage: false, changed: true }

    if (!force && id === siteIdRef.current) return { id, hasPage: true, changed: false }

    onChangeDetected?.()
    siteIdRef.current = id
    setSiteId(id)
    setPageTitle(pageResponse?.title)
    setTaskRepresentation(undefined)

    try {
      const response = await fetchWithTimeout(`${API_URL}/task-representations/${encodeURIComponent(id)}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pageResponse),
      })
      if (!response.ok) throw new Error(`Analyze failed: ${response.status}`)
      const task: TaskNode = await response.json()
      setTaskRepresentation(task)
      return { id, hasPage: true, changed: true, task }
    } catch (error) {
      console.error('Unable to analyze page', error)
    }
    return { id, hasPage: true, changed: true }
  }

  // requestPageElements() can race ahead of the content script actually finishing injection/registration
  // right after a real navigation (or the panel just opening) — confirmed this previously failed silently
  // (hasPage:false, no retry, no error shown), leaving the panel stuck on stale/no task data until the
  // user manually reloaded the page. Retries a few times with backoff before actually giving up.
  const ANALYZE_RETRY_DELAYS_MS = [500, 1200, 2500]
  const analyzeCurrentSiteWithRetry = async (force: boolean, onChangeDetected?: () => void) => {
    let site = await analyzeCurrentSite(force, onChangeDetected)
    for (let attempt = 0; site.changed && !site.hasPage && attempt < ANALYZE_RETRY_DELAYS_MS.length; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve, ANALYZE_RETRY_DELAYS_MS[attempt]))
      site = await analyzeCurrentSite(true)
    }
    return site
  }

  const buildFreshIntroEntry = (savedList: SavedInterface[], task?: TaskNode, note = ''): ChatEntry => {
    if (savedList.length > 0) {
      return { id: 'intro', role: 'assistant', text: `Would you like to reuse one of your saved interfaces on this page, or create a new one?${note}`, chooseInterface: savedList }
    }
    const suggestions = task?.example_difficulties?.length ? task.example_difficulties : []
    return { id: 'intro', role: 'assistant', text: `${INTRO.text}${note}`, suggestions }
  }

  // this is to initialize the chat when the panel is opened 
  useEffect(() => {
    let cancelled = false

    async function init() {
      const savedListPromise = refreshSavedList()

      let hadExistingWork = false
      const interfacePromise = fetch(`${API_URL}/interface-representation`)
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`Load failed: ${response.status}`)))
        .then((payload: InterfaceRepresentationResponse) => {
          if (cancelled) return
          hadExistingWork = hasPreferences(payload.tree)
          setAgreed(payload.agreed)
        })
        .catch(error => console.error('Unable to load interface representation', error))

      const sitePromise = analyzeCurrentSiteWithRetry(true)
      const savedList = await savedListPromise
      await interfacePromise
      const site = await sitePromise
      if (cancelled) return

      const analyzeFailedNote = site.hasPage && !site.task
        ? " (I couldn't analyze this page just now — it may have timed out — so suggestions won't be grounded in its real content yet.)"
        : ''

      if (hadExistingWork) {
        setTranscript([{ id: 'intro', role: 'assistant', text: `Continuing to refine your saved interface support preferences — describe any changes, or check how it looks on this page.${analyzeFailedNote}` }])
      } else {
        setTranscript([buildFreshIntroEntry(savedList, site.task, analyzeFailedNote)])
      }

      // The on-page interface is applied only as a direct result of the user activating a saved
      // interface or agreeing to one in chat — it is never re-applied automatically on panel open, so
      // a page refresh clears it until the user chooses again.
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
      // A genuinely different task is showing now — pull the previous page's widget off so it doesn't
      // linger here (it stays in the DOM across SPA navigations). The concept itself — the working /
      // saved interface representation and its agreement — is left intact; the user re-applies it on
      // this page if they want it, exactly as they would after a refresh.
      if (agreedRef.current) pushWebpageInterface(null)
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


  // Forwards in-page changes to the backend so it can keep the stored webpage_interface fresh. It is
  // NEVER auto-applied to the page here — the widget only appears when the user explicitly activates a
  // saved interface or agrees to one in chat. The regenerated version is what they'll see next time
  // they apply it. (Live checklist state still updates instantly, separately, in content.ts.)
  useEffect(() => {
    const listener = (message: RuntimeMessage) => {
      if (message.type !== 'PAGE_CHANGED' || !message.event || !siteId) return
      void fetchWithTimeout(`${API_URL}/task-representations/${encodeURIComponent(siteId)}/events/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.event),
      })
        .then(response => response.ok ? undefined : Promise.reject(new Error(`Event processing failed: ${response.status}`)))
        .catch(error => console.error('Unable to process webpage change', error))
    }
    extensionChrome?.runtime?.onMessage?.addListener(listener)
    return () => extensionChrome?.runtime?.onMessage?.removeListener(listener)
  }, [siteId])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [transcript, isThinking])


  // Sending a message function
  const sendMessage = (text = message) => {
    const clean = text.trim()
    if (!clean || isThinking) return

    const history = transcript.map(entry => ({ role: entry.role, content: entry.text }))
    setTranscript(current => [...current, { id: `u-${current.length}-${Date.now()}`, role: 'user', text: clean }])
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
        setTranscript(current => [...current, { id: `a-${current.length}-${Date.now()}`, role: 'assistant', text: result.reply, suggestions: result.suggestions }])
        setSynced(true)
        setAgreed(result.agreed)
        // Stop "thinking" as soon as the reply is actually shown — generateWebpageInterface below is a
        // separate, often slower call; leaving isThinking on through it made the typing indicator hang
        // around well after the message had already appeared.
        setIsThinking(false)
        if (result.agreed) {
          // siteIdRef.current, not the siteId state — this callback closes over the render it was
          // fired from, whose siteId may be stale if analyzeCurrentSite updated the id after the
          // message was sent; a mismatched id makes the backend 404 the generate call.
          if (siteIdRef.current) await generateWebpageInterface(siteIdRef.current)
        }
      })
      .catch(error => {
        console.error('Unable to process chat message', error)
        setTranscript(current => [...current, { id: `a-err-${Date.now()}`, role: 'assistant', text: "I couldn't reach the assistant. Please try again." }])
        setSynced(true)
        setIsThinking(false)
      })
  }

  const handleRestart = () => {
    if (!window.confirm('End this chat and start over? This clears your interface preferences (shared across every site) and removes the current on-page support until you agree on something new.')) return
    void fetch(`${API_URL}/interface-representation/reset`, { method: 'POST' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`Reset failed: ${response.status}`)))
      .then(async () => {
        const savedList = await refreshSavedList()
        if (savedList.length > 0) {
          setTranscript([{
            id: 'intro',
            role: 'assistant',
            text: 'Would you like to reuse one of your saved interfaces on this page, or create a new one?',
            chooseInterface: savedList,
          }])
        } else {
          const suggestions = taskRepresentation?.example_difficulties?.length ? taskRepresentation.example_difficulties : []
          setTranscript([{ id: 'intro', role: 'assistant', text: INTRO.text, suggestions }])
        }
        setMessage('')
        setAgreed(false)
        pushWebpageInterface(null)
      })
      .catch(error => console.error('Unable to reset interface representation', error))
  }

  const handleSaveCurrent = (event: React.FormEvent) => {
    event.preventDefault()
    const name = saveNameDraft.trim()
    if (!name || savingCurrent) return
    setSavingCurrent(true)
    void fetch(`${API_URL}/interface-representations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`Save failed: ${response.status}`)))
      .then(() => { setSaveNameDraft(''); return refreshSavedList() })
      .catch(error => console.error('Unable to save interface representation', error))
      .finally(() => setSavingCurrent(false))
  }

  const handleActivate = (item: SavedInterface) => {
    // Copies the saved entry into the working tree; further chat edits won't modify the saved entry itself.
    // Choosing to reuse a saved concept counts as agreement, so it appears on the page immediately.
    void fetch(`${API_URL}/interface-representations/${encodeURIComponent(item.id)}/activate`, { method: 'POST' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`Activate failed: ${response.status}`)))
      .then(async (payload: InterfaceRepresentationResponse) => {
        agreedRef.current = payload.agreed
        setAgreed(payload.agreed)
        setTranscript([{ id: 'intro', role: 'assistant', text: `Switched to "${item.name}". Continue refining it, or describe something new.` }])
        setActiveTab('chat')
        if (payload.agreed) {
          if (siteIdRef.current) await generateWebpageInterface(siteIdRef.current)
        }
      })
      .catch(error => console.error('Unable to activate interface representation', error))
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

  return (
    <main className="chat-app">
      <header className="chat-header">
        <div className="chat-header-identity">
          <span className="chat-avatar" aria-hidden="true"><Sparkles size={16} /></span>
          <div>
            <h1>TaskWeb assistant</h1>
            <p className="chat-subtitle">{taskRepresentation?.task_name || pageTitle || siteId || '…'}</p>
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
                {entry.chooseInterface ? (
                  <div className="suggestion-row">
                    {entry.chooseInterface.map(item => (
                      <button key={item.id} type="button" onClick={() => handleActivate(item)}>{item.name}</button>
                    ))}
                    <button type="button" onClick={() => {
                      const suggestions = taskRepresentation?.example_difficulties?.length ? taskRepresentation.example_difficulties : []
                      setTranscript([{ id: 'intro', role: 'assistant', text: INTRO.text, suggestions }])
                    }}>Create a new interface</button>
                  </div>
                ) : entry.suggestions && entry.suggestions.length > 0 && (
                  <div className="suggestion-row">
                    {entry.suggestions.map(suggestion => (
                      <button key={suggestion} type="button" onClick={() => sendMessage(suggestion)}>{suggestion}</button>
                    ))}
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
          </div>

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
              placeholder={agreed ? 'Respond or refine the support…' : 'Describe what you’re struggling with…'}
              rows={1}
            />
            <button type="submit" className="send-button" aria-label="Send message" disabled={!message.trim() || isThinking}>
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

          {savedRepresentations.length === 0 ? (
            <p className="saved-empty">No task interfaces made yet. Shape one in Chat, then save it here to reuse on other sites.</p>
          ) : (
            <ul className="saved-list">
              {savedRepresentations.map(item => (
                <li key={item.id}>
                  <button type="button" className="saved-item" onClick={() => handleActivate(item)}>
                    <span className="saved-item-name">{item.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </main>
  )
}

export default App
