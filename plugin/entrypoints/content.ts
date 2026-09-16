/*
 * content.ts — the page-side agent. Injected into every tab; the only code in the extension with
 * direct access to the real page's DOM. Four jobs:
 *
 *   1. Read the page      — getPageElements() (lib/page-scan.ts) walks the DOM and returns the
 *                            elements the backend analyzes. Exposed to the panel via the
 *                            GET_PAGE_ELEMENTS message and the taskweb:inspect window event.
 *   2. Watch for change    — a MutationObserver reports when a real field enters/leaves the DOM
 *                            (never a dropdown opening or a value being typed) — the only kind of
 *                            change that should make the panel re-analyze/patch the task
 *                            representation. See handlePageChange() below.
 *   3. Host the widget     — creates a sandboxed <iframe> (entrypoints/sandbox/) and feeds it the
 *                            model-generated widget's code + state. Draws no chrome of its own.
 *   4. Keep the widget live — re-reads each tracked field's real filled/checked state on every
 *                            keystroke/click and pushes the refresh into the sandbox — no network
 *                            or model call involved. See pushLiveState()/liveifyState().
 *
 * A widget is MODEL-GENERATED CODE, not a declarative tree the host interprets: it runs inside the
 * sandboxed iframe, which has an opaque origin and is structurally unable to touch this real page's
 * DOM, cookies, storage, or network (see the frame-setup comment near ensureInterfaceFrame() below).
 * "style" (frame position/size) and "state" (what the widget is shown, including which real elements
 * it should track) stay host-owned data; "code" is everything else the model wrote.
 */
type WidgetItem = { selector?: string; selectors?: string[]; label?: string; complete?: boolean; manual?: boolean; [key: string]: unknown };
type WidgetState = { items?: WidgetItem[]; [key: string]: unknown };
type Widget = {
  style?: Record<string, unknown>;
  code?: string;
  state?: WidgetState;
};

import {
  isFillableElement,
  isDefaultProneField,
  fieldValue,
  isElementComplete,
  isItemComplete,
} from '../lib/completion';
import { computeSelector } from '../lib/selectors';
import { applyStyle } from '../lib/frame-style';
import { getPageElements, getPageText, currentFieldSet, countFrames, mutationsIncludeFieldChange } from '../lib/page-scan';
import { describeMutation } from '../lib/mutations';

/* Completion detection (isElementComplete + its helpers) lives in ../lib/completion.ts so it can be
 * unit-tested against real markup. This file keeps only the stateful click registry that feeds it. */
function isClickTrackedElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a') return true;
  const role = element.getAttribute('role');
  return role === 'button' || role === 'link' || role === 'checkbox' || role === 'switch' || role === 'menuitem';
}

/* Selectors of elements the user has clicked/activated at least once this page-view — the only signal
 * available for whether a button/link-style checklist item ("Apply", "Autofill", a dropdown option)
 * has been done, since those have no inherent "value" the way a form field does. */
const interactedSelectors = new Set<string>();
document.addEventListener('click', (event) => {
  const clickable = (event.target as Element | null)?.closest('button, a, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="menuitem"]');
  if (clickable) interactedSelectors.add(computeSelector(clickable));
}, true);

function isTrackableElement(element: Element): boolean {
  return isFillableElement(element) || isClickTrackedElement(element);
}

/* A plain selector string (e.g. "#name") can't cross a shadow-DOM or iframe boundary via
 * document.querySelector — this tries the direct lookup, then recurses through shadow roots and
 * same-origin iframes, matching what collectElementsDeep gathered, so widget items grounded in
 * those elements still resolve for live completion tracking. */
