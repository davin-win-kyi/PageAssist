/*
The following file helps with the mutation logic in content.ts
- deciding whether a mutation could have changed the page's questions
- watching the page, its shadow roots and its iframes for mutations
- describing a given mutation, and building the page change event for the side panel
*/

import { computeSelector, stableSelector } from './selectors.ts';
import {
  FIELD_NODE_SELECTOR,
  isInTransientLayer,
  carryUploadFields,
  diffFieldSnapshots,
  containersReferencedBy,
  type FieldSnapshot,
  type PageScan,
} from './page-scan.ts';

/*************************************************************************************************
Which mutations matter
*************************************************************************************************/

const INTERFACE_SELECTOR = '[data-pageassist-interface]';
const isInterfaceNode = (node: Node): boolean =>
  node.nodeType === Node.ELEMENT_NODE && !!(node as Element).closest(INTERFACE_SELECTOR);

/*
Whether any mutation happened on the page itself, not in the widget frame or from the data-tw-ref
stamps the selectors add
*/
export function changedOutsideInterface(mutations: MutationRecord[]): boolean {
  return mutations.some((mutation) => {
    if (mutation.type === 'characterData') return true;
    if (mutation.type === 'attributes' && mutation.attributeName === 'data-tw-ref') return false;
    const target = mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target;
    if (target instanceof Element && target.closest(INTERFACE_SELECTOR)) return false;
    if (mutation.type === 'attributes') return true;
    return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => !isInterfaceNode(node));
  });
}

// Whether an element is or holds a control outside a temporary layer
function containsRealField(element: Element): boolean {
  return [element, ...element.querySelectorAll(FIELD_NODE_SELECTOR)]
    .some((field) => field.matches(FIELD_NODE_SELECTOR) && !isInTransientLayer(field));
}

function nodeIntroducesField(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  try {
    return containsRealField(node as Element);
  } catch {
    return false;
  }
}

/*
Attribute changes that can make a control count as there or not, and the style and class changes
that can show or hide one
*/
const FIELD_STATE_ATTRS = new Set(['disabled', 'required', 'aria-required', 'id', 'name', 'inert']);
const HIDDEN_STYLE_RE = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])/i;
const VISIBILITY_CLASS_RE = /hidden|hide|collapse|invisible|d-none|show|open|expand|visible|closed/i;

function visibilityMayHaveChanged(mutation: MutationRecord, element: Element): boolean {
  switch (mutation.attributeName) {
    case 'hidden':
    case 'aria-hidden':
    case 'open':
    case 'inert':
      return true;
    case 'style':
      return HIDDEN_STYLE_RE.test(mutation.oldValue || '') !== HIDDEN_STYLE_RE.test(element.getAttribute('style') || '');
    case 'class': {
      const before = new Set((mutation.oldValue || '').split(/\s+/).filter(Boolean));
      const after = new Set((element.getAttribute('class') || '').split(/\s+/).filter(Boolean));
      const changed = [...before].filter((c) => !after.has(c)).concat([...after].filter((c) => !before.has(c)));
      return changed.some((c) => VISIBILITY_CLASS_RE.test(c));
    }
    default:
      return false;
  }
}

/*
Whether the mutations could add, remove, show or hide a question, which is what triggers a page
change. Changes inside a temporary layer (a dropdown filtering, a calendar paging) never do.
*/
export function mutationsIncludeFieldChange(mutations: MutationRecord[]): boolean {
  return mutations.some((m) => {
    // a document or shadow root can be a childList target too; only an element can be in a layer
    const el = m.target.nodeType === Node.ELEMENT_NODE ? m.target as Element : null;
    try {
      if (m.type === 'attributes') {
        if (!el) return false;
        if (el.matches(FIELD_NODE_SELECTOR) && m.attributeName && FIELD_STATE_ATTRS.has(m.attributeName) && !isInTransientLayer(el)) return true;
        return visibilityMayHaveChanged(m, el) && containsRealField(el);
      }
      if (el && isInTransientLayer(el)) return false;
    } catch {
      return false;
    }
    return [...m.addedNodes, ...m.removedNodes].some(nodeIntroducesField);
  });
}

/*************************************************************************************************
Watching the page
*************************************************************************************************/

const OBSERVE_OPTIONS: MutationObserverInit = {
  childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true,
};

// iframes that already re-observe their document when it loads
const watchedFrames = new WeakSet<HTMLIFrameElement>();

