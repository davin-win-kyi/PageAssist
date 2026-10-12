/*
TASKS:
- being able to parse through information and format it into 
  the nessecary format for Task Representation Generation 
- being able to distinguish between exsisting element changes 
  and structural changes that should be accounted for in the interface
*/
import { isElementComplete } from './completion.ts';
import { computeAccessibleDescription, computeAccessibleName, computeRole, stableSelector } from './selectors.ts';

export type ScannedElement = {
  id: string;               
  selector: string;
  tag: string;
  text: string;
  role: string;
  accessibleName: string;
  description: string;       
  completion_status: '' | 'complete' | 'incomplete'; 
  container: string;         
  visible: boolean;
};

// A structural grouping elements sit in, so the backend can tell which ones belong together without
// guessing from flat document order.
export type ScannedContainer = {
  selector: string;
  tag: string;
  role: string;
  label: string;             // legend / caption / summary / figcaption / heading / ARIA name
  parent: string;            // selector of its own nearest context container ('' = top level)
};

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// What the backend sees: answerable controls, the instructional content around them, and visual
// context.
export const PAGE_ELEMENT_SELECTOR = [
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'button',
  'a[href]',
  'summary',

  // Labels and instructional content
  'label',
  'legend',
  'h1,h2,h3,h4,h5,h6',
  'p,li,dt,dd,pre',
  'caption,th,td',

  // Visual context
  'img,figcaption',

  // Custom widgets and editable regions
  '[role]',
  '[contenteditable]',
].join(',');

// Recorded per element (`container`) to keep the relationships between elements.
export const CONTEXT_CONTAINER_SELECTOR = [
  'main,article,section,form,fieldset',
  'ol,ul,dl,table,tr',
  'details,dialog,figure',
  // The same groupings built from <div>s with ARIA roles (Ashby's radiogroups, React modals).
  '[role="main"],[role="article"],[role="region"],[role="form"],[role="group"],[role="radiogroup"]',
  '[role="list"],[role="table"],[role="row"],[role="dialog"],[role="alertdialog"],[role="figure"]',
].join(',');

// Transient layers anchored to some other control — an open dropdown's option list and its filter
// box, a tooltip, an autocomplete list, a date picker's calendar. Their contents pop in and out and are
// never page structure or a question of their own.
export const POPUP_SELECTOR = [
  '[role="listbox"]', '[role="menu"]', '[role="tooltip"]',
  '[class*="menu" i]', '[class*="popover" i]', '[class*="popup" i]', '[class*="tooltip" i]',
  '[class*="option-list" i]', '[class*="options-list" i]',
  // Floating layers and date-picker calendars: popper.js, flatpickr, Pikaday, jQuery UI, Ant Design
  '[class*="popper" i]', '[class*="flatpickr-calendar" i]', '[class*="pika-single" i]',
  '[class*="ui-datepicker" i]', '[class*="picker-dropdown" i]',
].join(', ');
const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
// Only ever looked for INSIDE a dialog — on the date field's own ancestors these would match the field
// itself (react-datepicker's "react-datepicker-wrapper", jQuery UI's "hasDatepicker").
const CALENDAR_SELECTOR = '[role="grid"], [class*="calendar" i], [class*="datepicker" i], [class*="date-picker" i], [class*="daypicker" i], [class*="day-picker" i]';

// Answerable controls — what a question's answer is entered into. Their set is what structural-change
// detection diffs.
export const FIELD_NODE_SELECTOR = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
  'textarea', 'select',
  '[role="textbox"]', '[role="combobox"]', '[role="checkbox"]', '[role="radio"]', '[role="searchbox"]',
  '[role="spinbutton"]', '[role="switch"]',
].join(', ');

// - MAX_ELEMENTS_TO_COLLECT — hard stop on the recursive scan so a design-system-heavy page can't make
//   this slow enough that the caller's timeout treats the page as unreachable.
// - MAX_ELEMENTS_TO_SEND — how many actually go to the model (after the priority sort).
// - MAX_TREE_DEPTH — backstop against pathological shadow/iframe nesting.
const MAX_ELEMENTS_TO_COLLECT = 900;
const MAX_ELEMENTS_TO_SEND = 500;
const MAX_TREE_DEPTH = 12;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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

// A popup-looking class on a page-level wrapper doesn't make the page a popup: WordPress themes put
// "sticky-menu-fade" and "dropdown-hover" on <body>, which would otherwise read every element on the page
// as part of an open dropdown. A transient layer never holds the page itself — <html>/<body>, its main
// content, its <h1>, or a whole form.
const PAGE_LEVEL_SELECTOR = 'main, article, form, h1, [role="main"]';
function isPageLevel(layer: Element): boolean {
  return layer.matches('html, body') || layer.matches(PAGE_LEVEL_SELECTOR) || !!layer.querySelector(PAGE_LEVEL_SELECTOR);
}

