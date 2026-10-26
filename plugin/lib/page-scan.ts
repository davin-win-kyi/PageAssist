/*
To scan-page and craft them into task representation ready elements for the creation
of the task representation, and to keep a snapshot of the page's questions for mutations

TASKS:
- Page-scanner logic: being able to parse through information and format relevant elements into
  the nessecary format for Task Representation Generation
- Snapshots: being able to distinguish between exsisting element changes and structural changes
  between two scans, which mutations.ts uses to decide if the interface should be updated
*/

import { isElementComplete } from './completion.ts';
import { computeAccessibleDescription, computeAccessibleName, computeRole, stableSelector } from './selectors.ts';

/*
An element as sent to the backend for the task representation
*/
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

/*
A grouping elements sit in, so the backend can tell which belong together
*/
export type ScannedContainer = {
  selector: string;
  tag: string;
  role: string;
  // legend / caption / summary / figcaption / heading / ARIA name
  label: string;        
  // selector of its own nearest context container ('' = top level)     
  parent: string;            
};

/*************************************************************************************************
Selectors
*************************************************************************************************/

/*
The elements the scan collects
*/
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

/*
Groupings the scan reports as containers, so the backend can tell which elements belong together
*/
export const CONTEXT_CONTAINER_SELECTOR = [
  'main,article,section,form,fieldset',
  'ol,ul,dl,table,tr',
  'details,dialog,figure',
  // The same groupings built from <div>s with ARIA roles (Ashby's radiogroups, React modals).
  '[role="main"],[role="article"],[role="region"],[role="form"],[role="group"],[role="radiogroup"]',
  '[role="list"],[role="table"],[role="row"],[role="dialog"],[role="alertdialog"],[role="figure"]',
].join(',');

/*
Temporary layers that belong to a control, like dropdown lists, menus, tooltips, suggestions and
date pickers. Their contents aren't page elements and their changes aren't page changes.
- names a field's own wrapper also uses, like "dropdown", are matched only in their popup forms
- layers that can also hold a dialog are left out, since a dialog can hold real questions
*/
export const POPUP_SELECTOR = [
  // ARIA roles
  '[role="listbox"]', '[role="menu"]', '[role="tooltip"]',
  // Generic class names
  '[class*="menu" i]', '[class*="popover" i]', '[class*="popup" i]', '[class*="tooltip" i]',
  '[class*="option-list" i]', '[class*="options-list" i]', '[class*="dropdown-menu" i]',
  '[class*="dropdown-content" i]', '[class*="dropdown-panel" i]',
  '[class*="autocomplete-results" i]', '[class*="autocomplete-suggestions" i]', '[class*="suggestions-list" i]',
  // Floating-layer libraries: popper.js, Floating UI, Radix, Headless UI, Tippy
  '[class*="popper" i]', '[data-popper-placement]', '[data-floating-ui-portal]', '[data-radix-popper-content-wrapper]',
  '[id^="headlessui-listbox-options"]', '[id^="headlessui-menu-items"]', '[id^="headlessui-popover-panel"]',
  '[id^="headlessui-combobox-options"]', '[data-tippy-root]', '.tippy-box',
  // Select and autocomplete libraries: Select2, Chosen, Selectize, Tom Select, Choices.js, Google Places,
  // intl-tel-input, twitter typeahead, jQuery UI
  '.select2-dropdown', '.select2-results', '.chosen-drop', '.selectize-dropdown', '.ts-dropdown',
  '.choices__list--dropdown', '.pac-container', '.iti__dropdown-content', '.iti__country-list', '.tt-menu',
  '.ui-autocomplete',
  // Component frameworks: Angular Material / CDK, Ant Design, Element, Vuetify, PrimeReact, Kendo
  '.cdk-overlay-pane', '.mat-mdc-select-panel', '.mat-mdc-autocomplete-panel', '.mat-select-panel',
  '.mat-autocomplete-panel', '.ant-select-dropdown', '.ant-picker-dropdown', '.ant-dropdown',
  '.ant-cascader-dropdown', '.el-select-dropdown', '.el-picker-panel', '.el-popper', '.v-menu__content',
  '.p-dropdown-panel', '.p-multiselect-panel', '.p-autocomplete-panel', '.p-overlaypanel',
  '.k-animation-container', '.k-popup',
  // Date pickers: flatpickr, Pikaday, jQuery UI, react-datepicker, MUI, bootstrap-datepicker,
  // daterangepicker, Air Datepicker, vue-datepicker
  '[class*="flatpickr-calendar" i]', '[class*="pika-single" i]', '[class*="ui-datepicker" i]',
  '[class*="picker-dropdown" i]', '.react-datepicker-popper', '.MuiPickersPopper-root', '.datepicker-dropdown',
  '.daterangepicker', '.air-datepicker', '.vdp-datepicker__calendar', '.mx-datepicker-popup',
].join(', ');

