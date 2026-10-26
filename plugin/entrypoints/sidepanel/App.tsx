/*
The following is the panel for PageAssist that consist of the following:
- a conversational interface for the creation and refinement of an interface (ChatTab.tsx)
- a saved tab to save interface representation of interfaces that you want to reuse
  on other webpages (SavedTab.tsx)

Overall here are the four jobs of the panel to do the 2 task mentioned above:
1. track the page: through the URL, analyzing it when switching between pages and when
   the active webpage changes
2. running the chat: getting the reply, giving suggestions and saving the prompt
3. applying and keeping the widget current: generating the widget, and splicing page
   changes into it without generating it again
4. saving interface representations that the user can then later apply to other webpages

Note: the schemas are in types.ts, the backend calls in backend.ts, the messages to and from
the page in page-messages.ts, and the smaller helpers in helpers.ts
*/

import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { WidgetItem } from '../../lib/widget-items'
import {
  extensionChrome,
  requestPageElements,
  type TabUpdatedListener,
  type TabActivatedListener,
  type WebNavListener,
} from '../../lib/extension'
import type { ApplyPhase, ChatEntry, PageChange, SavedInterface, Site, TaskNode, Widget } from './types'
import * as backend from './backend'
import { errorText } from './backend'
import { pushWebpageInterface as pushToPage, applyWidgetAndWait, updateWidgetItemsOnPage, listenToPage, captureInterface } from './page-messages'
import { siteIdFor, countInputish, looksSparse, treeHasContent, mergeChanges, defaultSaveName as buildSaveName } from './helpers'
import ChatTab from './ChatTab'
import SavedTab from './SavedTab'

const INTRO = {
  text: 'I can help create interface support for this webpage. Describe something that’s difficult about the current task, or describe a support you already have in mind — I may ask you to confirm how I’ve understood it.',
}
const APPLIED_TEXT = '✓ Support applied to the page.'
const UPDATED_TEXT = '✓ Support updated for the page change.'
const NOT_APPLIED_TEXT = 'Couldn’t apply it to the page — reload the tab and try again.'
const FAILED_WIDGET_TEXT = '⚠ PageAssist couldn’t build the support. The warning on the page has the details; try again.'

/*
The outcome of generating and applying a widget. `degraded` means generation failed and the page
shows the warning widget instead; `error` means the request itself failed.
*/
type ApplyResult = { applied: boolean; degraded: boolean; error?: string }

