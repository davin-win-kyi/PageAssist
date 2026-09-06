// Reads the current page into the flat element snapshot the backend analyzes, and the "field-ish" set
// used for structural-change detection. Traverses shadow roots + same-origin iframes. Pure DOM reads.
import { computeAccessibleName, computeRole, stableSelector } from './selectors.ts';

export type ScannedElement = {
  id: string;
  selector: string;
  tag: string;
  text: string;
  role: string;
  accessibleName: string;
  visible: boolean;
};

// Broad on purpose — links, headings, labels, dropdowns, anything ARIA-labelled or role-bearing — so
// the task representation is grounded in whatever the page actually contains, not a form-shaped guess.
export const PAGE_ELEMENT_SELECTOR = 'a, button, input, textarea, select, option, label, fieldset, legend, form, h1, h2, h3, h4, h5, h6, [id], [data-testid], [aria-label], [aria-labelledby], [aria-required], [role], [contenteditable="true"]';
// Transient overlays — an open dropdown menu, a popover, a tooltip. Their contents pop in and out and
// must never count as page structure (they'd read as fields being added/removed).
export const POPUP_SELECTOR = '[role="listbox"], [role="menu"], [role="tooltip"], [aria-modal="true"], [class*="menu" i], [class*="popover" i], [class*="popup" i], [class*="tooltip" i], [class*="option-list" i], [class*="options-list" i]';

// - MAX_ELEMENTS_TO_COLLECT — hard stop on the recursive scan so a design-system-heavy page can't make
//   this slow enough that the caller's timeout treats the page as unreachable.
// - MAX_ELEMENTS_TO_SEND — how many actually go to the model (after the priority sort).
// - MAX_TREE_DEPTH — backstop against pathological shadow/iframe nesting.
const MAX_ELEMENTS_TO_COLLECT = 900;
const MAX_ELEMENTS_TO_SEND = 500;
const MAX_TREE_DEPTH = 12;

// Rough visibility: rendered box or client rects present, and not display:none / visibility:hidden.
export function isElementVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  if (element.hidden) return false;
  if (element.offsetWidth === 0 && element.offsetHeight === 0 && element.getClientRects().length === 0) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !style || (style.visibility !== 'hidden' && style.display !== 'none');
}

// The same-origin document inside an <iframe>, or null (cross-origin, not yet loaded, sandboxed).
function readableFrameDoc(frame: Element): Document | null {
  try {
    return (frame as HTMLIFrameElement).contentDocument || null;
  } catch {
    return null;
  }
}

export function collectElementsDeep(root: Document | ShadowRoot, into: Element[], depth = 0) {
  if (into.length >= MAX_ELEMENTS_TO_COLLECT || depth > MAX_TREE_DEPTH) return;
  into.push(...root.querySelectorAll(PAGE_ELEMENT_SELECTOR));
  for (const element of root.querySelectorAll('*')) {
    if (into.length >= MAX_ELEMENTS_TO_COLLECT) return;
    if (element.shadowRoot) collectElementsDeep(element.shadowRoot, into, depth + 1);
    if (element.tagName === 'IFRAME' && !element.hasAttribute('data-taskweb-interface')) {
      const frameDoc = readableFrameDoc(element);
      if (frameDoc) collectElementsDeep(frameDoc, into, depth + 1);
    }
  }
}

// For the analyze payload: how many iframes are on the page and how many we could actually read into.
// sameOrigin === 0 && crossOrigin > 0 on a form page means the fields are unreachable.
export function countFrames() {
  let sameOrigin = 0;
  let crossOrigin = 0;
  document.querySelectorAll('iframe').forEach((frame) => {
    if (frame.hasAttribute('data-taskweb-interface')) return;
    if (readableFrameDoc(frame)) sameOrigin += 1; else crossOrigin += 1;
  });
  return { sameOrigin, crossOrigin };
}

// Form controls, form structure, and headings — the elements most likely to be real "task elements".
// Sorted ahead of everything else so a long header/nav/footer can't push a late-in-the-DOM form out of
// the send budget (a confirmed cause of missing fields on big ATS pages).
const PRIORITY_ROLES = new Set(['textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'searchbox']);
function isPriorityElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'form' || tag === 'fieldset' || /^h[1-6]$/.test(tag)) return true;
  if ((element as HTMLElement).isContentEditable) return true;
  const role = element.getAttribute('role');
  return !!role && PRIORITY_ROLES.has(role);
}

export function getPageElements(): ScannedElement[] {
  // Never leave the caller hanging — this runs synchronously inside a message handler that must call
  // sendResponse exactly once; an uncaught throw here used to hold the port open until the caller
  // timed out and treated the page as unreachable. Each element is also processed in isolation so one
  // bad node can't collapse the whole scan to [] (which would freeze structural-change detection —
  // an empty field set never diffs against anything).
  try {
    const collected: Element[] = [];
    collectElementsDeep(document, collected);
    // Stable sort → within each tier document order is preserved. Tiers: priority+visible,
    // priority+hidden, other+visible, other+hidden. Then take the send budget off the top.
    const ranked = collected
      .filter((element) => { try { return !element.closest?.(POPUP_SELECTOR); } catch { return true; } })
      .map((element) => {
        try { return { element, visible: isElementVisible(element), priority: isPriorityElement(element) }; }
        catch { return { element, visible: true, priority: false }; }
      })
      .sort((a, b) => (Number(!a.priority) - Number(!b.priority)) || (Number(!a.visible) - Number(!b.visible)));
    const out: ScannedElement[] = [];
    for (const { element, visible } of ranked.slice(0, MAX_ELEMENTS_TO_SEND)) {
      try {
        out.push({
          id: element.id || `element-${out.length + 1}`,
          selector: stableSelector(element),
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || '').trim().slice(0, 120),
          role: computeRole(element),
          accessibleName: computeAccessibleName(element),
          visible,
        });
      } catch { /* skip this one element, keep the rest */ }
    }
    return out;
  } catch (error) {
    console.error('TaskWeb: getPageElements failed', error);
    return [];
  }
}