/*
Dialogs, which are real page layers that can hold real questions
*/
const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/*
Calendars, so a date picker shown as a dialog still counts as temporary
*/
const CALENDAR_SELECTOR = '[role="grid"], [class*="calendar" i], [class*="datepicker" i], [class*="date-picker" i], [class*="daypicker" i], [class*="day-picker" i]';

/*
Controls that answer a question
*/
export const FIELD_NODE_SELECTOR = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
  'textarea', 'select',
  '[role="textbox"]', '[role="combobox"]', '[role="checkbox"]', '[role="radio"]', '[role="searchbox"]',
  '[role="spinbutton"]', '[role="switch"]', '[role="slider"]',
].join(', ');

/*
Caps on how much the scan collects and sends
*/
const MAX_ELEMENTS_TO_COLLECT = 900;
const MAX_ELEMENTS_TO_SEND = 500;
const MAX_TREE_DEPTH = 12;

/*************************************************************************************************
Visibility and temporary layers
*************************************************************************************************/

/*
What the containers around an element do to it: `faded` when one has opacity 0 or
content-visibility hidden, and `clipped` when one clips its content at zero size. A fixed element
escapes the clipping of the containers around it.
*/
export type VisibilityCache = Map<Element, { faded: boolean; clipped: boolean }>;
function aroundElement(node: Element | null, view: Window, cache: VisibilityCache): { faded: boolean; clipped: boolean } {
  if (!node || node === node.ownerDocument.body || node === node.ownerDocument.documentElement) return { faded: false, clipped: false };
  const known = cache.get(node);
  if (known) return known;
  const style = view.getComputedStyle(node);
  const outer = aroundElement(node.parentElement, view, cache);
  const zeroSize = (node as HTMLElement).offsetHeight === 0 || (node as HTMLElement).offsetWidth === 0;
  const clips = /hidden|clip/.test(style.overflow || '') && style.display !== 'contents' && zeroSize;
  const result = {
    faded: outer.faded || style.opacity === '0' || style.contentVisibility === 'hidden',
    clipped: clips || (style.position !== 'fixed' && outer.clipped),
  };
  cache.set(node, result);
  return result;
}

/*
Whether an element is shown: not hidden or inert, with a box, not display none, visibility hidden or
collapse, or opacity 0, and not faded or clipped by a container around it. A control's own opacity is
ignored, since styled radios and checkboxes hide the native input behind a custom one.
- one scan shares a cache, so each container is only checked once
*/
export function isElementVisible(element: Element, cache: VisibilityCache = new Map()): boolean {
  if (!(element instanceof HTMLElement)) return true;
  if (element.hidden || element.closest('[inert]')) return false;
  if (element.offsetWidth === 0 && element.offsetHeight === 0 && element.getClientRects().length === 0) return false;
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  if (!view || !style) return true;
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (style.contentVisibility === 'hidden') return false;
  if (style.opacity === '0' && !element.matches(FIELD_NODE_SELECTOR)) return false;
  if (isHiddenHelperField(element)) return false;
  const outer = aroundElement(element.parentElement, view, cache);
  return !outer.faded && (style.position === 'fixed' || !outer.clipped);
}