/*
Check for a transient layer (anything that pops up temporary)
- checks if dialog and if it is a calendar
- other checks are for all possible other checks 
*/
export function isInTransientLayer(element: Element): boolean {
  const nearest = element.closest(POPUP_SELECTOR);
  const popup = nearest && !isPageLevel(nearest) ? nearest : null;
  const dialog = element.closest(DIALOG_SELECTOR);
  // A dialog is a real page layer that can hold real questions, even one whose classes say "popup" —
  // unless the dialog is itself a date picker. A dropdown open INSIDE a dialog is still transient.
  if (dialog && (!popup || popup.contains(dialog))) {
    return dialog.matches(CALENDAR_SELECTOR) || !!dialog.querySelector(CALENDAR_SELECTOR);
  }
  return !!popup;
}

//////////////////////////////////////////////////////////////////////////////////////////

export function collectElementsDeep(root: Document | ShadowRoot, into: Element[], depth = 0) {
  if (into.length >= MAX_ELEMENTS_TO_COLLECT || depth > MAX_TREE_DEPTH) return;
  into.push(...root.querySelectorAll(PAGE_ELEMENT_SELECTOR));
  for (const element of root.querySelectorAll('*')) {
    if (into.length >= MAX_ELEMENTS_TO_COLLECT) return;
    if (element.shadowRoot) collectElementsDeep(element.shadowRoot, into, depth + 1);
    if (element.tagName === 'IFRAME' && !element.hasAttribute('data-pageassist-interface')) {
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
    if (frame.hasAttribute('data-pageassist-interface')) return;
    if (readableFrameDoc(frame)) sameOrigin += 1; else crossOrigin += 1;
  });
  return { sameOrigin, crossOrigin };
}

// Priority elements for forms
const PRIORITY_ROLES = new Set(['textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'searchbox']);
function isPriorityElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'label' || tag === 'legend' || /^h[1-6]$/.test(tag)) return true;
  if ((element as HTMLElement).isContentEditable) return true;
  const role = element.getAttribute('role');
  return !!role && PRIORITY_ROLES.has(role);
}

// method to mark if an element is complete or not 
function completionStatus(element: Element, selector: string): ScannedElement['completion_status'] {
  if (!element.matches(FIELD_NODE_SELECTOR) && !(element as HTMLElement).isContentEditable) return '';
  // A completion read must never cost the element its place in the scan.
  try {
    return isElementComplete(element, selector) ? 'complete' : 'incomplete';
  } catch {
    return '';
  }
}

// Get the container for an element
function nearestContainer(element: Element): Element | null {
  const found = element.parentElement?.closest(CONTEXT_CONTAINER_SELECTOR);
  if (found) return found;
  const root = element.getRootNode?.();
  const host = root?.nodeType === 11 ? (root as ShadowRoot).host : null; // 11 = DOCUMENT_FRAGMENT_NODE
  if (!host) return null;
  return host.matches(CONTEXT_CONTAINER_SELECTOR) ? host : nearestContainer(host);
}

// Method to get heading
function ownHeading(container: Element): Element | undefined {
  const own = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((h) => nearestContainer(h) === container);
  const top = Math.min(...own.map((h) => Number(h.tagName[1])));
  const atTop = own.filter((h) => Number(h.tagName[1]) === top);
  return atTop.length === 1 ? atTop[0] : undefined;
}

