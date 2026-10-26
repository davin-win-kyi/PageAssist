/*
The following file does the following:

1. Read the page - walks the DOM and gets the elements (page-scan.ts)
2. Watches for changes with a MutationObserver (mutations.ts)
3. Creates the sandboxed <iframe> and feeds it the model-generated widget code (interface-frame.ts)
4. keeping the widget in sync with the page, without the model once the widget is built

Note: the widget is model generated code and is not a declarative tree the host interprets
and runs within the sandboxed iframe and cannot touch the actual webpage
*/

import { isDefaultProneField, fieldValue, recordInitialValues, isItemComplete, isActionElement, answeringElement } from '../lib/completion';
import { scanPage, getPageText, countFrames, uploadGroupOf, type FieldSnapshot } from '../lib/page-scan';
import { changedOutsideInterface, mutationsIncludeFieldChange, buildPageChangeEvent, observeTree } from '../lib/mutations';
import { itemSelectors, nonAnswerMembers, isItemRequired, spliceWidgetItems, type WidgetItem } from '../lib/widget-items';
import { createInterfaceFrame } from '../lib/interface-frame';

type WidgetState = { items?: WidgetItem[]; [key: string]: unknown };
type Widget = {
  style?: Record<string, unknown>;
  code?: string;
  state?: WidgetState;
};

/*************************************************************************************************
Finding tracked elements
*************************************************************************************************/

/*
Fields the user has visited (focused, then left), so a default they kept counts as their answer
*/
const visitedFields = new WeakSet<Element>();
document.addEventListener('focusout', (event) => {
  const field = event.target as Element | null;
  if (field instanceof Element && isDefaultProneField(field)) visitedFields.add(field);
}, true);

/*
Doesn't just do a selector search, but also checks the shadow DOM and same-origin iframes as well
*/
function deepQuerySelector(selector: string, root: Document | ShadowRoot = document): Element | null {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) {
      const found = deepQuerySelector(selector, element.shadowRoot);
      if (found) return found;
    }
    if (element.tagName === 'IFRAME' && !element.hasAttribute('data-pageassist-interface')) {
      let frameDoc: Document | null = null;
      try { frameDoc = (element as HTMLIFrameElement).contentDocument; } catch { /* cross-origin */ }
      if (frameDoc) {
        const found = deepQuerySelector(selector, frameDoc);
        if (found) return found;
      }
    }
  }
  return null;
}

// A selector that can't be resolved, or isn't valid CSS, reads as "not on the page"
function resolveSelector(selector: string): Element | null {
  try { return deepQuerySelector(selector); } catch { return null; }
}

/*
Two cases dealt with
1. when uploading a file removes its input, the question's wrapper stands in for it
2. a line of text bundled into an item, which can never be filled out, is left out
*/
const uploadGroups = new Map<string, Element>();
const nonAnswer = new Set<string>();
function settleItems(items: WidgetItem[]) {
  for (const item of items) {
    if (!item || item.manual === true) continue;
    const selectors = itemSelectors(item);
    for (const selector of selectors) {
      const element = resolveSelector(selector);
      const group = element ? uploadGroupOf(element) : null;
      if (group) uploadGroups.set(selector, group);
    }
    nonAnswerMembers(selectors, resolveSelector).forEach((selector) => nonAnswer.add(selector));
  }
}
function resolveTracked(selector: string): Element | null {
  const element = resolveSelector(selector);
  if (element) return element;
  const group = uploadGroups.get(selector);
  return group?.isConnected ? group : null;
}

/*
Re-reads the complete and required states of each grounded item from the page. An item on
actions only, like a submit button, is left as it is: nothing on the page shows it as done.
*/
function liveifyState(state: WidgetState | undefined, baselines?: Map<string, string>): WidgetState | undefined {
  if (!state || !Array.isArray(state.items)) return state;
  const items = state.items.map((item) => {
    if (!item || item.manual === true) return item;
    const selectors = itemSelectors(item);
    if (selectors.length === 0) return item;
    const resolved = new Map<string, Element | null>();
    const resolve = (selector: string) => {
      if (!resolved.has(selector)) resolved.set(selector, resolveTracked(selector));
      return resolved.get(selector) ?? null;
    };
    const found = selectors.map(resolve).filter((element): element is Element => !!element);
    if (found.length === 0) return { ...item, complete: item.complete ?? false };
    if (found.every(isActionElement)) return item;
    const answering = selectors.filter((selector) => !nonAnswer.has(selector));
    return {
      ...item,
      complete: isItemComplete(answering.length > 0 ? answering : selectors, resolve, baselines, visitedFields),
      required: isItemRequired(selectors, resolve) || item.required === true,
    };
  });
  return { ...state, items };
}