/*
A field no one can reach: out of the tab order, and hidden from assistive technology or moved far
off the page. Such as a form's spam trap ("Do not fill out this field") or a dropdown's hidden
validation input. A visually hidden native radio stays in the tab order, so it isn't one.
*/
function isHiddenHelperField(element: HTMLElement): boolean {
  if (element.getAttribute('tabindex') !== '-1' || !element.matches(FIELD_NODE_SELECTOR)) return false;
  if (element.closest('[aria-hidden="true"]')) return true;
  const rect = element.getBoundingClientRect?.();
  return !!rect && (rect.right < -100 || rect.bottom < -100 - (element.ownerDocument.defaultView?.scrollY ?? 0));
}

/*
A same-origin iframe's document, or null when it can't be read
*/
function readableFrameDoc(frame: Element): Document | null {
  try {
    return (frame as HTMLIFrameElement).contentDocument || null;
  } catch {
    return null;
  }
}

/*
Whether a layer holds the page itself (body, main, a form), so a wide class match like "menu" on
it isn't taken as a popup
*/
const PAGE_LEVEL_SELECTOR = 'main, article, form, h1, [role="main"]';
function isPageLevel(layer: Element): boolean {
  return layer.matches('html, body') || layer.matches(PAGE_LEVEL_SELECTOR) || !!layer.querySelector(PAGE_LEVEL_SELECTOR);
}

/*
The popups an open dropdown or menu points at through aria-controls or aria-owns, found even when
their classes say nothing. Cached briefly since the scan asks for every element.
*/
const POPUP_TRIGGER_SELECTOR = '[aria-expanded="true"][aria-haspopup]:not([aria-haspopup="false"]):not([aria-haspopup="dialog"]), [role="combobox"][aria-expanded="true"]';
let controlledCache: { doc: Document; at: number; selector: string } | null = null;
function controlledPopupSelector(doc: Document): string {
  const now = Date.now();
  if (controlledCache && controlledCache.doc === doc && now - controlledCache.at < 250) return controlledCache.selector;
  const ids = new Set<string>();
  doc.querySelectorAll(POPUP_TRIGGER_SELECTOR).forEach((trigger) => {
    for (const attr of ['aria-controls', 'aria-owns']) {
      (trigger.getAttribute(attr) || '').split(/\s+/).filter(Boolean).forEach((id) => ids.add(id));
    }
  });
  const selector = [...ids].map((id) => `[id="${id.replace(/["\\]/g, '\\$&')}"]`).join(', ');
  controlledCache = { doc, at: now, selector };
  return selector;
}

function nearestPopup(element: Element): Element | null {
  const named = element.closest(POPUP_SELECTOR);
  if (named && !isPageLevel(named)) return named;
  const controlled = controlledPopupSelector(element.ownerDocument);
  const open = controlled ? element.closest(controlled) : null;
  return open && !isPageLevel(open) ? open : null;
}

/*
Whether an element sits in a temporary layer. A dialog is a real layer unless it's a date picker; a
dropdown open inside a dialog is still temporary.
*/
export function isInTransientLayer(element: Element): boolean {
  const popup = nearestPopup(element);
  const dialog = element.closest(DIALOG_SELECTOR);
  if (dialog && (!popup || popup.contains(dialog))) {
    return dialog.matches(CALENDAR_SELECTOR) || !!dialog.querySelector(CALENDAR_SELECTOR);
  }
  return !!popup;
}

/*************************************************************************************************
Scanning
*************************************************************************************************/

/*
Collects the elements, including those in shadow roots and same-origin iframes
*/
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

/*
How many iframes can and can't be read. No form controls next to only cross-origin frames
usually means the form is in a frame the extension can't reach.
*/
export function countFrames() {
  let sameOrigin = 0;
  let crossOrigin = 0;
  document.querySelectorAll('iframe').forEach((frame) => {
    if (frame.hasAttribute('data-pageassist-interface')) return;
    if (readableFrameDoc(frame)) sameOrigin += 1; else crossOrigin += 1;
  });
  return { sameOrigin, crossOrigin };
}

/*
Controls, labels and headings go first, so the send cap never drops them
*/
const PRIORITY_ROLES = new Set(['textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'searchbox']);
function isPriorityElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'label' || tag === 'legend' || /^h[1-6]$/.test(tag)) return true;
  if ((element as HTMLElement).isContentEditable) return true;
  const role = element.getAttribute('role');
  return !!role && PRIORITY_ROLES.has(role);
}