const CAPTION_CHILD: Record<string, string> = { fieldset: 'legend', table: 'caption', details: 'summary', figure: 'figcaption', tr: 'th' };
function containerLabel(container: Element): string {
  const named = computeAccessibleName(container);
  if (named) return named;
  const captionTag = CAPTION_CHILD[container.tagName.toLowerCase()];
  const caption = captionTag
    ? [...container.children].find((child) => child.tagName.toLowerCase() === captionTag)
    : ownHeading(container);
  return (caption?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export type PageScan = {
  elements: ScannedElement[];
  containers: ScannedContainer[];
  fields: FieldSnapshot;
};

export function scanPage(): PageScan {
  try {
    const collected: Element[] = [];
    collectElementsDeep(document, collected);
    // Stable sort
    const ranked = collected
      .filter((element) => { try { return !isInTransientLayer(element); } catch { return true; } })
      .map((element) => {
        try { return { element, visible: isElementVisible(element), priority: isPriorityElement(element) }; }
        catch { return { element, visible: true, priority: false }; }
      })
      .sort((a, b) => (Number(!a.priority) - Number(!b.priority)) || (Number(!a.visible) - Number(!b.visible)));

    const containers = new Map<Element, ScannedContainer>();
    const containerSelector = (box: Element | null): string => {
      if (!box) return '';
      const known = containers.get(box);
      if (known) return known.selector;
      const record: ScannedContainer = {
        selector: stableSelector(box),
        tag: box.tagName.toLowerCase(),
        role: computeRole(box),
        label: containerLabel(box),
        parent: '',
      };
      containers.set(box, record);
      record.parent = containerSelector(nearestContainer(box));
      return record.selector;
    };

    const elements: ScannedElement[] = [];
    const fields: FieldSnapshot = new Map();
    for (const { element, visible } of ranked.slice(0, MAX_ELEMENTS_TO_SEND)) {
      try {
        const selector = stableSelector(element);
        const record: ScannedElement = {
          id: (element as HTMLElement).id || selector,
          selector,
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          role: computeRole(element),
          accessibleName: computeAccessibleName(element),
          description: computeAccessibleDescription(element),
          completion_status: completionStatus(element, selector),
          container: containerSelector(nearestContainer(element)),
          visible,
        };
        elements.push(record);
        if (element.matches(FIELD_NODE_SELECTOR)) {
          const key = fieldKey(element, selector);
          const entry: FieldEntry = fields.get(key) ?? { visible: false, elements: [] };
          entry.elements.push(record);
          entry.visible ||= visible;
          entry.uploadGroup ??= uploadGroupOf(element) ?? undefined;
          fields.set(key, entry);
        }
      } catch {
      }
    }
    return { elements, containers: [...containers.values()], fields };
  } catch (error) {
    console.error('PageAssist: scanPage failed', error);
    return { elements: [], containers: [], fields: new Map() };
  }
}

// Function decides which containers to keep, because it is possible that some containers 
// are not referenced by any elements, and we want to remove those containers from the scan 
// - drop containsers with nothing meaningful inside them 
export function containersReferencedBy(elements: ScannedElement[], containers: ScannedContainer[]): ScannedContainer[] {
  const bySelector = new Map(containers.map((container) => [container.selector, container]));
  const out = new Map<string, ScannedContainer>();
  for (const element of elements) {
    let container = bySelector.get(element.container);
    while (container && !out.has(container.selector)) {
      out.set(container.selector, container);
      container = bySelector.get(container.parent);
    }
  }
  return [...out.values()];
}

//////////////////////////////////////////////////////////////////////////////////////////

// The page's readable prose — for widget items that are page CONTENT (recipe steps, article sections)
// rather than form fields. Top document + same-origin iframes, capped generously: for a tutorial the
// prose IS the steps, and a step past the cut can never reach the widget. Matches the backend's
// PAGE_TEXT_LIMIT (definitions/task/schema.py).
export function getPageText(cap = 60_000): string {
  const parts: string[] = [];
  const push = (doc: Document | null) => {
    try {
      const t = (doc?.body as HTMLElement | undefined)?.innerText?.trim();
      if (t) parts.push(t);
    } catch { /* cross-origin */ }
  };
  push(document);
  document.querySelectorAll('iframe').forEach((frame) => {
    if (frame.hasAttribute('data-pageassist-interface')) return;
    try { push((frame as HTMLIFrameElement).contentDocument); } catch { /* cross-origin */ }
  });
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').slice(0, cap);
}


//////////////////////////////////////////////////////////////////////////////////////////

/*
Field methods:
- these check if the webpage contains the same fields as the previous scan
- helps decide whether or not an exsisting task mapping needs updating which would update the interface
*/

// The question a control answers is its identity when two scans are compared. Controls that answer
// the same question share one key, so a question's own UI changing never reads as a new question:
//   - every radio in a group (by name, else its radiogroup/fieldset) — a newly shown option joins it
//   - a control nested inside another control (a filter box inside a combobox) — joins the outer one
// Everything else is keyed by its own selector, never by label text: "School" in a second education
// entry is a second question even though its label matches the first.
const RADIO_SELECTOR = 'input[type="radio" i], [role="radio"]';
const RADIO_GROUP_SELECTOR = '[role="radiogroup"], fieldset, [role="group"]';

function fieldKey(element: Element, selector: string): string {
  if (element.matches(RADIO_SELECTOR)) {
    const name = element.getAttribute('name');
    if (name && element.tagName.toLowerCase() === 'input') return `radio:${name}`;
    const group = element.closest(RADIO_GROUP_SELECTOR);
    if (group) return `radio:${stableSelector(group)}`;
  }
  let outer: Element | null = null;
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.matches(FIELD_NODE_SELECTOR)) outer = node;
  }
  return outer ? stableSelector(outer) : selector;
}

// `uploadGroup`: for a file input, the upload widget around it (see carryUploadFields).
export type FieldEntry = { visible: boolean; elements: ScannedElement[]; uploadGroup?: Element };
export type FieldSnapshot = Map<string, FieldEntry>;