/*
Observes a document or shadow root, and every shadow root and same-origin iframe inside it. onRoot
runs for each one as it's observed, and again for an iframe's new document after it loads.
*/
export function observeTree(observer: MutationObserver, root: Document | ShadowRoot, onRoot: (root: Document | ShadowRoot) => void) {
  onRoot(root);
  observer.observe(root, OBSERVE_OPTIONS);
  root.querySelectorAll?.('*').forEach((element) => {
    if (element.shadowRoot) observeTree(observer, element.shadowRoot, onRoot);
    if (element.tagName !== 'IFRAME' || element.hasAttribute('data-pageassist-interface')) return;
    const frame = element as HTMLIFrameElement;
    const observeFrame = () => {
      try {
        if (frame.contentDocument) observeTree(observer, frame.contentDocument, onRoot);
      } catch { /* cross-origin */ }
    };
    observeFrame();
    if (!watchedFrames.has(frame)) {
      watchedFrames.add(frame);
      frame.addEventListener('load', observeFrame);
    }
  });
}

/*************************************************************************************************
Describing a mutation
*************************************************************************************************/

// A short selector for the element a mutation touched
export function getSelector(element: Element | null): string {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return 'document';
  if (element.id) return `#${element.id}`;
  if ((element as HTMLElement).dataset?.testid) return `[data-testid="${(element as HTMLElement).dataset.testid}"]`;
  return element.tagName.toLowerCase();
}

// The element a mutation happened on: itself, a shadow root's host, or a text node's parent
function targetElement(node: Node): Element | null {
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return (node as ShadowRoot).host ?? null;
  return node.parentElement;
}

// The controls in an added or removed subtree, outside temporary layers
function controlsIn(node: Element): Element[] {
  try {
    return [node, ...node.querySelectorAll(FIELD_NODE_SELECTOR)]
      .filter((control) => control.matches(FIELD_NODE_SELECTOR) && !isInTransientLayer(control));
  } catch {
    return [];
  }
}

// A removed element's selector, or null when it only has its tag name
function removedIdentity(element: Element): string | null {
  const selector = computeSelector(element);
  return selector === element.tagName.toLowerCase() ? null : selector;
}

const elementsOf = (nodes: NodeList): Element[] =>
  [...nodes].filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE);
const distinct = (selectors: (string | null)[]): string[] =>
  [...new Set(selectors.filter((s): s is string => !!s))].slice(0, 20);

/*
A summary of one mutation for the side panel. Added and removed selectors list the controls inside
the subtree first, then the subtree roots, so they can be matched against the task representation.
*/
export function describeMutation(mutation: MutationRecord) {
  const target = targetElement(mutation.target);
  const added = elementsOf(mutation.addedNodes);
  const removed = elementsOf(mutation.removedNodes);
  const addedControls = added.flatMap(controlsIn);
  const removedControls = removed.flatMap(controlsIn);
  return {
    type: mutation.type,
    target: getSelector(target),
    targetSelector: target ? stableSelector(target) : null,
    addedSelectors: distinct([...addedControls, ...added].map(stableSelector)),
    removedSelectors: distinct([...removedControls, ...removed].map(removedIdentity)),
    attribute: mutation.attributeName || null,
    oldValue: mutation.oldValue || null,
    addedNodes: mutation.addedNodes.length,
    removedNodes: mutation.removedNodes.length,
    formControlsAdded: addedControls.length,
    formControlsRemoved: removedControls.length,
    text: mutation.type === 'characterData' ? mutation.target.textContent?.slice(0, 160) : null,
  };
}

/*************************************************************************************************
The page-change event
*************************************************************************************************/

/*
The event sent to the side panel after a burst of mutations. Structural when a question was
added, revealed, removed or hidden since the previous snapshot; `fields` is the new snapshot.
*/
export function buildPageChangeEvent(scan: PageScan, previous: FieldSnapshot | undefined, mutations: MutationRecord[]) {
  const fields = previous ? carryUploadFields(previous, scan.fields) : scan.fields;
  const diff = previous ? diffFieldSnapshots(previous, fields) : { added: [], revealed: [], removed: [], hidden: [] };
  const revealedCount = diff.revealed.reduce((n, group) => n + group.length, 0);
  const gone = [...diff.removed, ...diff.hidden];
  const addedFields = diff.added.slice(0, 25);
  const revealedFields = diff.revealed.slice(0, 10);
  const active = document.activeElement;
  const event = {
    type: 'page.changed',
    url: location.href,
    structural: diff.added.length + revealedCount + gone.length > 0,
    fieldsAdded: diff.added.length + revealedCount,
    fieldsRemoved: gone.length,
    addedFields,
    revealedFields,
    removedFields: gone.slice(0, 25),
    addedContainers: containersReferencedBy([...addedFields, ...revealedFields.flat()], scan.containers),
    target: {
      title: document.title,
      forms: document.forms.length,
      selector: active?.id ? `#${active.id}` : active?.tagName?.toLowerCase(),
    },
    payload: { elements: scan.elements.length, mutations: mutations.slice(0, 100).map(describeMutation) },
  };
  return { event, fields };
}