/*
Whether a control is answered right now ('' for anything that isn't a control)
*/
function completionStatus(element: Element, selector: string): ScannedElement['completion_status'] {
  if (!element.matches(FIELD_NODE_SELECTOR) && !(element as HTMLElement).isContentEditable) return '';
  try {
    return isElementComplete(element, selector) ? 'complete' : 'incomplete';
  } catch {
    return '';
  }
}

/*
The nearest container around an element, crossing out of a shadow root
*/
function nearestContainer(element: Element): Element | null {
  const found = element.parentElement?.closest(CONTEXT_CONTAINER_SELECTOR);
  if (found) return found;
  const root = element.getRootNode?.();
  // 11 = DOCUMENT_FRAGMENT_NODE, a shadow root
  const host = root?.nodeType === 11 ? (root as ShadowRoot).host : null;
  if (!host) return null;
  return host.matches(CONTEXT_CONTAINER_SELECTOR) ? host : nearestContainer(host);
}

/*
A container's own top heading, when it has exactly one
*/
function ownHeading(container: Element): Element | undefined {
  const own = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((h) => nearestContainer(h) === container);
  const top = Math.min(...own.map((h) => Number(h.tagName[1])));
  const atTop = own.filter((h) => Number(h.tagName[1]) === top);
  return atTop.length === 1 ? atTop[0] : undefined;
}

/*
A container's label: its accessible name, else its caption child or own heading
*/
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

/*
A scan's result. Elements and containers go to the backend; fields are kept to diff against the
next scan.
*/
export type PageScan = {
  elements: ScannedElement[];
  containers: ScannedContainer[];
  fields: FieldSnapshot;
};

/*
Scans the page: leaves out temporary layers, ranks controls first, then records each element,
its container and, for controls, its question
*/
export function scanPage(): PageScan {
  try {
    const collected: Element[] = [];
    collectElementsDeep(document, collected);
    const visibility: VisibilityCache = new Map();
    const ranked = collected
      .filter((element) => { try { return !isInTransientLayer(element); } catch { return true; } })
      .map((element) => {
        try { return { element, visible: isElementVisible(element, visibility), priority: isPriorityElement(element) }; }
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

/*
Only the containers the given elements sit in, with their ancestors
*/
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

/*
The page's readable text, in full, for content the element scan only gets a snippet of
*/
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

/*************************************************************************************************
Question snapshots: what changed between two scans
*************************************************************************************************/

/*
Radios are keyed by their group, so a group is one question
*/
const RADIO_SELECTOR = 'input[type="radio" i], [role="radio"]';
const RADIO_GROUP_SELECTOR = '[role="radiogroup"], fieldset, [role="group"]';

/*
A question's key: its radio group, else the outermost control it sits in, else its own selector
*/
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

/*
One question and the controls it's made of
*/
export type FieldEntry = { visible: boolean; elements: ScannedElement[]; uploadGroup?: Element };

export type FieldSnapshot = Map<string, FieldEntry>;

/*
Questions that changed between two scans:
- added: new on the page
- revealed: on the page before but hidden, now shown (grouped per question)
- removed: gone from the page
- hidden: still on the page but no longer shown
*/
export type FieldDiff = {
  added: ScannedElement[];
  revealed: ScannedElement[][];
  removed: string[];
  hidden: string[];
};

/*
The wrapper around a file question, which stays when the upload swaps the input for a file chip
*/
export function uploadGroupOf(element: Element): Element | null {
  if (!element.matches('input[type="file" i]')) return null;
  const group = element.closest('[role="group"], fieldset') ?? element.closest('[class*="upload" i]');
  return group && !isPageLevel(group) ? group : null;
}

/*
Keeps a file question whose input left during an upload while its wrapper is still on the page
*/
export function carryUploadFields(before: FieldSnapshot, after: FieldSnapshot): FieldSnapshot {
  const carried: FieldSnapshot = new Map(after);
  for (const [key, entry] of before) {
    if (!carried.has(key) && entry.uploadGroup?.isConnected) carried.set(key, entry);
  }
  return carried;
}

/*
The questions added, revealed, removed or hidden between two snapshots
*/
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
