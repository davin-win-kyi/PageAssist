// A widget is now MODEL-GENERATED CODE, not a declarative tree the host interprets — it executes inside
// a sandboxed iframe (see entrypoints/sandbox/) with an opaque origin, structurally unable to touch this
// real page's DOM, cookies, storage, or network. "style" (position/size only) and "items" (what real
// elements the widget cares about) stay host-owned data, same spirit as before; "code" is everything else.
type WidgetItem = { selector: string; label?: string; complete?: boolean; [key: string]: unknown };
type WidgetState = { items?: WidgetItem[]; [key: string]: unknown };
type Widget = {
  style?: Record<string, unknown>;
  code?: string;
  state?: WidgetState;
};

// Blocks constructs that could load external resources or execute code through CSS — a security
// boundary, not a restriction on which properties/values are allowed. Any ordinary CSS is otherwise
// applied exactly as authored. (The widget's own internal styling now lives in its generated code and
// runs inside the sandbox instead — this is only ever applied to the host-owned frame's position/size.)
function isSafeStyleValue(value: string): boolean {
  const lower = value.toLowerCase();
  return !lower.includes('url(') && !lower.includes('expression(') && !lower.includes('javascript:') && !lower.includes('@import');
}

function applyStyle(element: HTMLElement, style: Record<string, unknown> | undefined) {
  if (!style) return;
  for (const [property, value] of Object.entries(style)) {
    if (typeof value !== 'string' || !isSafeStyleValue(value)) continue;
    try {
      element.style.setProperty(property, value);
    } catch {
      // Not a valid CSS property name/value — ignore rather than fail the whole render.
    }
  }
}

// Selector computation used consistently everywhere a real element needs one: gathering page elements,
// tracking what's been clicked, and grounding a widget item — so all three always agree.
function computeSelector(element: Element): string {
  const testId = element.getAttribute('data-testid');
  const ariaLabel = element.getAttribute('aria-label');
  if ((element as HTMLElement).id) return `#${(element as HTMLElement).id}`;
  if (testId) return `[data-testid="${testId}"]`;
  if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
  return element.tagName.toLowerCase();
}

// ARIA role: explicit role= if present, else the implicit role for the tag / input type. Empty string
// when there's no meaningful role. Lets the task representation reason about semantics, not just tags.
const INPUT_TYPE_ROLE: Record<string, string> = {
  checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  email: 'textbox', tel: 'textbox', url: 'textbox', text: 'textbox', password: 'textbox',
  submit: 'button', button: 'button', reset: 'button',
};
function computeRole(element: Element): string {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit.trim();
  const tag = element.tagName.toLowerCase();
  if (tag === 'a') return element.hasAttribute('href') ? 'link' : '';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') return INPUT_TYPE_ROLE[(element.getAttribute('type') || 'text').toLowerCase()] || '';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return '';
}

// Accessible name, in the order a screen reader resolves it: aria-label → aria-labelledby → associated
// <label> → placeholder → title. Truncated; empty when nothing names the element.
function computeAccessibleName(element: Element): string {
  const label = element.getAttribute('aria-label');
  if (label?.trim()) return label.trim().slice(0, 120);

  const labelledby = element.getAttribute('aria-labelledby');
  if (labelledby) {
    const text = labelledby.split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent?.trim() || '')
      .filter(Boolean).join(' ').trim();
    if (text) return text.slice(0, 120);
  }

  const id = (element as HTMLElement).id;
  if (id) {
    const forLabel = element.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (forLabel?.textContent?.trim()) return forLabel.textContent.trim().slice(0, 120);
  }
  const wrappingLabel = element.closest('label');
  if (wrappingLabel?.textContent?.trim()) return wrappingLabel.textContent.trim().slice(0, 120);

  const placeholder = element.getAttribute('placeholder');
  if (placeholder?.trim()) return placeholder.trim().slice(0, 120);
  const title = element.getAttribute('title');
  if (title?.trim()) return title.trim().slice(0, 120);
  return '';
}