/*
Fields that changed between two scans, with four different categories:
- added: a new field appeared in the DOM
- revealed: a field that was in the DOM but hidden is now visible (grouped per question)
- removed: a field that was present in the previous scan is no longer in the DOM
- hidden: a field that was visible is still in the DOM but now hidden — no longer part of the task
*/
export type FieldDiff = {
  added: ScannedElement[];
  revealed: ScannedElement[][];
  removed: string[];
  hidden: string[];
};

// The upload widget around a file input: its question group, else a wrapper classed like an upload.
export function uploadGroupOf(element: Element): Element | null {
  if (!element.matches('input[type="file" i]')) return null;
  const group = element.closest('[role="group"], fieldset') ?? element.closest('[class*="upload" i]');
  return group && !isPageLevel(group) ? group : null;
}

// An upload widget swaps its file <input> for a "<filename> ×" chip once a file is chosen — Greenhouse
// removes the input outright. The question is still on the page, now answered, so that's not a field
// leaving: carry the input's entry forward while its upload group is on the page, so the input coming
// back after "Remove file" isn't a new question either. Diff against, and keep, the carried snapshot.
export function carryUploadFields(before: FieldSnapshot, after: FieldSnapshot): FieldSnapshot {
  const carried: FieldSnapshot = new Map(after);
  for (const [key, entry] of before) {
    if (!carried.has(key) && entry.uploadGroup?.isConnected) carried.set(key, entry);
  }
  return carried;
}

// Structural = a question appeared, came into view, went out of view, or left. A revealed question
// goes to the backend grouped, so it can tell "already mapped, only its availability changed" from
// "not mapped, add it". A question going hidden is no longer part of the task, so it's dropped like a
// removed one — and added back if it's revealed again.
export function diffFieldSnapshots(before: FieldSnapshot, after: FieldSnapshot): FieldDiff {
  const diff: FieldDiff = { added: [], revealed: [], removed: [], hidden: [] };
  for (const [key, entry] of after) {
    const prior = before.get(key);
    if (!prior) diff.added.push(...entry.elements);
    else if (!prior.visible && entry.visible) diff.revealed.push(entry.elements);
    else if (prior.visible && !entry.visible) diff.hidden.push(...entry.elements.map((element) => element.selector));
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) diff.removed.push(...entry.elements.map((element) => element.selector));
  }
  return diff;
}

// within the valid selectors for a field 
function containsRealField(element: Element): boolean {
  return [element, ...element.querySelectorAll(FIELD_NODE_SELECTOR)]
    .some((field) => field.matches(FIELD_NODE_SELECTOR) && !isInTransientLayer(field));
}

// checks to see if a new element is a new field or not
// includes node.removedNodes and node.addedNodes
function nodeIntroducesField(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  try {
    return containsRealField(node as Element);
  } catch {
    return false;
  }
}

// attribute flips on a control itself that change what the field set is keyed on
const FIELD_STATE_ATTRS = new Set(['disabled', 'required', 'aria-required', 'id', 'name']);
const HIDDEN_STYLE_RE = /display\s*:\s*none|visibility\s*:\s*hidden/i;
const VISIBILITY_CLASS_RE = /hidden|hide|collapse|invisible|d-none|show|open|expand|visible|closed/i;

/*
Checking if a mutation is due to a field change or not
- this is used to determine whether or not the interface should be updated or not, the
  cases that it considers are: hidden, aria-hidden, open, style, class
    - if any of these attributes are changed, then it will check to see if the visibility has changed or not
*/
function visibilityMayHaveChanged(mutation: MutationRecord, element: Element): boolean {
  switch (mutation.attributeName) {
    case 'hidden':
    case 'aria-hidden':
    case 'open':
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
For each mutation, this checks to see that it not only is a mutation, but that this 
mutation is also a field change, 
- True: if it is a field change, then it will return true, which will trigger a interface update, 
- False: otherwise it will return false and the interface will not be updated

*/
export function mutationsIncludeFieldChange(mutations: MutationRecord[]): boolean {
  return mutations.some((m) => {
    // A document or shadow root (a web component appending straight into its shadow) is a valid
    // childList target too — only an element target can sit inside a transient layer.
    const el = m.target.nodeType === Node.ELEMENT_NODE ? m.target as Element : null;
    try {
      if (m.type === 'attributes') {
        if (!el) return false;
        if (el.matches(FIELD_NODE_SELECTOR) && m.attributeName && FIELD_STATE_ATTRS.has(m.attributeName) && !isInTransientLayer(el)) return true;
        return visibilityMayHaveChanged(m, el) && containsRealField(el);
      }
      // Options filtering in an open listbox, a calendar paging months — whatever came or went
      // belonged to that transient layer.
      if (el && isInTransientLayer(el)) return false;
    } catch {
      return false;
    }
    return [...m.addedNodes, ...m.removedNodes].some(nodeIntroducesField);
  });
}