// The page's readable prose — for widget items that are page CONTENT (recipe steps, article sections)
// rather than form fields. Top document + same-origin iframes, capped.
export function getPageText(cap = 12000): string {
  const parts: string[] = [];
  const push = (doc: Document | null) => {
    try {
      const t = (doc?.body as HTMLElement | undefined)?.innerText?.trim();
      if (t) parts.push(t);
    } catch { /* cross-origin */ }
  };
  push(document);
  document.querySelectorAll('iframe').forEach((frame) => {
    if (frame.hasAttribute('data-taskweb-interface')) return;
    try { push((frame as HTMLIFrameElement).contentDocument); } catch { /* cross-origin */ }
  });
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').slice(0, cap);
}

// "Field-ish" elements whose set entering/leaving the DOM is a STRUCTURAL page change (a question
// revealed, a section removed) — NOT a value rendering inside an existing control, and NOT a dropdown
// menu opening (its options are filtered out by getPageElements; `listbox` is deliberately not here).
// A <label> is deliberately NOT here: it's the accessible NAME of a control, never a field of its
// own, and every genuine "question revealed" already brings a real control (input/select/textarea or
// a role-bearing widget). Counting bare labels made a file-upload widget swapping its
// "Attach / Dropbox / Google Drive / Enter manually" caption labels for a "<filename> ×" chip read as
// fields being removed — a false structural change on an unchanged question.
const FIELD_TAGS = ['input', 'textarea', 'select', 'fieldset', 'legend'];
const FIELD_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'spinbutton', 'switch']);

// A selector built from a real id/name/testid/aria-label (vs. a data-tw-ref stamp or a bare tag) —
// i.e. one that keeps naming the SAME element if the framework leaves it alone across a re-render.
function hasStableIdentity(selector: string): boolean {
  return selector.startsWith('#') || selector.includes('[data-testid') || selector.includes('[aria-label') || /\[name=/.test(selector);
}

// The identity a field-ish element contributes to the structural diff. A <legend>/<fieldset> wrapper
// is the kind of element a framework is most likely to fully discard and rebuild for a UI-state change
// within an EXISTING group — when one has no stable selector of its own, key it by its own text
// instead of the freshly-stamped data-tw-ref its replacement node would get, so the SAME group
// re-rendering doesn't read as "removed, then added". Real form controls (input/select/textarea) keep
// their DOM identity across nearly every framework's re-render, so they always use their selector.
function fieldIdentity(e: ScannedElement): string {
  if (!hasStableIdentity(e.selector) && (e.tag === 'legend' || e.tag === 'fieldset')) {
    const text = (e.accessibleName || e.text || '').trim().toLowerCase();
    if (text) return `${e.tag}:${text.slice(0, 80)}`;
  }
  return e.selector;
}

export function currentFieldSet(pageElements: ScannedElement[] = getPageElements()): Set<string> {
  return new Set(
    pageElements
      .filter((e) => FIELD_TAGS.includes(e.tag) || FIELD_ROLES.has(e.role || ''))
      .map(fieldIdentity),
  );
}

// One selector matching the same "field-ish" elements currentFieldSet counts — used at the
// MutationObserver level to tell a genuine field being ADDED/REMOVED (structural: a question revealed,
// a section removed) apart from an existing control merely expanding/collapsing (opening a dropdown
// adds only listbox/option nodes; its options and menu are excluded here and by POPUP_SELECTOR).
export const FIELD_NODE_SELECTOR =
  'input, textarea, select, fieldset, legend, '
  + '[role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="searchbox"], [role="spinbutton"], [role="switch"]';

function nodeIntroducesField(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  try {
    if (el.closest?.(POPUP_SELECTOR)) return false; // inside an open menu/popover — transient, not structure
    return !!el.matches?.(FIELD_NODE_SELECTOR) || !!el.querySelector?.(FIELD_NODE_SELECTOR);
  } catch {
    return false;
  }
}

const FIELD_STATE_ATTRS = new Set(['hidden', 'disabled', 'required', 'aria-hidden', 'aria-required', 'id', 'name']);

// True when this batch of mutations actually added or removed a form field outside any popup — the
// only kind of DOM change that warrants a structural re-analyze. An attribute flip that turns an
// existing field on/off (hidden/disabled/required/id/name) counts too.
export function mutationsIncludeFieldChange(mutations: MutationRecord[]): boolean {
  return mutations.some((m) => {
    if (m.type === 'attributes') {
      if (!m.attributeName || !FIELD_STATE_ATTRS.has(m.attributeName)) return false;
      const t = m.target;
      if (t.nodeType !== Node.ELEMENT_NODE) return false;
      const el = t as Element;
      try { return !!el.matches?.(FIELD_NODE_SELECTOR) && !el.closest?.(POPUP_SELECTOR); } catch { return false; }
    }
    return [...m.addedNodes, ...m.removedNodes].some(nodeIntroducesField);
  });
}