// Rough visibility: rendered box or client rects present, and not display:none / visibility:hidden.
// Good enough for the model to prefer real, on-screen elements over hidden template markup.
function isElementVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  if (element.hidden) return false;
  if (element.offsetWidth === 0 && element.offsetHeight === 0 && element.getClientRects().length === 0) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !style || (style.visibility !== 'hidden' && style.display !== 'none');
}

// A fill-based element (form control/editable region) has its own inherent "has content" state to read
// live. A click-based one (button/link/ARIA actionable role) has no such inherent state — there's nothing
// to read off it — so "complete" for those instead means "has been interacted with this session", tracked
// via interactedSelectors below as clicks happen.
function isFillableElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || (element as HTMLElement).isContentEditable;
}
function isClickTrackedElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a') return true;
  const role = element.getAttribute('role');
  return role === 'button' || role === 'link' || role === 'checkbox' || role === 'switch' || role === 'menuitem';
}

// Whether a fillable element currently has real content — read live from the actual page element, never
// from anything the model said, so this is always accurate and needs no model involvement to stay so.
function isElementFilled(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === 'checkbox' || type === 'radio') return element.checked;
    if (type === 'file') return element.files !== null && element.files.length > 0;
    return element.value.trim().length > 0;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value.trim().length > 0;
  }
  if ((element as HTMLElement).isContentEditable) return (element.textContent || '').trim().length > 0;
  return false;
}

// Selectors of elements the user has clicked/activated at least once this page-view — the only signal
// available for whether a button/link-style checklist item ("Apply", "Autofill", a dropdown option) has
// been done, since those have no inherent "value" the way a form field does.
const interactedSelectors = new Set<string>();
document.addEventListener('click', (event) => {
  const clickable = (event.target as Element | null)?.closest('button, a, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="menuitem"]');
  if (clickable) interactedSelectors.add(computeSelector(clickable));
}, true);

function isTrackableElement(element: Element): boolean {
  return isFillableElement(element) || isClickTrackedElement(element);
}
function isElementComplete(element: Element, selector: string): boolean {
  if (isFillableElement(element)) return isElementFilled(element);
  return interactedSelectors.has(selector);
}

