/*
The following file has the helpers for the items in a widget's state, which content.ts keeps
live on the page
- which page elements an item tracks
- whether the page marks an item's question as required
- splicing questions the page added or removed into a widget that is already showing, so a page
  change does not have to generate the whole widget again
*/

import { computeAccessibleName } from './selectors.ts';

export type WidgetItem = {
  selector?: string;
  selectors?: string[];
  label?: string;
  complete?: boolean;
  required?: boolean;
  manual?: boolean;
  section?: unknown;
  [key: string]: unknown;
};

// An item tracks one control (`selector`) or several that must ALL be filled to answer one question
// (`selectors` — first + last name, a date's month + year). Normalized to the list form.
export function itemSelectors(item: WidgetItem): string[] {
  if (Array.isArray(item.selectors) && item.selectors.length > 0) return item.selectors.filter((s): s is string => typeof s === 'string');
  return typeof item.selector === 'string' ? [item.selector] : [];
}

/*************************************************************************************************
Required questions
*************************************************************************************************/

/*
Marks that label a question as required, like "*" or "(required)"
*/
const REQUIRED_MARK_RE = /\*|\(required\)/i;

/*
The name of the question group around an element, which may carry the required mark
*/
function questionGroupName(element: Element): string {
  const group = element.closest('fieldset, [role="group"], [role="radiogroup"]');
  if (!group) return '';
  if (group.tagName.toLowerCase() === 'fieldset') return group.querySelector('legend')?.textContent ?? '';
  return computeAccessibleName(group);
}

/*
Whether the page marks an element as required: its attributes, its radio or checkbox group, a
wrapper, or a required mark in its name or its group's name
*/
export function isElementRequired(element: Element): boolean {
  if (element.hasAttribute('required')) return true;
  const own = element.getAttribute('aria-required');
  if (own !== null) return own === 'true';

  const type = (element.getAttribute('type') || '').toLowerCase();
  const name = element.getAttribute('name');
  if (element.tagName.toLowerCase() === 'input' && (type === 'radio' || type === 'checkbox') && name) {
    const scope = (element as HTMLInputElement).form ?? element.ownerDocument;
    const options = [...scope.querySelectorAll(`input[name="${CSS.escape(name)}"]`)];
    if (options.some((option) => option.hasAttribute('required'))) return true;
  }

  const wrapper = element.parentElement?.closest('[aria-required]');
  if (wrapper) return wrapper.getAttribute('aria-required') === 'true';

  if (REQUIRED_MARK_RE.test(computeAccessibleName(element)) || REQUIRED_MARK_RE.test(questionGroupName(element))) return true;
  return !!element.querySelector('[required], [aria-required="true"]');
}

/*
The members of an item that can't be answered (a line of text bundled in), left out of its
completion
*/
export function nonAnswerMembers(selectors: string[], resolve: (selector: string) => Element | null): string[] {
  if (selectors.length < 2) return [];
  const excluded = selectors.filter((selector) => {
    const element = resolve(selector);
    return !!element && !isQuestionElement(element);
  });
  return excluded.length < selectors.length ? excluded : [];
}

/*
Whether any element an item tracks is required
*/
export function isItemRequired(selectors: string[], resolve: (selector: string) => Element | null): boolean {
  return selectors.some((selector) => {
    const element = resolve(selector);
    return !!element && isElementRequired(element);
  });
}

/*************************************************************************************************
Splicing a page change into a live widget
*************************************************************************************************/

// toggle buttons (aria-pressed) hold an answer too, like a Yes/No pair
const ANSWER_ROLES = '[role="combobox"], [role="radiogroup"], [role="radio"], [role="checkbox"], [role="switch"], [role="listbox"], [role="textbox"], [role="spinbutton"], [role="slider"], [aria-pressed]';
const NON_ANSWER_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

function isAnswerControl(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input') return !NON_ANSWER_INPUT_TYPES.has((element.getAttribute('type') || '').toLowerCase());
  return tag === 'select' || tag === 'textarea' || (element as HTMLElement).isContentEditable === true || element.matches(ANSWER_ROLES);
}

// a question the user answers — a control, or a wrapper around one — not a heading, a button, or text
export function isQuestionElement(element: Element): boolean {
  return isAnswerControl(element) || [...element.querySelectorAll(`input, select, textarea, ${ANSWER_ROLES}`)].some(isAnswerControl);
}

// the first page element an item tracks that's on the page right now
function firstElement(item: WidgetItem, resolve: (selector: string) => Element | null): Element | null {
  for (const selector of itemSelectors(item)) {
    const element = resolve(selector);
    if (element) return element;
  }
  return null;
}

// Node.DOCUMENT_POSITION_FOLLOWING, spelled out so this doesn't depend on a global Node
const FOLLOWING = 4;

// where a new question goes so the list keeps the page's order: before the first tracked item that
// comes after it on the page, else right after the last tracked item
function insertionIndex(items: WidgetItem[], element: Element, resolve: (selector: string) => Element | null): number {
  for (const [i, item] of items.entries()) {
    const other = firstElement(item, resolve);
    if (other && other !== element && (element.compareDocumentPosition(other) & FOLLOWING)) return i;
  }
  let last = -1;
  items.forEach((item, i) => { if (itemSelectors(item).length > 0) last = i; });
  return last + 1;
}

export type SpliceResult = { items: WidgetItem[]; added: number; removed: number };

/*
Applies a page change to a widget's items without regenerating the widget:
- drops the controls that left the page (an item whose controls all left is removed)
- adds each new question (`add`, built from the new task-representation components) that's really on
  the page as an answerable question and isn't tracked yet, in page order, taking its neighbour's
  `section` when the widget groups items by one
*/
export function spliceWidgetItems(
  items: WidgetItem[],
  add: WidgetItem[],
  remove: string[],
  resolve: (selector: string) => Element | null,
): SpliceResult {
  const gone = new Set(remove);
  let removed = 0;
  const next: WidgetItem[] = [];
  for (const item of items) {
    const selectors = itemSelectors(item);
    const kept = selectors.filter((selector) => !gone.has(selector));
    if (kept.length === selectors.length) {
      next.push(item);
    } else if (kept.length > 0 && Array.isArray(item.selectors)) {
      next.push({ ...item, selectors: kept });
      removed += 1;
    } else {
      removed += 1;
    }
  }

  let added = 0;
  const tracked = new Set(next.flatMap(itemSelectors));
  for (const candidate of add) {
    const selectors = itemSelectors(candidate);
    if (selectors.length === 0 || selectors.some((selector) => tracked.has(selector))) continue;
    const element = firstElement(candidate, resolve);
    if (!element || !isQuestionElement(element)) continue;
    const index = insertionIndex(next, element, resolve);
    const neighbour = [next[index - 1], next[index]].find((item) => item && itemSelectors(item).length > 0);
    const item: WidgetItem = { ...candidate };
    if (item.section === undefined && typeof neighbour?.section === 'string') item.section = neighbour.section;
    next.splice(index, 0, item);
    selectors.forEach((selector) => tracked.add(selector));
    added += 1;
  }
  return { items: next, added, removed };
}
