import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Send, Sparkles } from 'lucide-react'

type InterfaceNode = {
  component: string
  component_preferences: Record<string, unknown>
  children: InterfaceNode[]
}
type InterfaceRepresentationResponse = { tree: InterfaceNode; agreed: boolean }
type TaskElement = { id: string; selector: string; tag: string; text: string }
type TaskNode = {
  task_id: string
  task_name: string
  children_tasks: TaskNode[]
  task_elements: TaskElement[]
}
type ChatEntry = { id: string; role: 'user' | 'assistant'; text: string; suggestions?: string[] }
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
type TabUpdatedListener = (tabId: number, changeInfo: { status?: string }, tab: TabInfo) => void
type TabActivatedListener = (activeInfo: { tabId: number }) => void
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
}
const extensionChrome = (globalThis as typeof globalThis & { chrome?: ExtensionChrome }).chrome

const INTRO = {
  text: 'I can help create interface support for this webpage. Describe something that’s difficult about the current task, or describe a support you already have in mind — I may ask you to confirm how I’ve understood it.',
  suggestions: ['I keep losing track of which steps are done', 'I can’t tell what’s still required'],
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
  return !!rep && (rep.children.length > 0 || Object.keys(rep.component_preferences).length > 0)
}

function App() {
  const [siteId, setSiteId] = useState('')
  const [pageTitle, setPageTitle] = useState<string | undefined>(undefined)
  const [taskRepresentation, setTaskRepresentation] = useState<TaskNode | undefined>(undefined)
  const [message, setMessage] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [synced, setSynced] = useState(true)
  const [agreed, setAgreed] = useState(false)
  const [transcript, setTranscript] = useState<ChatEntry[]>([{ id: 'intro', role: 'assistant', text: INTRO.text, suggestions: INTRO.suggestions }])
  const [ready, setReady] = useState(false)
  const [activeTab, setActiveTab] = useState<'chat' | 'saved'>('chat')
  const [savedRepresentations, setSavedRepresentations] = useState<SavedInterface[]>([])
  const [saveNameDraft, setSaveNameDraft] = useState('')
  const [savingCurrent, setSavingCurrent] = useState(false)

  const logRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const siteIdRef = useRef('')
  const agreedRef = useRef(false)

  useEffect(() => { agreedRef.current = agreed }, [agreed])

  const pushWebpageInterface = (tree: InterfaceNode | null) => {
    extensionChrome?.tabs?.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id
      if (tabId === undefined) return
      extensionChrome.tabs?.sendMessage(tabId, { type: 'APPLY_WEBPAGE_INTERFACE', tree }, () => {
        const lastError = extensionChrome.runtime?.lastError
        if (lastError) console.error('Unable to apply the webpage interface — the content script may not be loaded on this tab (try reloading it):', lastError.message)
      })
    })
  }

  const generateWebpageInterface = async (id: string) => {
    try {
      const response = await fetch(`${API_URL}/webpage-interfaces/${encodeURIComponent(id)}/generate`, { method: 'POST' })
      if (!response.ok) throw new Error(`Generate failed: ${response.status}`)
      const tree: InterfaceNode = await response.json()
      pushWebpageInterface(tree)
    } catch (error) {
      console.error('Unable to generate webpage interface', error)
    }
  }

  const refreshSavedList = async () => {
    try {
      const response = await fetch(`${API_URL}/interface-representations`)
      if (!response.ok) throw new Error(`List failed: ${response.status}`)
      setSavedRepresentations(await response.json())
    } catch (error) {
      console.error('Unable to load saved interface representations', error)
    }
  }

  // Grabs the current active tab's page elements, and — only if it's a genuinely different site than
  // last time (or `force`, for the very first call) — re-analyzes it into a fresh task representation.
  const analyzeCurrentSite = async (force = false): Promise<{ id: string; hasPage: boolean; changed: boolean }> => {
    const pageResponse = await requestPageElements()
    let id = 'default-site'
    if (pageResponse?.url) {
      try {
        id = new URL(pageResponse.url).hostname || id
      } catch {
        // keep the default id if the URL can't be parsed
      }
    }
    if (!force && id === siteIdRef.current) return { id, hasPage: !!pageResponse, changed: false }

    siteIdRef.current = id
    setSiteId(id)
    setPageTitle(pageResponse?.title)
    setTaskRepresentation(undefined)

    if (!pageResponse) return { id, hasPage: false, changed: true }

    try {
      const response = await fetch(`${API_URL}/task-representations/${encodeURIComponent(id)}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pageResponse),
      })
      if (!response.ok) throw new Error(`Analyze failed: ${response.status}`)
      setTaskRepresentation(await response.json())
    } catch (error) {
      console.error('Unable to analyze page', error)
    }
    return { id, hasPage: true, changed: true }
  }

  useEffect(() => {
    let cancelled = false

    async function init() {
      void refreshSavedList()

      let agreedFromLoad = false
      const interfacePromise = fetch(`${API_URL}/interface-representation`)
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`Load failed: ${response.status}`)))
        .then((payload: InterfaceRepresentationResponse) => {
          if (cancelled) return
          agreedFromLoad = payload.agreed
          setAgreed(payload.agreed)
          if (hasPreferences(payload.tree)) {
            setTranscript([{ id: 'intro', role: 'assistant', text: 'Continuing with your existing interface preferences.' }])
          }
        })
        .catch(error => console.error('Unable to load interface representation', error))

      const sitePromise = analyzeCurrentSite(true)
      await interfacePromise
      const site = await sitePromise
      if (cancelled) return
      // Nothing is shown on the actual page until the user has agreed on a support concept.
      if (site.hasPage && agreedFromLoad) await generateWebpageInterface(site.id)
      if (!cancelled) setReady(true)
    }

    void init()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-analyzes the page whenever the user navigates to a different site while the panel is open.
  useEffect(() => {
    const handleTabChange = async () => {
      const site = await analyzeCurrentSite()
      if (!site.changed) return
      setReady(false)
      if (site.hasPage && agreedRef.current) await generateWebpageInterface(site.id)
      setReady(true)
    }
    const onUpdated: TabUpdatedListener = (_tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.active) void handleTabChange()
    }
    const onActivated: TabActivatedListener = () => { void handleTabChange() }
    extensionChrome?.tabs?.onUpdated?.addListener(onUpdated)
    extensionChrome?.tabs?.onActivated?.addListener(onActivated)
    return () => {
      extensionChrome?.tabs?.onUpdated?.removeListener(onUpdated)
      extensionChrome?.tabs?.onActivated?.removeListener(onActivated)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const listener = (message: RuntimeMessage) => {
      if (message.type !== 'PAGE_CHANGED' || !message.event || !siteId) return
      void fetch(`${API_URL}/task-representations/${encodeURIComponent(siteId)}/events/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.event),
      })
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`Event processing failed: ${response.status}`)))
        .then((result: { related?: boolean; webpage_interface?: InterfaceNode }) => {
          if (result.related && result.webpage_interface) pushWebpageInterface(result.webpage_interface)
        })
        .catch(error => console.error('Unable to process webpage change', error))
    }
    extensionChrome?.runtime?.onMessage?.addListener(listener)
    return () => extensionChrome?.runtime?.onMessage?.removeListener(listener)
  }, [siteId])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [transcript, isThinking])

  const sendMessage = (text = message) => {
    const clean = text.trim()
    if (!clean || isThinking) return

    const history = transcript.map(entry => ({ role: entry.role, content: entry.text }))
    setTranscript(current => [...current, { id: `u-${current.length}-${Date.now()}`, role: 'user', text: clean }])
    setMessage('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setIsThinking(true)
    setSynced(false)

    void fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: clean, history }),
    })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`Chat failed: ${response.status}`)))
      .then(async (result: ChatResponse) => {
        setTranscript(current => [...current, { id: `a-${current.length}-${Date.now()}`, role: 'assistant', text: result.reply, suggestions: result.suggestions }])
        setSynced(true)
        setAgreed(result.agreed)
        if (result.agreed && siteId) await generateWebpageInterface(siteId)
      })
      .catch(error => {
        console.error('Unable to process chat message', error)
        setTranscript(current => [...current, { id: `a-err-${Date.now()}`, role: 'assistant', text: "I couldn't reach the assistant. Please try again." }])
        setSynced(true)
      })
      .finally(() => setIsThinking(false))
  }

  const handleRestart = () => {
    if (!window.confirm('End this chat and start over? This clears your interface preferences (shared across every site) and removes the current on-page support until you agree on something new.')) return
    void fetch(`${API_URL}/interface-representation/reset`, { method: 'POST' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`Reset failed: ${response.status}`)))
      .then(() => {
        setTranscript([{ id: 'intro', role: 'assistant', text: INTRO.text, suggestions: INTRO.suggestions }])
        setMessage('')
        setAgreed(false)
        pushWebpageInterface(null)
        void refreshSavedList()
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
        setAgreed(payload.agreed)
        setTranscript([{ id: 'intro', role: 'assistant', text: `Switched to "${item.name}". Continue refining it, or describe something new.` }])
        setActiveTab('chat')
        if (payload.agreed && siteId) await generateWebpageInterface(siteId)
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
                {entry.suggestions && entry.suggestions.length > 0 && (
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