// A plain selector string (e.g. "#name") can't cross a shadow-DOM boundary via document.querySelector —
// this tries the direct lookup first, then searches recursively through shadow roots, so selectors for
// elements collected from inside one (see collectElementsDeep) can still be resolved.
function deepQuerySelector(selector: string, root: Document | ShadowRoot = document): Element | null {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) {
      const found = deepQuerySelector(selector, element.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

// Re-reads live DOM state for every item in a widget's state and returns it with "complete" flags
// refreshed — read straight from the real page, never from anything the model said, so this is always
// accurate and needs no model involvement to stay so. Any other keys the model put in state (a title,
// custom fields, etc.) pass through untouched.
function liveifyState(state: WidgetState | undefined): WidgetState | undefined {
  if (!state || !Array.isArray(state.items)) return state;
  const items = state.items.map((item) => {
    if (!item || typeof item.selector !== 'string') return item;
    let target: Element | null = null;
    try { target = deepQuerySelector(item.selector); } catch { /* invalid selector, ignore */ }
    return { ...item, complete: target ? isElementComplete(target, item.selector) : (item.complete ?? false) };
  });
  return { ...state, items };
}

// ---------------------------------------------------------------------------------------------------
// Content script: reads the page, watches it for change, and hosts the sandboxed widget iframe.
// ---------------------------------------------------------------------------------------------------

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const root = document.documentElement;
    let applyingInterface = false;
    let contextInvalidated = false;

    function teardownOnInvalidatedContext() {
      if (contextInvalidated) return;
      contextInvalidated = true;
      window.clearTimeout(mutationTimer);
      observer.disconnect();
      document.removeEventListener('input', handlePageChangeEvent, true);
      document.removeEventListener('change', handlePageChangeEvent, true);
      document.removeEventListener('click', handlePageChangeEvent, true);
      document.removeEventListener('input', pushLiveState, true);
      document.removeEventListener('change', pushLiveState, true);
      document.removeEventListener('click', pushLiveState, true);
    }

    // Broad on purpose — links, headings, labels, dropdowns, and anything ARIA-labelled or role-bearing,
    // not just form controls — so the task representation can be grounded in whatever the page actually
    // contains rather than a narrow, form-shaped assumption of what's relevant.
    const PAGE_ELEMENT_SELECTOR = 'a, button, input, textarea, select, option, label, form, h1, h2, h3, h4, h5, h6, [id], [data-testid], [aria-label], [role], [contenteditable="true"]';

    // Many real sites (design-system components, some ATS/checkout widgets) build their actual form
    // fields inside shadow DOM, invisible to a plain querySelectorAll on the main document — confirmed
    // this was previously silently missing real fields entirely. Walks into every shadow root found,
    // recursively, so those elements get picked up too. (Cross-origin iframes are a separate, harder
    // case — same-document shadow DOM is the common one this addresses.)
    // Bounded on purpose — a page with many/deeply-nested shadow roots (common in design-system-heavy
    // real sites) could otherwise mean an unbounded amount of work here (a full querySelectorAll('*')
    // scan repeated at every level found), risking a slow enough response that the caller's timeout
    // treats the page as unreachable at all — which stalls analysis (the panel keeps retrying and no
    // task representation is produced) until the scan finally comes back in time.
    // Stops as soon as there's more than enough (the caller only ever keeps the first 300 anyway) and
    // caps recursion depth as a hard backstop against any pathological nesting.
    const MAX_ELEMENTS_TO_COLLECT = 400;
    const MAX_SHADOW_DEPTH = 12;
    function collectElementsDeep(root: Document | ShadowRoot, into: Element[], depth = 0) {
      if (into.length >= MAX_ELEMENTS_TO_COLLECT || depth > MAX_SHADOW_DEPTH) return;
      into.push(...root.querySelectorAll(PAGE_ELEMENT_SELECTOR));
      for (const element of root.querySelectorAll('*')) {
        if (into.length >= MAX_ELEMENTS_TO_COLLECT) return;
        if (element.shadowRoot) collectElementsDeep(element.shadowRoot, into, depth + 1);
      }
    }

    function getPageElements() {
      // Never let anything here leave the caller hanging — this is always called synchronously inside a
      // runtime message handler that must call sendResponse exactly once; an uncaught exception here
      // previously meant the message port just stayed open until the caller's own timeout gave up,
      // silently falling back to treating the page as unreachable.
      try {
        const elements: Element[] = [];
        collectElementsDeep(document, elements);
        return elements.slice(0, 300).map((element, index) => ({
          id: element.id || `element-${index + 1}`,
          selector: computeSelector(element),
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || '').trim().slice(0, 120),
          role: computeRole(element),
          accessibleName: computeAccessibleName(element),
          visible: isElementVisible(element),
        }));
      } catch (error) {
        console.error('TaskWeb: getPageElements failed', error);
        return [];
      }
    }

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
    }

    // No host-drawn chrome. The widget authors every affordance (title bar, drag handle, close/collapse
    // buttons) itself, inside the sandbox, and asks the host to act via window.taskweb.* — see the
    // 'move' / 'close' / 'setHeight' messages handled below and the API in entrypoints/sandbox/main.ts.
    // Set true once the widget has moved the frame, so later content updates don't snap it back to the
    // default corner.
    let userPositionedFrame = false;

    // The widget's own document is a real navigation to an extension-origin sandbox page (see
    // entrypoints/sandbox/), not srcdoc — srcdoc would inherit this host page's CSP, which on strict
    // sites can silently block the sandbox's own script with zero error signal; a real navigation gets
    // its own independent CSP instead. sandbox="allow-scripts" with no allow-same-origin gives it an
    // opaque origin: it structurally cannot reach this page's DOM, cookies, storage, or navigate the top
    // frame — that's what actually isolates model-generated code from the real page, not anything in the
    // message-passing below.
    let interfaceReady = false;
    let interfaceReadyResolvers: Array<() => void> = [];
    let currentWidgetState: WidgetState | null = null;

    function waitForInterfaceReady(): Promise<void> {
      if (interfaceReady) return Promise.resolve();
      return new Promise((resolve) => { interfaceReadyResolvers.push(resolve); });
    }

    // Auto-fit the frame height to the sandbox's reported content height, unless the widget has pinned
    // an explicit height via window.taskweb.setHeight().
    function applySandboxResize(frame: HTMLIFrameElement, height: number) {
      if (frame.dataset.taskwebExplicitHeight === 'true') return;
      const capped = Math.min(Math.max(Math.round(height) + 8, 40), window.innerHeight * 0.7);
      frame.style.height = `${capped}px`;
    }

    // Nudge the frame by a pixel delta the widget streams during its own drag gesture. First call
    // converts the corner-docked frame to left/top so deltas accumulate.
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

    // Authenticates by event.source (the exact Window that sent it) rather than event.origin — an opaque
    // origin has no origin string worth checking, it reports as "null". Message protocol from the sandbox:
    // - sandbox-ready       : listener is live, safe to post 'init'
    // - resize {height}     : content height changed → auto-fit the frame
    // - move {dx, dy}       : widget-authored drag → nudge the frame
    // - setHeight {height}  : widget pins the frame height
    // - resetHeight         : widget releases the pin (back to auto-fit)
    // - close               : widget-authored dismiss → tear the widget down
    // - error {message}     : widget code threw
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
      if (!widget) { removeWebpageInterface(); return; }
      applyingInterface = true;

      const frame = ensureInterfaceFrame();
      await waitForInterfaceReady();
      if (!document.body.contains(frame)) { applyingInterface = false; return; } // dismissed while waiting

      const style = widget.style || {};
      applyStyle(frame, style);
      frame.dataset.taskwebExplicitHeight = style.height ? 'true' : 'false';
      // Once the user has dragged the widget, leave its position alone on later content updates rather
      // than snapping it back to the default corner — dragging should stick until the widget itself is
      // torn down (a genuinely new task/site) and recreated.
      if (!userPositionedFrame) {
        if (!style.top && !style.bottom) frame.style.bottom = frame.style.bottom || '20px';
        if (!style.left && !style.right) frame.style.right = frame.style.right || '20px';
      }
      if (!style.width) frame.style.width = frame.style.width || '300px';
      if (!style.height && !frame.style.height) frame.style.height = '160px'; // provisional, until the sandbox reports its real content height

      currentWidgetState = liveifyState(widget.state ? structuredClone(widget.state) : { items: [] }) || { items: [] };
      frame.contentWindow?.postMessage({ type: 'init', code: widget.code || '', state: currentWidgetState }, '*');

      applyingInterface = false;
    }

    // Cheap and instant (no network/model call) — re-reads live DOM state for whatever items the current
    // widget cares about and pushes the refreshed state into the sandbox, which re-runs its own
    // render(state). This is what makes a checklist reflect real completion without the model ever having
    // to compute or represent that itself.
    function pushLiveState() {
      if (!currentWidgetState || !interfaceReady) return;
      const frame = document.querySelector('iframe[data-taskweb-interface]') as HTMLIFrameElement | null;
      if (!frame) return;
      currentWidgetState = liveifyState(currentWidgetState) || currentWidgetState;
      frame.contentWindow?.postMessage({ type: 'state', state: currentWidgetState }, '*');
    }

    let mutationTimer: number | undefined;
    let pendingMutations: MutationRecord[] = [];

    function getSelector(element: Element | null) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return 'document';
      if (element.id) return `#${element.id}`;
      if ((element as HTMLElement).dataset?.testid) return `[data-testid="${(element as HTMLElement).dataset.testid}"]`;
      return element.tagName.toLowerCase();
    }

    function describeMutation(mutation: MutationRecord) {
      const target = mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target as Element;
      return {
        type: mutation.type,
        target: getSelector(target),
        attribute: mutation.attributeName || null,
        oldValue: mutation.oldValue || null,
        addedNodes: mutation.addedNodes.length,
        removedNodes: mutation.removedNodes.length,
        text: mutation.type === 'characterData' ? mutation.target.textContent?.slice(0, 160) : null,
      };
    }

    function handlePageChange(mutations: MutationRecord[] = []) {
      if (applyingInterface || contextInvalidated) return;
      pendingMutations.push(...mutations);
      window.clearTimeout(mutationTimer);
      mutationTimer = window.setTimeout(() => {
        const pageElements = getPageElements();
        const activeElement = document.activeElement;
        const event = {
          type: 'page.changed',
          url: location.href,
          target: {
            title: document.title,
            forms: document.forms.length,
            selector: activeElement?.id ? `#${activeElement.id}` : activeElement?.tagName?.toLowerCase(),
          },
          payload: { elements: pageElements.length, mutations: pendingMutations.slice(0, 100).map(describeMutation) },
        };
        pendingMutations = [];
        if (globalThis.chrome?.runtime?.sendMessage) {
          try {
            // Manifest V3's sendMessage returns a promise when called without a callback; it rejects
            // ("Could not establish connection") whenever no extension page has a listener open right
            // now (e.g. the side panel isn't open on this tab) — confirmed live as an unhandled
            // rejection on every page interaction, on every site, regardless of whether the extension
            // is in use. That's an expected, benign case here, not a real failure.
            globalThis.chrome.runtime.sendMessage({ source: 'taskweb-plugin', type: 'PAGE_CHANGED', event })?.catch(() => {});
          } catch (_) {
            // The extension was reloaded/updated while this page was already open; stop trying.
            teardownOnInvalidatedContext();
          }
        }
        window.postMessage({ source: 'taskweb-plugin', type: 'PAGE_CHANGED', event }, '*');
      }, 400);
    }

    const handlePageChangeEvent = () => handlePageChange();

    // The widget's own content lives inside its sandboxed iframe's separate (opaque-origin) document,
    // invisible to this observer by construction — so its own updates can never self-trigger a "page
    // changed" loop. The one exception is the iframe element itself being inserted into the host page,
    // which the closest('[data-taskweb-interface]') checks below still exclude.
    const observer = new MutationObserver((mutations) => {
      const changedOutsideInterface = mutations.some((mutation) => {
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
      if (changedOutsideInterface || hasTextChange) handlePageChange(mutations);
    });

    function observeRoot(rootNode: Document | ShadowRoot) {
      observer.observe(rootNode, { childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
      rootNode.querySelectorAll?.('*').forEach((element) => {
        if (element.shadowRoot) observeRoot(element.shadowRoot);
        if (element.tagName === 'IFRAME' && !element.hasAttribute('data-taskweb-interface')) {
          try {
            const frameDocument = (element as HTMLIFrameElement).contentDocument;
            if (frameDocument) observeRoot(frameDocument);
          } catch (_) {
            // Cross-origin frames cannot be observed by the content script.
          }
        }
      });
    }

    observeRoot(document);
    document.querySelectorAll('iframe').forEach((frame) => frame.addEventListener('load', () => {
      try {
        if (frame.contentDocument) observeRoot(frame.contentDocument);
      } catch (_) {
        // Cross-origin frames cannot be observed by the content script.
      }
    }));
    document.addEventListener('input', handlePageChangeEvent, true);
    document.addEventListener('change', handlePageChangeEvent, true);
    document.addEventListener('click', handlePageChangeEvent, true);
    // Separate from the 400ms-debounced pipeline above (which forwards to the backend for possible
    // structural regeneration) — this one just pushes refreshed live state into the sandbox, so it can
    // run instantly, on every keystroke/click, with no network/model round-trip at all.
    document.addEventListener('input', pushLiveState, true);
    document.addEventListener('change', pushLiveState, true);
    document.addEventListener('click', pushLiveState, true);

    try {
      globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
        if (message?.type === 'APPLY_WEBPAGE_INTERFACE') {
          void applyWebpageInterface(message.tree);
          sendResponse({ ok: true });
        } else if (message?.type === 'GET_PAGE_ELEMENTS') {
          sendResponse({ url: location.href, title: document.title, elements: getPageElements() });
        }
      });
    } catch (_) {
      teardownOnInvalidatedContext();
    }

    window.postMessage({ source: 'taskweb-plugin', type: 'READY', url: location.href }, '*');
    root.dataset.taskwebPlugin = 'connected';
  },
});