function deepQuerySelector(selector: string, root: Document | ShadowRoot = document): Element | null {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) {
      const found = deepQuerySelector(selector, element.shadowRoot);
      if (found) return found;
    }
    if (element.tagName === 'IFRAME' && !element.hasAttribute('data-taskweb-interface')) {
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

/* A widget item may track ONE control (`selector`) or several that must ALL be filled to answer one
 * question (`selectors` — first + last name, a full address). Normalize to the list form. */
function itemSelectors(item: WidgetItem): string[] {
  if (Array.isArray(item.selectors) && item.selectors.length > 0) return item.selectors.filter((s): s is string => typeof s === 'string');
  return typeof item.selector === 'string' ? [item.selector] : [];
}

/* Re-reads live DOM state for every item in a widget's state and returns it with "complete" flags
 * refreshed — read straight from the real page, never from anything the model said, so this is
 * always accurate and needs no model involvement to stay so. Any other keys the model put in state
 * (a title, custom fields, etc.) pass through untouched. */
function liveifyState(state: WidgetState | undefined, baselines?: Map<string, string>): WidgetState | undefined {
  if (!state || !Array.isArray(state.items)) return state;
  const items = state.items.map((item) => {
    /* Manual items (a recipe step, a section) have no DOM done-state — the widget owns their
     * `complete`; the host never touches it. */
    if (!item || item.manual === true) return item;
    const selectors = itemSelectors(item);
    if (selectors.length === 0) return item;
    let resolvedAny = false;
    const resolve = (selector: string) => {
      try {
        const el = deepQuerySelector(selector);
        if (el) resolvedAny = true;
        return el;
      } catch { return null; } /* invalid selector, ignore */
    };
    const complete = isItemComplete(selectors, resolve, baselines, interactedSelectors);
    return { ...item, complete: resolvedAny ? complete : (item.complete ?? false) };
  });
  return { ...state, items };
}

/* ===================================================================================================
 * Entry point — see the file header above for the four jobs this content script does.
 * =================================================================================================== */

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const root = document.documentElement;
    /* The panel force-injects this script into tabs that were already open when the extension loaded
     * (Chrome only auto-injects declared content scripts into pages that load AFTER install/reload).
     * Guard against running twice — the manifest injection and a programmatic one can both land. */
    if (root.dataset.taskwebPlugin === 'connected') return;
    root.dataset.taskwebPlugin = 'connected';

    let applyingInterface = false;
    let contextInvalidated = false;

    function teardownOnInvalidatedContext() {
      if (contextInvalidated) return;
      contextInvalidated = true;
      window.clearTimeout(mutationTimer);
      stopLiveStatePoll();
      observer.disconnect();
      document.removeEventListener('input', pushLiveState, true);
      document.removeEventListener('change', pushLiveState, true);
      document.removeEventListener('click', pushLiveState, true);
    }

    /* getPageElements / currentFieldSet / countFrames + the recursive scan live in ../lib/page-scan.ts
     * (pure DOM reads, so they can be unit-tested and reused). */

    window.addEventListener('taskweb:inspect', () => {
      window.postMessage({ source: 'taskweb-plugin', type: 'PAGE_ELEMENTS', elements: getPageElements() }, '*');
    });

    window.addEventListener('taskweb:apply-interface', (event) => {
      const widget = (event as CustomEvent).detail;
      if (widget) void applyWebpageInterface(widget); else removeWebpageInterface();
      window.postMessage({ source: 'taskweb-plugin', type: 'INTERFACE_APPLIED', widget }, '*');
    });

    function removeWebpageInterface() {
      document.querySelectorAll('[data-taskweb-interface]').forEach((element) => element.remove());
      interfaceReady = false;
      currentWidgetState = null;
      lastCompletionSignature = '';
      fieldBaselines.clear();
      stopLiveStatePoll();
    }

    /* No host-drawn chrome. The widget authors every affordance (title bar, drag handle,
     * close/collapse buttons) itself, inside the sandbox, and asks the host to act via
     * window.taskweb.* — see the 'move' / 'close' / 'setHeight' messages handled below and the API
     * in entrypoints/sandbox/main.ts. Set true once the widget has moved the frame, so later content
     * updates don't snap it back to the default corner. */
    let userPositionedFrame = false;

    /* The widget's own document is a real navigation to an extension-origin sandbox page (see
     * entrypoints/sandbox/), not srcdoc — srcdoc would inherit this host page's CSP, which on strict
     * sites can silently block the sandbox's own script with zero error signal; a real navigation
     * gets its own independent CSP instead. sandbox="allow-scripts" with no allow-same-origin gives
     * it an opaque origin: it structurally cannot reach this page's DOM, cookies, storage, or
     * navigate the top frame — that's what actually isolates model-generated code from the real
     * page, not anything in the message-passing below. */
    let interfaceReady = false;
    let interfaceReadyResolvers: Array<() => void> = [];
    let currentWidgetState: WidgetState | null = null;
    /* Value each default-prone tracked field had when the widget was applied — see isElementComplete. */
    const fieldBaselines = new Map<string, string>();

    /* Resolves true when the sandbox reports ready, false if it doesn't within the timeout (a page
     * CSP blocked the sandbox script, the extension URL failed to resolve, etc.) — so
     * applyWebpageInterface can report failure instead of hanging. */
    function waitForInterfaceReady(timeoutMs = 8000): Promise<boolean> {
      if (interfaceReady) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => resolve(false), timeoutMs);
        interfaceReadyResolvers.push(() => { window.clearTimeout(timer); resolve(true); });
      });
    }

    /* Tell the side panel whether the widget actually made it onto the page, so its "Applying…"
     * indicator can track reality instead of a fixed timer. */
    function reportApplyOutcome(ok: boolean) {
      try {
        globalThis.chrome?.runtime?.sendMessage({ source: 'taskweb-plugin', type: 'WEBPAGE_INTERFACE_APPLIED', ok })?.catch(() => {});
      } catch (_) { /* extension context gone */ }
    }

    /* Auto-fit the frame height to the sandbox's reported content height, unless the widget has
     * pinned an explicit height via window.taskweb.setHeight(). */
    function applySandboxResize(frame: HTMLIFrameElement, height: number) {
      if (frame.dataset.taskwebExplicitHeight === 'true') return;
      const capped = Math.min(Math.max(Math.round(height) + 8, 40), window.innerHeight * 0.7);
      frame.style.height = `${capped}px`;
    }

    /* Nudge the frame by a pixel delta the widget streams during its own drag gesture. First call
     * converts the corner-docked frame to left/top so deltas accumulate. */
    function moveFrame(frame: HTMLIFrameElement, dx: number, dy: number) {
      const rect = frame.getBoundingClientRect();
      if (!userPositionedFrame) {
        frame.style.left = `${rect.left}px`;
        frame.style.top = `${rect.top}px`;
        frame.style.right = '';
        frame.style.bottom = '';
        userPositionedFrame = true;
      }
      frame.style.left = `${rect.left + dx}px`;
      frame.style.top = `${rect.top + dy}px`;
    }

    /*
     * Authenticates by event.source (the exact Window that sent it) rather than event.origin — an
     * opaque origin has no origin string worth checking, it reports as "null". Message protocol from
     * the sandbox:
     *   - sandbox-ready      : listener is live, safe to post 'init'
     *   - resize {height}    : content height changed -> auto-fit the frame
     *   - move {dx, dy}      : widget-authored drag -> nudge the frame
     *   - setHeight {height} : widget pins the frame height
     *   - resetHeight        : widget releases the pin (back to auto-fit)
     *   - close              : widget-authored dismiss -> tear the widget down
     *   - error {message}    : widget code threw
     */
    window.addEventListener('message', (event) => {
      const frame = document.querySelector('iframe[data-taskweb-interface]') as HTMLIFrameElement | null;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { source?: string; type?: string; height?: number; dx?: number; dy?: number; message?: string } | null;
      if (!data || data.source !== 'taskweb-sandbox') return;
      if (data.type === 'sandbox-ready') {
        interfaceReady = true;
        const resolvers = interfaceReadyResolvers;
        interfaceReadyResolvers = [];
        resolvers.forEach((resolve) => resolve());
      } else if (data.type === 'resize' && typeof data.height === 'number') {
        applySandboxResize(frame, data.height);
      } else if (data.type === 'move' && typeof data.dx === 'number' && typeof data.dy === 'number') {
        moveFrame(frame, data.dx, data.dy);
      } else if (data.type === 'setHeight' && typeof data.height === 'number') {
        frame.dataset.taskwebExplicitHeight = 'true';
        frame.style.height = `${Math.max(0, Math.round(data.height))}px`;
      } else if (data.type === 'resetHeight') {
        frame.dataset.taskwebExplicitHeight = 'false';
      } else if (data.type === 'close') {
        removeWebpageInterface();
      } else if (data.type === 'error') {
        console.error('TaskWeb: widget code errored:', data.message);
      }
    });

    function ensureInterfaceFrame(): HTMLIFrameElement {
      const existing = document.querySelector('iframe[data-taskweb-interface]') as HTMLIFrameElement | null;
      if (existing) return existing;

      userPositionedFrame = false;
      interfaceReady = false;
      const frame = document.createElement('iframe');
      frame.setAttribute('data-taskweb-interface', 'true');
      frame.setAttribute('title', 'TaskWeb interface support');
      frame.setAttribute('sandbox', 'allow-scripts');
      Object.assign(frame.style, {
        position: 'fixed', zIndex: '2147483646', border: '0', background: 'transparent',
        colorScheme: 'light',
      });
      const sandboxUrl = globalThis.chrome?.runtime?.getURL?.('sandbox.html');
      if (sandboxUrl) {
        frame.src = sandboxUrl;
      } else {
        console.error('TaskWeb: could not resolve the widget sandbox page URL');
      }
      document.body.appendChild(frame);
      return frame;
    }

    async function applyWebpageInterface(widget: Widget | null | undefined) {
      if (!widget) { removeWebpageInterface(); reportApplyOutcome(true); return; }
      applyingInterface = true;

      const frame = ensureInterfaceFrame();
      const ready = await waitForInterfaceReady();
      if (!document.body.contains(frame)) { applyingInterface = false; reportApplyOutcome(false); return; } /* dismissed while waiting */
      if (!ready) { applyingInterface = false; reportApplyOutcome(false); return; } /* sandbox never came up */

      const style = widget.style || {};
      applyStyle(frame, style);
      frame.dataset.taskwebExplicitHeight = style.height ? 'true' : 'false';
      /* Once the user has dragged the widget, leave its position alone on later content updates
       * rather than snapping it back to the default corner — dragging should stick until the widget
       * itself is torn down (a genuinely new task/site) and recreated. */
      if (!userPositionedFrame) {
        if (!style.top && !style.bottom) frame.style.bottom = frame.style.bottom || '20px';
        if (!style.left && !style.right) frame.style.right = frame.style.right || '20px';
      }
      if (!style.width) frame.style.width = frame.style.width || '300px';
      if (!style.height && !frame.style.height) frame.style.height = '160px'; /* provisional, until the sandbox reports its real content height */

      /* Snapshot the starting value of each default-prone field so a real default doesn't read as input. */
      fieldBaselines.clear();
      for (const item of (widget.state?.items ?? [])) {
        if (!item) continue;
        for (const selector of itemSelectors(item)) {
          let el: Element | null = null;
          try { el = deepQuerySelector(selector); } catch { /* invalid selector */ }
          if (el && isDefaultProneField(el)) fieldBaselines.set(selector, fieldValue(el));
        }
      }

      currentWidgetState = liveifyState(widget.state ? structuredClone(widget.state) : { items: [] }, fieldBaselines) || { items: [] };
      frame.contentWindow?.postMessage({ type: 'init', code: widget.code || '', state: currentWidgetState }, '*');
      lastCompletionSignature = completionSignature(currentWidgetState);  /* baseline — don't notify for it */
      startLiveStatePoll();

      applyingInterface = false;
      reportApplyOutcome(true);

      /* handlePageChange early-returns while applyingInterface is true, so any field revealed DURING
       * the (up to 8s) sandbox-ready wait left no mutation record. Re-diff the field set now against
       * the pre-apply snapshot so such a reveal still forwards as a structural change. */
      handlePageChange([]);
    }

    /* Cheap and instant (no network/model call) — re-reads live DOM state for whatever items the
     * current widget cares about and pushes the refreshed state into the sandbox, which re-runs its
     * own render(state). This is what makes a checklist reflect real completion without the model
     * ever having to compute or represent that itself. */
    let lastCompletionSignature = '';
    function completionSignature(state: WidgetState | null): string {
      if (!state || !Array.isArray(state.items)) return '';
      return state.items.map((item) => (item && item.complete ? '1' : '0')).join('');
    }
    function pushLiveState() {
      if (!currentWidgetState || !interfaceReady) return;
      const frame = document.querySelector('iframe[data-taskweb-interface]') as HTMLIFrameElement | null;
      if (!frame) return;
      currentWidgetState = liveifyState(currentWidgetState, fieldBaselines) || currentWidgetState;
      frame.contentWindow?.postMessage({ type: 'state', state: currentWidgetState }, '*');
      /* Tell the panel when a completion flag actually flipped, so it can show a brief "updated" note. */
      const signature = completionSignature(currentWidgetState);
      if (lastCompletionSignature !== '' && signature !== lastCompletionSignature) {
        try {
          globalThis.chrome?.runtime?.sendMessage({ source: 'taskweb-plugin', type: 'WIDGET_STATE_CHANGED' })?.catch(() => {});
        } catch (_) { /* extension context gone */ }
      }
      lastCompletionSignature = signature;
    }

    /* Custom widgets (react-select dropdowns, segmented toggles) update via framework state without
     * firing native input/change events, so the listeners below never see them. The MutationObserver
     * does — hook a debounced re-check to it — plus a slow safety-net poll while a widget is shown. */
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

    let mutationTimer: number | undefined;
    let mutationsPendingSince = 0;
    let pendingMutations: MutationRecord[] = [];
    let lastFieldSet: Set<string> | undefined; /* field-ish selectors from the previous page snapshot */
    const MUTATION_DEBOUNCE_MS = 400;
    const MUTATION_MAX_WAIT_MS = 2500; /* force-fire even if churn never leaves a quiet window */

    /* getSelector / containsFormControl / describeMutation live in ../lib/mutations.ts. */

    function handlePageChange(mutations: MutationRecord[] = []) {
      if (applyingInterface || contextInvalidated) return;
      pendingMutations.push(...mutations);

      /* Trailing debounce (collapse a burst into one send) BUT with a max-wait ceiling: continuous
       * unrelated DOM churn nearby (an ad, a polling widget, a "typing…" indicator) never leaves a
       * quiet MUTATION_DEBOUNCE_MS window, which would otherwise starve real updates forever. */
      const now = Date.now();
      if (!mutationTimer) mutationsPendingSince = now;
      window.clearTimeout(mutationTimer);
      const wait = now - mutationsPendingSince >= MUTATION_MAX_WAIT_MS ? 0 : MUTATION_DEBOUNCE_MS;
      mutationTimer = window.setTimeout(() => {
        mutationTimer = undefined;
        const pageElements = getPageElements();
        const activeElement = document.activeElement;
        const described = pendingMutations.slice(0, 100).map(describeMutation);
        /* "Structural" = the field-ish set changed vs. the last snapshot (see currentFieldSet). The
         * snapshot is seeded at startup and again after each widget apply, so the very first real
         * change after a page settles is diffed against a genuine baseline rather than always
         * reading as 0. */
        const currentFields = currentFieldSet(pageElements);
        const addedSelectors: string[] = [];
        const removedSelectors: string[] = [];
        if (lastFieldSet) {
          currentFields.forEach((s) => { if (!lastFieldSet!.has(s)) addedSelectors.push(s); });
          lastFieldSet.forEach((s) => { if (!currentFields.has(s)) removedSelectors.push(s); });
        }
        lastFieldSet = currentFields;
        const structural = addedSelectors.length + removedSelectors.length >= 1;
        /* The actual added field descriptors, so the panel can PATCH the task representation
         * (splice in just these) instead of re-modelling the whole page. */
        const addedSet = new Set(addedSelectors);
        const addedFields = pageElements.filter((e) => addedSet.has(e.selector)).slice(0, 25);
        const event = {
          type: 'page.changed',
          url: location.href,
          structural,
          fieldsAdded: addedSelectors.length,
          fieldsRemoved: removedSelectors.length,
          addedFields,
          removedFields: removedSelectors.slice(0, 25),
          target: {
            title: document.title,
            forms: document.forms.length,
            selector: activeElement?.id ? `#${activeElement.id}` : activeElement?.tagName?.toLowerCase(),
          },
          payload: { elements: pageElements.length, mutations: described },
        };
        pendingMutations = [];
        if (globalThis.chrome?.runtime?.sendMessage) {
          try {
            /* Manifest V3's sendMessage returns a promise when called without a callback; it rejects
             * ("Could not establish connection") whenever no extension page has a listener open right
             * now (e.g. the side panel isn't open on this tab) — confirmed live as an unhandled
             * rejection on every page interaction, on every site, regardless of whether the extension
             * is in use. That's an expected, benign case here, not a real failure. */
            globalThis.chrome.runtime.sendMessage({ source: 'taskweb-plugin', type: 'PAGE_CHANGED', event })?.catch(() => {});
          } catch (_) {
            /* The extension was reloaded/updated while this page was already open; stop trying. */
            teardownOnInvalidatedContext();
          }
        }
        window.postMessage({ source: 'taskweb-plugin', type: 'PAGE_CHANGED', event }, '*');
      }, wait);
    }

    /* The widget's own content lives inside its sandboxed iframe's separate (opaque-origin) document,
     * invisible to this observer by construction — so its own updates can never self-trigger a "page
     * changed" loop. The one exception is the iframe element itself being inserted into the host
     * page, which the closest('[data-taskweb-interface]') checks below still exclude. */
    const observer = new MutationObserver((mutations) => {
      const changedOutsideInterface = mutations.some((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-tw-ref') return false; /* our own stamping */

        const targetElement = mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target;
        const target = targetElement instanceof Element ? targetElement : null;
        const addedOutsideInterface = [...mutation.addedNodes].some((node) => {
          return node.nodeType !== Node.ELEMENT_NODE || !(node as Element).closest('[data-taskweb-interface]');
        });
        const removedOutsideInterface = [...mutation.removedNodes].some((node) => {
          return node.nodeType !== Node.ELEMENT_NODE || !(node as Element).closest('[data-taskweb-interface]');
        });
        return !target?.closest('[data-taskweb-interface]') && (addedOutsideInterface || removedOutsideInterface || mutation.type === 'attributes');
      });
      const hasTextChange = mutations.some((mutation) => mutation.type === 'characterData');
      if (changedOutsideInterface || hasTextChange) {
        /* Structural pipeline ONLY when a real field element actually entered or left the DOM — NOT
         * when an existing control merely expands/collapses (opening a react-select adds only
         * listbox/option nodes, which this ignores). That misfire used to consume the debounce
         * window so the real follow-up field's reveal never registered as structural. */
        if (mutationsIncludeFieldChange(mutations)) {
          handlePageChange(mutations); /* 400ms-debounced -> backend (possible structural regeneration) */
        }
        scheduleLiveState();           /* 200ms-debounced -> local re-check of completion flags (always) */
      }
    });

    /* Wires the MutationObserver above into the real document plus every reachable same-origin
     * shadow root / iframe — anything that isn't the widget's own sandboxed iframe. */
    function observeRoot(rootNode: Document | ShadowRoot) {
      observer.observe(rootNode, { childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
      rootNode.querySelectorAll?.('*').forEach((element) => {
        if (element.shadowRoot) observeRoot(element.shadowRoot);
        if (element.tagName === 'IFRAME' && !element.hasAttribute('data-taskweb-interface')) {
          try {
            const frameDocument = (element as HTMLIFrameElement).contentDocument;
            if (frameDocument) observeRoot(frameDocument);
          } catch (_) {
            /* Cross-origin frames cannot be observed by the content script. */
          }
        }
      });
    }

    observeRoot(document);
    /* Seed the structural-change baseline immediately, so the first field the page reveals after it
     * settles is diffed against a real snapshot instead of establishing one (and reading as "no
     * change"). */
    lastFieldSet = currentFieldSet();
    document.querySelectorAll('iframe').forEach((frame) => frame.addEventListener('load', () => {
      try {
        if (frame.contentDocument) observeRoot(frame.contentDocument);
      } catch (_) {
        /* Cross-origin frames cannot be observed by the content script. */
      }
    }));
    /* Structural detection is driven ONLY by the MutationObserver above (a field entering/leaving
     * the DOM is always a mutation). It used to ALSO run on every input/change/click, which meant a
     * plain click — opening a dropdown, focusing a field — kicked off a page scan + PAGE_CHANGED
     * every time. These listeners only refresh live completion state, which is cheap and has no
     * network call. */
    document.addEventListener('input', pushLiveState, true);
    document.addEventListener('change', pushLiveState, true);
    document.addEventListener('click', pushLiveState, true);

    try {
      globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
        if (message?.type === 'APPLY_WEBPAGE_INTERFACE') {
          void applyWebpageInterface(message.tree);
          sendResponse({ ok: true });
        } else if (message?.type === 'GET_PAGE_ELEMENTS') {
          sendResponse({ url: location.href, title: document.title, elements: getPageElements(), pageText: getPageText(), frames: countFrames() });
        }
      });
    } catch (_) {
      teardownOnInvalidatedContext();
    }

    window.postMessage({ source: 'taskweb-plugin', type: 'READY', url: location.href }, '*');
  },
});