// Sends to the side panel. It rejects when no panel is listening, which is expected.
function sendToPanel(message: Record<string, unknown>) {
  globalThis.chrome?.runtime?.sendMessage({ source: 'pageassist-plugin', ...message })?.catch(() => {});
}

/*************************************************************************************************
The 4 tasks mentioned above
*************************************************************************************************/

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    /*
    The script can be injected into an already open tab, so a stamp keeps it from running twice
    */
    const root = document.documentElement;
    if (root.dataset.pageassistPlugin === 'connected') return;
    root.dataset.pageassistPlugin = 'connected';

    const frames = createInterfaceFrame(document);
    let applyingInterface = false;
    let contextInvalidated = false;

    // The extension was reloaded while this page was open, so stop everything
    function teardownOnInvalidatedContext() {
      if (contextInvalidated) return;
      contextInvalidated = true;
      window.clearTimeout(mutationTimer);
      stopLiveStatePoll();
      observer.disconnect();
      for (const type of ['input', 'change', 'click', 'focusout']) document.removeEventListener(type, pushLiveState, true);
    }

    window.addEventListener('pageassist:inspect', () => {
      const { elements, containers } = scanPage();
      window.postMessage({ source: 'pageassist-plugin', type: 'PAGE_ELEMENTS', elements, containers }, '*');
    });

    window.addEventListener('pageassist:apply-interface', (event) => {
      const widget = (event as CustomEvent).detail;
      if (widget) void applyWebpageInterface(widget); else removeWebpageInterface();
      window.postMessage({ source: 'pageassist-plugin', type: 'INTERFACE_APPLIED', widget }, '*');
    });

    /*******************************************************************************************
    Applying the widget
    *******************************************************************************************/

    let interfaceReady = false;
    let interfaceReadyResolvers: Array<() => void> = [];
    let currentWidgetState: WidgetState | null = null;

    /*
    Starting values of default-prone fields, and the baseline each tracked item is compared to
    */
    const initialValues = new WeakMap<Element, string>();
    const fieldBaselines = new Map<string, string>();

    function removeWebpageInterface() {
      frames.endDrag();
      document.querySelectorAll('[data-pageassist-interface]').forEach((element) => element.remove());
      interfaceReady = false;
      currentWidgetState = null;
      lastCompletionSignature = '';
      lastPostedState = '';
      fieldBaselines.clear();
      stopLiveStatePoll();
    }

    function waitForInterfaceReady(timeoutMs = 8000): Promise<boolean> {
      if (interfaceReady) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => resolve(false), timeoutMs);
        interfaceReadyResolvers.push(() => { window.clearTimeout(timer); resolve(true); });
      });
    }

    // Tells the side panel whether the widget actually made it onto the page
    function reportApplyOutcome(ok: boolean) {
      try { sendToPanel({ type: 'WEBPAGE_INTERFACE_APPLIED', ok }); } catch { /* invalidated context */ }
    }

    /*
    Messages from the sandbox: frame requests go to interface-frame.ts, the rest are handled here
    */
    window.addEventListener('message', (event) => {
      const frame = frames.current();
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { source?: string; type?: string; message?: string } | null;
      if (!data || data.source !== 'pageassist-sandbox') return;
      if (frames.handleMessage(frame, data)) return;
      if (data.type === 'sandbox-ready') {
        interfaceReady = true;
        const resolvers = interfaceReadyResolvers;
        interfaceReadyResolvers = [];
        resolvers.forEach((resolve) => resolve());
      } else if (data.type === 'close') {
        removeWebpageInterface();
      } else if (data.type === 'error') {
        console.error('PageAssist: widget code errored:', data.message);
        // the panel keeps it in the study records
        try { sendToPanel({ type: 'WIDGET_ERROR', message: String(data.message ?? '') }); } catch { /* invalidated context */ }
      }
    });

    /*
    Applies one widget at a time, in the order they arrive
    */
    let applyQueue: Promise<void> = Promise.resolve();
    function applyWebpageInterface(widget: Widget | null | undefined): Promise<void> {
      applyQueue = applyQueue.then(() => applyNow(widget)).catch((error) => console.error('PageAssist: applying the widget failed', error));
      return applyQueue;
    }

    async function applyNow(widget: Widget | null | undefined) {
      if (!widget) { removeWebpageInterface(); reportApplyOutcome(true); return; }
      applyingInterface = true;

      // a new frame, or a fresh sandbox in the current one, so no earlier widget is left running
      let frame = frames.current();
      interfaceReady = false;
      if (frame) frames.reload(frame);
      else frame = frames.create();
      const ready = await waitForInterfaceReady();
      if (!document.body.contains(frame) || !ready) { applyingInterface = false; reportApplyOutcome(false); return; }

      frames.place(frame, widget.style || {});

      fieldBaselines.clear();
      uploadGroups.clear();
      nonAnswer.clear();
      recordBaselines(widget.state?.items ?? []);
      settleItems(widget.state?.items ?? []);

      currentWidgetState = liveifyState(widget.state ? structuredClone(widget.state) : { items: [] }, fieldBaselines) || { items: [] };
      frame.contentWindow?.postMessage({ type: 'init', code: widget.code || '', state: currentWidgetState }, '*');
      lastPostedState = JSON.stringify(currentWidgetState);
      lastCompletionSignature = completionSignature(currentWidgetState);
      startLiveStatePoll();

      applyingInterface = false;
      reportApplyOutcome(true);
      // a page change during the apply was skipped, so check once now
      handlePageChange([]);
    }

    function recordBaselines(items: WidgetItem[]) {
      for (const item of items) {
        if (!item) continue;
        for (const selector of itemSelectors(item)) {
          const resolved = resolveSelector(selector);
          // a label is compared by the control it names
          const el = resolved ? answeringElement(resolved) : null;
          if (el && isDefaultProneField(el)) fieldBaselines.set(selector, initialValues.get(el) ?? fieldValue(el));
        }
      }
    }

    /*
    Splices added and removed questions into the widget already showing, without regenerating it
    */
    function updateWidgetItems(add: WidgetItem[], remove: string[]): { ok: boolean; added: number; removed: number } {
      const frame = frames.current();
      const items = currentWidgetState?.items;
      if (!frame || !interfaceReady || !currentWidgetState || !Array.isArray(items)) return { ok: false, added: 0, removed: 0 };
      const tracksPage = items.some((item) => item && !item.manual && itemSelectors(item).length > 0);
      if (!tracksPage && add.length > 0) return { ok: false, added: 0, removed: 0 };
      const result = spliceWidgetItems(items, add, remove, resolveSelector);
      if (result.added === 0 && result.removed === 0) return { ok: true, added: 0, removed: 0 };
      recordBaselines(result.items);
      settleItems(result.items);
      currentWidgetState = liveifyState({ ...currentWidgetState, items: result.items }, fieldBaselines) || currentWidgetState;
      frame.contentWindow?.postMessage({ type: 'state', state: currentWidgetState }, '*');
      lastPostedState = JSON.stringify(currentWidgetState);
      // the panel reports this update itself
      lastCompletionSignature = completionSignature(currentWidgetState);
      return { ok: true, added: result.added, removed: result.removed };
    }

    /*******************************************************************************************
    Live completion
    *******************************************************************************************/

    /*
    Re-reads the page for the widget's items and pushes the new state into the sandbox, which
    re-runs its render(state). No model call.
    */
    let lastCompletionSignature = '';
    let lastPostedState = '';
    function completionSignature(state: WidgetState | null): string {
      if (!state || !Array.isArray(state.items)) return '';
      return state.items.map((item) => (item && item.complete ? '1' : '0')).join('');
    }
    function pushLiveState() {
      if (!currentWidgetState || !interfaceReady) return;
      const frame = frames.current();
      if (!frame) return;
      currentWidgetState = liveifyState(currentWidgetState, fieldBaselines) || currentWidgetState;
      // re-render only when something actually changed
      const posted = JSON.stringify(currentWidgetState);
      if (posted === lastPostedState) return;
      lastPostedState = posted;
      frame.contentWindow?.postMessage({ type: 'state', state: currentWidgetState }, '*');

      // tells the panel when an item's completion flips
      const signature = completionSignature(currentWidgetState);
      if (lastCompletionSignature !== '' && signature !== lastCompletionSignature) {
        try { sendToPanel({ type: 'WIDGET_STATE_CHANGED' }); } catch { /* invalidated context */ }
      }
      lastCompletionSignature = signature;
    }

    /*
    Custom widgets change through framework state without input or change events, so mutations
    also trigger a re-check, plus a slow poll while a widget is shown
    */
    let liveStateTimer: number | undefined;
    let liveStatePoll: number | undefined;
    function scheduleLiveState() {
      window.clearTimeout(liveStateTimer);
      liveStateTimer = window.setTimeout(pushLiveState, 200);
    }
    function startLiveStatePoll() {
      window.clearInterval(liveStatePoll);
      liveStatePoll = window.setInterval(pushLiveState, 2000);
    }
    function stopLiveStatePoll() {
      window.clearTimeout(liveStateTimer);
      window.clearInterval(liveStatePoll);
    }

    /*******************************************************************************************
    Page changes
    *******************************************************************************************/

    let mutationTimer: number | undefined;
    let mutationsPendingSince = 0;
    let pendingMutations: MutationRecord[] = [];
    // the page's questions as of the previous scan
    let lastFieldSnapshot: FieldSnapshot | undefined;
    const MUTATION_DEBOUNCE_MS = 400;
    // fires anyway if the page never goes quiet
    const MUTATION_MAX_WAIT_MS = 2500;

    /*
    Debounces a burst of mutations into one scan, then sends the page-change event to the panel
    */
    function handlePageChange(mutations: MutationRecord[] = []) {
      if (applyingInterface || contextInvalidated) return;
      pendingMutations.push(...mutations);
      const now = Date.now();
      if (!mutationTimer) mutationsPendingSince = now;
      window.clearTimeout(mutationTimer);
      const wait = now - mutationsPendingSince >= MUTATION_MAX_WAIT_MS ? 0 : MUTATION_DEBOUNCE_MS;
      mutationTimer = window.setTimeout(() => {
        mutationTimer = undefined;
        const { event, fields } = buildPageChangeEvent(scanPage(), lastFieldSnapshot, pendingMutations);
        lastFieldSnapshot = fields;
        pendingMutations = [];
        try {
          sendToPanel({ type: 'PAGE_CHANGED', event });
        } catch {
          teardownOnInvalidatedContext();
        }
        window.postMessage({ source: 'pageassist-plugin', type: 'PAGE_CHANGED', event }, '*');
      }, wait);
    }

    const observer = new MutationObserver((mutations) => {
      // a field that just appeared hasn't been touched yet, so record its starting value now
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => { if (node.nodeType === Node.ELEMENT_NODE) recordInitialValues(node as Element, initialValues); });
      }
      if (!changedOutsideInterface(mutations)) return;
      if (mutationsIncludeFieldChange(mutations)) handlePageChange(mutations);
      scheduleLiveState();
    });

    // watches the page, its shadow roots and its iframes, recording each field's starting value
    observeTree(observer, document, (rootNode) => recordInitialValues(rootNode, initialValues));
    // the first snapshot, so the first question the page reveals is diffed against a real one
    lastFieldSnapshot = scanPage().fields;

    /*
    Refresh live completion. focusout covers a default the user kept as their answer.
    */
    for (const type of ['input', 'change', 'click', 'focusout']) document.addEventListener(type, pushLiveState, true);

    /*
    Messages from the side panel
    - apply the webpage interface
    - splice an update into the interface
    - where the interface is, for a screenshot of it
    - get the page elements on the current page
    */
    try {
      globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
        if (message?.type === 'APPLY_WEBPAGE_INTERFACE') {
          void applyWebpageInterface(message.tree);
          sendResponse({ ok: true });
        } else if (message?.type === 'UPDATE_WIDGET_ITEMS') {
          sendResponse(updateWidgetItems(Array.isArray(message.add) ? message.add : [], Array.isArray(message.remove) ? message.remove : []));
        } else if (message?.type === 'GET_INTERFACE_RECT') {
          // where the widget is, so the panel can screenshot just the widget for the records
          const box = frames.current()?.getBoundingClientRect();
          sendResponse(box ? { left: box.left, top: box.top, width: box.width, height: box.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight } : null);
        } else if (message?.type === 'GET_PAGE_ELEMENTS') {
          const { elements, containers } = scanPage();
          sendResponse({ url: location.href, title: document.title, elements, containers, pageText: getPageText(), frames: countFrames() });
        }
      });
    } catch {
      teardownOnInvalidatedContext();
    }

    window.postMessage({ source: 'pageassist-plugin', type: 'READY', url: location.href }, '*');
  },
});