function App() {

  /*************************************************************************************************
  State
  *************************************************************************************************/

  const [siteId, setSiteId] = useState('')
  const [pageTitle, setPageTitle] = useState<string | undefined>(undefined)
  const [taskRepresentation, setTaskRepresentation] = useState<TaskNode | undefined>(undefined)
  const [message, setMessage] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [applyPhase, setApplyPhase] = useState<ApplyPhase>('idle')
  const [applyResultText, setApplyResultText] = useState('')
  const applyResetRef = useRef<number | undefined>(undefined)
  const applyPhaseRef = useRef<ApplyPhase>('idle')
  const busy = isThinking || applyPhase === 'applying'
  /* for completion flag changes */
  const [liveUpdate, setLiveUpdate] = useState(false)
  const liveUpdateAtRef = useRef(0)
  const liveUpdateTimerRef = useRef<number | undefined>(undefined)
  const syncingRef = useRef(false)
  /* page changes that arrived while another was being applied */
  const pendingChangeRef = useRef<PageChange | null>(null)
  /* When the current page can't be read */
  const [pageUnavailable, setPageUnavailable] = useState(false)
  const [synced, setSynced] = useState(true)
  const [agreed, setAgreed] = useState(false)
  const [transcript, setTranscript] = useState<ChatEntry[]>([{ id: 'intro', role: 'assistant', text: INTRO.text }])
  const [ready, setReady] = useState(false)
  const [activeTab, setActiveTab] = useState<'chat' | 'saved'>('chat')
  const [savedRepresentations, setSavedRepresentations] = useState<SavedInterface[]>([])
  const [savedSearch, setSavedSearch] = useState('')
  const [saveNameDraft, setSaveNameDraft] = useState('')
  const [savingCurrent, setSavingCurrent] = useState(false)

  /*
  The saved entry the working tree came from, so a save can update it instead of making a new
  one ('' for a fresh tree)
  */
  const [activeSourceId, setActiveSourceId] = useState('')
  const [activeSourceName, setActiveSourceName] = useState('')
  /* The working tree's root component */
  const [interfaceComponent, setInterfaceComponent] = useState('')
  const [interfaceDescription, setInterfaceDescription] = useState('')

  const logRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const siteIdRef = useRef('')
  const agreedRef = useRef(false)

  /* Site ID of the webpage that the current widget is on */
  const widgetSiteIdRef = useRef('')

  /* This is the JSON of the interface representation */
  const appliedTreeJsonRef = useRef('')
  /* Where the widget showing now is filed in the study records, for its screenshots */
  const recordIdRef = useRef<string | null>(null)
  const taskRepresentationRef = useRef<TaskNode | undefined>(undefined)
  /* Records when the panel last updated its task representation */
  const lastAnalyzeAtRef = useRef(0)
  /* Set when the page changed since the task representation was made */
  const staleTaskRepRef = useRef(false)

  /*
  Save a copy of the references
  */
  useEffect(() => { agreedRef.current = agreed }, [agreed])
  useEffect(() => { taskRepresentationRef.current = taskRepresentation }, [taskRepresentation])
  useEffect(() => { applyPhaseRef.current = applyPhase }, [applyPhase])

  /*************************************************************************************************
  Widget
  *************************************************************************************************/

  // The brief result line after a support is applied, or after it failed and why
  const finishApply = (ok: boolean, text?: string) => {
    setApplyResultText(text ?? (ok ? APPLIED_TEXT : NOT_APPLIED_TEXT))
    setApplyPhase(ok ? 'done' : 'failed')
    window.clearTimeout(applyResetRef.current)
    applyResetRef.current = window.setTimeout(() => setApplyPhase('idle'), ok ? 3500 : 6000)
  }

  // Sends a widget (or null) to the page and records which site it's on
  const pushWebpageInterface = (widget: Widget | null) => {
    widgetSiteIdRef.current = widget ? siteIdRef.current : ''
    if (!widget) recordIdRef.current = null
    pushToPage(widget)
  }

  // A screenshot of just the widget for the study records, once it has settled on the page
  const saveScreenshot = (recordId: string | null | undefined, reason: 'applied' | 'updated') => {
    if (!recordId) return
    window.setTimeout(() => {
      void captureInterface()
        .then(image => { if (image) backend.recordScreenshot(recordId, reason, image) })
        .catch(error => console.warn('PageAssist: could not take a screenshot of the widget', error))
    }, 900)
  }

  // Generates the widget for a site and applies it to the page. `reason` says why, for the records.
  const generateWebpageInterface = async (id: string, reason: 'chat' | 'saved' | 'page-change'): Promise<ApplyResult> => {
    try {
      const widget = await backend.generateWidget(id, reason)
      widgetSiteIdRef.current = siteIdRef.current
      const applied = await applyWidgetAndWait(widget)
      if (applied) {
        recordIdRef.current = widget.record_id ?? null
        saveScreenshot(widget.record_id, 'applied')
      } else {
        backend.recordError('apply', 'The page never confirmed the widget was shown')
      }
      return { applied, degraded: widget.degraded === true }
    } catch (error) {
      console.error('Unable to generate webpage interface', error)
      backend.recordError('generate', errorText(error))
      return { applied: false, degraded: false, error: errorText(error) }
    }
  }

  // Shows how generating and applying went, using doneText when it worked
  const finishWidget = (result: ApplyResult, doneText?: string) => {
    if (result.error) finishApply(false, `⚠ Couldn’t build the support (${result.error}). Try again.`)
    else if (result.degraded) finishApply(false, FAILED_WIDGET_TEXT)
    else finishApply(result.applied, result.applied ? doneText : undefined)
  }

  const refreshSavedList = async (): Promise<SavedInterface[]> => {
    try {
      const items = await backend.listSaved()
      setSavedRepresentations(items)
      return items
    } catch (error) {
      console.error('Unable to load saved interface representations', error)
      return []
    }
  }

  /*************************************************************************************************
  Page analysis
  *************************************************************************************************/

  // Reads the page and, when it's new (or forced), analyzes it into a task representation
  const analyzeCurrentSite = async (force = false, onChangeDetected?: () => void): Promise<Site> => {
    const pageResponse = await requestPageElements()
    const counts = {
      inputish: countInputish(pageResponse?.elements),
      sameOriginFrames: pageResponse?.frames?.sameOrigin ?? 0,
      elementCount: pageResponse?.elements?.length ?? 0,
    }
    lastAnalyzeAtRef.current = Date.now()
    const id = siteIdFor(pageResponse?.url)

    // skipped when the page can't be read, or hasn't changed since the last analysis
    if (!id) return { id: siteIdRef.current, hasPage: false, changed: true, ...counts }
    if (!force && id === siteIdRef.current) return { id, hasPage: true, changed: false, ...counts }

    onChangeDetected?.()
    siteIdRef.current = id
    setSiteId(id)
    setPageTitle(pageResponse?.title)
    setTaskRepresentation(undefined)

    try {
      const task = await backend.analyzePage(id, pageResponse)
      setTaskRepresentation(task)
      return { id, hasPage: true, changed: true, task, ...counts }
    } catch (error) {
      console.error('Unable to analyze page', error)
      backend.recordError('analyze', errorText(error))
      return { id, hasPage: true, changed: true, error: errorText(error), ...counts }
    }
  }

  // Retries while the page can't be read yet, then while it looks only partly loaded
  const ANALYZE_RETRY_DELAYS_MS = [500, 1200, 2500]
  const SPARSE_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000]
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
    /* Gate the chat when the page genuinely can't be read (after retries) */
    if (force || site.changed) setPageUnavailable(!site.hasPage)
    return site
  }

  const retryAnalyze = async () => {
    setReady(false)
    await analyzeCurrentSiteWithRetry(true)
    setReady(true)
  }

  // The note shown when the page was read but its analysis failed
  const analyzeFailedText = (site: Site) =>
    `I couldn't analyze this page (${site.error || 'no result'}), so suggestions won't be grounded in its real content yet.`

  /*
  Patches a page change into the task representation rather than analyzing the whole page again.
  Returns null when there's nothing to patch.
  */
  type PatchResult = { task: TaskNode; changed: boolean; addedItems: WidgetItem[] } | { error: string }
  const patchTaskRepresentation = async (change: PageChange): Promise<PatchResult | null> => {
    const id = siteIdRef.current
    if (!id || (change.added.length === 0 && change.removed.length === 0 && change.revealed.length === 0)) return null
    try {
      const { changed, added_items, ...task } = await backend.patchPage(id, change.added, change.removed, change.revealed, change.containers)
      setTaskRepresentation(task)
      lastAnalyzeAtRef.current = Date.now()
      return { task, changed: changed !== false, addedItems: Array.isArray(added_items) ? added_items : [] }
    } catch (error) {
      console.error('Unable to patch task representation', error)
      backend.recordError('patch', errorText(error))
      return { error: errorText(error) }
    }
  }

  const buildFreshIntroEntry = (savedList: SavedInterface[], note = ''): ChatEntry => {
    const savedHint = savedList.length > 0 ? ' Or pick a saved interface from the Saved tab.' : ''
    return { id: 'intro', role: 'assistant', text: `${INTRO.text}${savedHint}${note ? ` ${note}` : ''}` }
  }

  /*
  Initialized when the panel is opened: a new chat on a freshly analyzed page
  */
  useEffect(() => {
    let cancelled = false

    async function init() {
      const savedListPromise = refreshSavedList()

      // resets everything but the saved interface representations
      const resetPromise = backend.resetInterface()
        .then(() => { if (!cancelled) { setAgreed(false); agreedRef.current = false; setActiveSourceId(''); setActiveSourceName(''); setInterfaceComponent(''); setInterfaceDescription('') } })
        .catch(error => console.error('Unable to reset interface representation', error))

      const sitePromise = analyzeCurrentSiteWithRetry(true)
      const savedList = await savedListPromise
      await resetPromise
      const site = await sitePromise
      if (cancelled) return

      setTranscript([buildFreshIntroEntry(savedList, site.hasPage && !site.task ? analyzeFailedText(site) : '')])

      // removes any widget left on the page from a previous session
      pushWebpageInterface(null)
      if (!cancelled) setReady(true)
    }

    void init()
    return () => { cancelled = true }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  /*
  Re-analyzes when the active tab, its URL, or a single-page app's route changes
  */
  useEffect(() => {
    const handleTabChange = async () => {
      const site = await analyzeCurrentSiteWithRetry(false, () => setReady(false))
      if (!site.changed) return
      if (!site.hasPage) { setReady(true); return }
      if (!site.task) {
        setTranscript(current => [...current, { id: `a-analyze-err-${Date.now()}`, role: 'assistant', text: analyzeFailedText(site) }])
      }
      // a different page, so clear the widget
      pushWebpageInterface(null)
      setReady(true)
    }

    /*
    Collapses a burst of changes into one, and skips while the previous analysis is still running
    */
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
    // same webpage, but the app changed its URL (such as /apply/personal-info to /apply/education)
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
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  /*************************************************************************************************
  Page changes
  *************************************************************************************************/

  useEffect(() => {
    /*
    Applies a page change to the widget:
    1. patch the task representation (a full re-analysis if the patch fails)
    2. splice the added and removed questions into the widget on the page, which takes about a
       second rather than regenerating it
    3. regenerate the widget only when the splice can't be done
    Changes arriving meanwhile are queued and applied right after.
    */
    const processStructuralChange = async (change: PageChange) => {
      if (syncingRef.current) {
        pendingChangeRef.current = pendingChangeRef.current ? mergeChanges(pendingChangeRef.current, change) : change
        return
      }
      syncingRef.current = true
      // shows progress only when there's a widget to update; otherwise it's a silent re-analysis
      const hasWidget = widgetSiteIdRef.current === siteId
      if (hasWidget) setApplyPhase('syncing')
      try {
        let task: TaskNode | undefined
        let failure = ''
        let noRealChange = false
        let addedItems: WidgetItem[] = []
        const patched = await patchTaskRepresentation(change)
        if (patched && 'task' in patched) {
          task = patched.task
          noRealChange = !patched.changed
          addedItems = patched.addedItems
        } else {
          const site = await analyzeCurrentSite(true)
          task = site.hasPage ? site.task : undefined
          if (!task) failure = (patched && 'error' in patched ? patched.error : site.error) || 'the page could not be read'
        }
        // a task representation that missed the change is redone before the next widget
        staleTaskRepRef.current = !task

        // removals are always spliced, so a question that left the page leaves the widget too
        const canSplice = hasWidget && widgetSiteIdRef.current === siteId
        const spliced = canSplice && (addedItems.length > 0 || change.removed.length > 0)
          ? await updateWidgetItemsOnPage(noRealChange ? [] : addedItems, change.removed)
          : undefined

        const added = change.added.length + change.revealed.flat().length
        if (spliced?.ok && spliced.added + spliced.removed > 0) {
          finishApply(true, UPDATED_TEXT)
          saveScreenshot(recordIdRef.current, 'updated')
          backend.recordEvent('page change', { outcome: 'spliced', fields_added: added, fields_removed: change.removed.length, items_added: spliced.added, items_removed: spliced.removed })
        } else if (failure && hasWidget) {
          finishApply(false, `⚠ Couldn’t update the support for the page change (${failure}).`)
          backend.recordError('page change', failure)
        } else if (noRealChange || spliced?.ok) {
          if (hasWidget) setApplyPhase('idle')
          backend.recordEvent('page change', { outcome: 'no change to the interface', fields_added: added, fields_removed: change.removed.length })
        } else if (task && siteIdRef.current && widgetSiteIdRef.current === siteId) {
          finishWidget(await generateWebpageInterface(siteIdRef.current, 'page-change'), UPDATED_TEXT)
          backend.recordEvent('page change', { outcome: 'rebuilt the interface', fields_added: added, fields_removed: change.removed.length })
        } else if (hasWidget) {
          setApplyPhase('idle')
        }
      } catch (error) {
        console.error('Structural update failed', error)
        backend.recordError('page change', errorText(error))
        if (hasWidget) finishApply(false, `⚠ Couldn’t update the support for the page change (${errorText(error)}).`)
      } finally {
        syncingRef.current = false
        const pending = pendingChangeRef.current
        pendingChangeRef.current = null
        if (pending) void processStructuralChange(pending)
      }
    }

    // A brief "updated" line when an item's completion flips, at most about once a second
    const showLiveUpdate = () => {
      if (Date.now() - liveUpdateAtRef.current < 1200) return
      liveUpdateAtRef.current = Date.now()
      window.clearTimeout(liveUpdateTimerRef.current)
      liveUpdateTimerRef.current = window.setTimeout(() => {
        if (syncingRef.current || applyPhaseRef.current !== 'idle') return
        setLiveUpdate(true)
        window.setTimeout(() => setLiveUpdate(false), 1800)
      }, 900)
    }

    const stopListening = listenToPage({
      onCompletionChanged: showLiveUpdate,
      onWidgetError: (message) => backend.recordError('widget', message, 'widget'),
      onPageChanged: (change, structural, formControlsAdded) => {
        if (!siteId) return
        // a page that was nearly empty when analyzed and just filled in: analyze it again
        const repThin = (taskRepresentationRef.current?.components?.length ?? 0) < 4
        if (formControlsAdded >= 3 && repThin && Date.now() - lastAnalyzeAtRef.current > 8000) {
          void processStructuralChange({ ...change, added: [], removed: [], revealed: [] })
          return
        }
        if (structural) staleTaskRepRef.current = true
        if (structural && widgetSiteIdRef.current === siteId) void processStructuralChange(change)
      },
    })
    return () => {
      window.clearTimeout(liveUpdateTimerRef.current)
      stopListening()
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [siteId])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [transcript, isThinking, applyPhase, liveUpdate])

  /*************************************************************************************************
  Chat
  *************************************************************************************************/

  // Makes sure there's a current task representation to build the widget from
  const currentSiteForWidget = async (): Promise<string> => {
    let id = siteIdRef.current
    if (!id) {
      const site = await analyzeCurrentSiteWithRetry(true)
      id = site.hasPage && site.task ? site.id : ''
    } else if (staleTaskRepRef.current) {
      const site = await analyzeCurrentSite(true)
      if (site.hasPage && site.task) { id = site.id; staleTaskRepRef.current = false }
    }
    return id
  }

  const sendMessage = (text = message) => {
    const clean = text.trim()
    if (!clean || busy) return

    const history = transcript.map(entry => ({ role: entry.role, content: entry.text }))
    setTranscript(current => [...current.filter(e => e.id !== 'intro'), { id: `u-${current.length}-${Date.now()}`, role: 'user', text: clean }])
    setMessage('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setIsThinking(true)
    setSynced(false)

    void backend.sendChat(clean, history)
      .then(async result => {
        const pushReply = () =>
          setTranscript(current => [...current, { id: `a-${current.length}-${Date.now()}`, role: 'assistant', text: result.reply, suggestions: result.suggestions, offerSave: result.offer_save, suggestedName: result.suggested_name }])
        // once agreed, a changed tree is applied to the page
        const treeJson = result.interface_representation ? JSON.stringify(result.interface_representation) : ''
        const willApply = result.agreed && treeHasContent(result.interface_representation) && treeJson !== appliedTreeJsonRef.current
        // when applying, the reply is held back until the widget lands
        if (!willApply) pushReply()
        setSynced(true)
        setAgreed(result.agreed)
        if (result.interface_representation?.component !== undefined) setInterfaceComponent(result.interface_representation.component)
        if (result.interface_representation?.description) setInterfaceDescription(result.interface_representation.description)
        // pre-fills the Saved tab's name field
        if (result.offer_save) setSaveNameDraft(current => current || defaultSaveName(result.suggested_name))

        /*
        Thinking ends with the reply; applyPhase then shows "Applying…" until the widget lands,
        and sending is disabled meanwhile
        */
        setIsThinking(false)
        if (!willApply) return
        setApplyPhase('applying')
        const id = await currentSiteForWidget()
        if (id) {
          const applied = await generateWebpageInterface(id, 'chat')
          // recorded only once the widget lands, so a failed attempt can be retried
          if (applied.applied && !applied.degraded) appliedTreeJsonRef.current = treeJson
          pushReply()
          finishWidget(applied)
        } else {
          pushReply()
          setApplyPhase('idle')
          setTranscript(current => [...current, { id: `a-noapply-${Date.now()}`, role: 'assistant', text: "I've got the concept, but I can't read this page to show it — reload the tab and reopen this panel, then it'll apply." }])
        }
      })
      .catch(error => {
        console.error('Unable to process chat message', error)
        backend.recordError('chat', errorText(error))
        setTranscript(current => [...current, { id: `a-err-${Date.now()}`, role: 'assistant', text: `I couldn't get a reply (${errorText(error)}). Please try again.` }])
        setSynced(true)
        setIsThinking(false)
        setApplyPhase('idle')
      })
  }

  const handleRestart = () => {
    if (!window.confirm('End this chat and start over? This clears your interface preferences (shared across every site) and removes the current on-page support until you agree on something new.')) return
    void backend.resetInterface()
      .then(async () => {
        const savedList = await refreshSavedList()
        setTranscript([buildFreshIntroEntry(savedList)])
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

  const handleMessageChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(event.target.value)
    const el = event.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

  /*************************************************************************************************
  Saved interfaces
  *************************************************************************************************/

  const defaultSaveName = (suggested?: string) =>
    buildSaveName(suggested, interfaceDescription, interfaceComponent, savedRepresentations.length)

  const saveCurrentInterface = async (name: string): Promise<SavedInterface | null> => {
    if (!name.trim()) return null
    try {
      const entry = await backend.saveCurrent(name.trim())
      await refreshSavedList()
      return entry
    } catch (error) {
      console.error('Unable to save interface representation', error)
      return null
    }
  }

  const updateSavedInterface = async (id: string): Promise<boolean> => {
    try {
      await backend.updateSaved(id)
      await refreshSavedList()
      return true
    } catch (error) {
      console.error('Unable to update saved interface', error)
      return false
    }
  }

  const deleteSavedInterface = async (id: string): Promise<void> => {
    try {
      await backend.deleteSaved(id)
      await refreshSavedList()
      // deleting the entry the working tree came from only unlinks it; the tree stays
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

  /* "Update the one I'm working from", offered only when the working tree came from a saved entry */
  const handleUpdateSource = (entryId: string) => {
    if (!activeSourceId) return
    void updateSavedInterface(activeSourceId).then(ok => {
      clearOfferSave(entryId)
      if (ok) setTranscript(current => [...current, { id: `a-saved-${Date.now()}`, role: 'assistant', text: `Updated "${activeSourceName}" with these changes.` }])
    })
  }

  /* Saves the working tree as a new entry, without a model call */
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

  /*
  Makes a saved interface the working one and applies it to this page
  */
  const handleActivate = (item: SavedInterface) => {
    setApplyPhase('applying')
    void backend.activateSaved(item.id)
      .then(async payload => {
        agreedRef.current = payload.agreed
        setAgreed(payload.agreed)
        setInterfaceComponent(payload.tree?.component || '')
        setInterfaceDescription(payload.tree?.description || '')
        setActiveSourceId(item.id)
        setActiveSourceName(item.name)
        setTranscript([{ id: 'intro', role: 'assistant', text: `Switched to "${item.name}". Continue refining it, or describe something new.` }])
        setActiveTab('chat')
        if (!payload.agreed) { finishApply(true); return }
        const id = await currentSiteForWidget()
        if (!id) { finishApply(false); return }
        const applied = await generateWebpageInterface(id, 'saved')
        // recorded only once the widget lands, so a failed attempt can be retried
        if (applied.applied && !applied.degraded) appliedTreeJsonRef.current = payload.tree ? JSON.stringify(payload.tree) : ''
        finishWidget(applied)
      })
      .catch(error => {
        console.error('Unable to activate interface representation', error)
        backend.recordError('activate', errorText(error))
        finishApply(false, `⚠ Couldn’t switch to “${item.name}” (${errorText(error)}).`)
      })
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

  /*
  Title for the panel
  */
  const rawSubtitle = taskRepresentation?.page_purpose || pageTitle || siteId || 'No page analyzed'
  const subtitle = rawSubtitle.length > 64 ? `${rawSubtitle.slice(0, 63).trimEnd()}…` : rawSubtitle

  /*************************************************************************************************
  Side panel layout
  *************************************************************************************************/

  return (
    <main className="chat-app">
      <header className="chat-header">
        <div className="chat-header-identity">
          <span className="chat-avatar" aria-hidden="true"><Sparkles size={16} /></span>
          <div>
            <h1>PageAssist assistant</h1>
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

      <div className="tab-bar" role="tablist" aria-label="PageAssist views">
        <button type="button" role="tab" id="tab-chat" aria-selected={activeTab === 'chat'} aria-controls="panel-chat" onClick={() => setActiveTab('chat')}>Chat</button>
        <button type="button" role="tab" id="tab-saved" aria-selected={activeTab === 'saved'} aria-controls="panel-saved" onClick={() => setActiveTab('saved')}>Saved</button>
      </div>

      {activeTab === 'chat' ? (
        <ChatTab
          transcript={transcript}
          logRef={logRef}
          textareaRef={textareaRef}
          message={message}
          isThinking={isThinking}
          busy={busy}
          agreed={agreed}
          applyPhase={applyPhase}
          applyResultText={applyResultText}
          liveUpdate={liveUpdate}
          pageUnavailable={pageUnavailable}
          activeSourceId={activeSourceId}
          activeSourceName={activeSourceName}
          onSend={sendMessage}
          onMessageChange={handleMessageChange}
          onUpdateSource={handleUpdateSource}
          onSaveAsNew={handleSaveAsNew}
          onRetry={retryAnalyze}
          onRestart={handleRestart}
        />
      ) : (
        <SavedTab
          saved={savedRepresentations}
          search={savedSearch}
          onSearch={setSavedSearch}
          nameDraft={saveNameDraft}
          onNameDraft={setSaveNameDraft}
          saving={savingCurrent}
          onSave={handleSaveCurrent}
          onActivate={handleActivate}
          onDelete={handleDeleteSaved}
        />
      )}
    </main>
  )
}

export default App
