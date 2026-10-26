/*
This file is used by content.ts and page-scan.ts to agree on a common
convention on how to name the elements through selectors, and on their roles and names
*/
import { attrValue } from './completion.ts';

export { attrValue };

/*************************************************************************************************
Selectors
*************************************************************************************************/

/*
The selector stableSelector chose for each element, so the element reports the same one later,
even after it leaves the page
*/
const chosenSelectors = new WeakMap<Element, string>();

/*
Makes an address of the element
- uses the selector already chosen for it, a data-tw-ref stamp, its id, a data-testid,
  its name, or its aria-label
- not checked for uniqueness; stableSelector is the one handed to the model
*/
export function computeSelector(element: Element): string {
  const chosen = chosenSelectors.get(element);
  if (chosen) return chosen;
  const ref = element.getAttribute('data-tw-ref');
  if (ref) return `[data-tw-ref=${attrValue(ref)}]`;
  const el = element as HTMLElement;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = element.getAttribute('data-testid');
  if (testId) return `[data-testid=${attrValue(testId)}]`;
  const name = element.getAttribute('name');
  if (name) return `${element.tagName.toLowerCase()}[name=${attrValue(name)}]`;
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label=${attrValue(ariaLabel)}]`;
  return element.tagName.toLowerCase();
}

/*
The roots a selector is looked up in. content.ts searches the page's own document before any
shadow root or iframe, so a selector for an element inside one must not match in the document.
*/
function lookupRoots(element: Element): { own: ParentNode; before: ParentNode[] } {
  const own = (element.getRootNode?.() ?? element.ownerDocument) as ParentNode;
  const top = globalThis.document as Document | undefined;
  return { own, before: top && own !== top ? [top] : [] };
}

// Whether the selector matches this element and nothing else that content.ts could find first
function isUnique(element: Element, selector: string): boolean {
  try {
    const { own, before } = lookupRoots(element);
    const matches = own.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element && before.every((root) => !root.querySelector(selector));
  } catch {
    return false;
  }
}

// Whether content.ts would find this element first with the selector
function resolvesFirst(element: Element, selector: string): boolean {
  try {
    const { own, before } = lookupRoots(element);
    return own.querySelector(selector) === element && before.every((root) => !root.querySelector(selector));
  } catch {
    return false;
  }
}

/*
Attributes that identify an element on their own, in the order they're tried
*/
const IDENTIFYING_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder', 'for', 'href'];

/*
Attributes added to narrow a match, such as a radio's value among options sharing one name.
`value` only narrows choices and buttons, since a text field's value attribute can change as the
user types.
*/
const NARROWING_ATTRS = ['type', 'value', 'role', 'name', 'aria-label', 'data-testid'];
const FIXED_VALUE_SELECTOR = 'input[type="radio" i], input[type="checkbox" i], option, button, input[type="submit" i], input[type="button" i]';

/*
Selectors to try, from simplest to most specific: the id, one identifying attribute, then that
attribute with narrowing ones added one at a time
*/
function candidateSelectors(element: Element): string[] {
  const tag = element.tagName.toLowerCase();
  const fixedValue = element.matches(FIXED_VALUE_SELECTOR);
  const attr = (name: string) => {
    const value = element.getAttribute(name);
    return value && (name !== 'value' || fixedValue) ? `[${name}=${attrValue(value)}]` : '';
  };
  const out: string[] = [];
  if ((element as HTMLElement).id) out.push(`#${CSS.escape((element as HTMLElement).id)}`);
  for (const name of IDENTIFYING_ATTRS) {
    const base = attr(name);
    if (!base) continue;
    let combined = `${tag}${base}`;
    out.push(combined);
    for (const extra of NARROWING_ATTRS) {
      const more = extra === name ? '' : attr(extra);
      if (!more) continue;
      combined += more;
      out.push(combined);
    }
  }
  return out;
}

/*
The closest ancestor that a selector of its own picks out uniquely, to scope a descendant selector
*/
function uniqueAncestorSelector(element: Element): string | null {
  for (let node = element.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
    if (node.matches('html, body')) return null;
    const own = candidateSelectors(node).find((selector) => isUnique(node!, selector));
    if (own) return own;
  }
  return null;
}

/*
The selector to hand to the model, always unique to the element:
1. one it was already given (an earlier choice or a data-tw-ref stamp)
2. its id or attributes, alone or combined
3. those, or its tag, scoped under the closest uniquely identified ancestor
4. otherwise a new data-tw-ref stamp
*/
let twRefCounter = 0;
export function stableSelector(element: Element): string {
  // once chosen, a selector stays while it still finds this element first, so the element keeps
  // its identity when a look-alike is added after it
  const chosen = chosenSelectors.get(element);
  if (chosen && resolvesFirst(element, chosen)) return chosen;
  const ref = element.getAttribute('data-tw-ref');
  if (ref) return `[data-tw-ref=${attrValue(ref)}]`;

  const candidates = candidateSelectors(element);
  let selector = candidates.find((candidate) => isUnique(element, candidate));
  if (!selector) {
    const scope = uniqueAncestorSelector(element);
    const scoped = [...candidates, element.tagName.toLowerCase()].map((candidate) => `${scope} ${candidate}`);
    selector = scope ? scoped.find((candidate) => isUnique(element, candidate)) : undefined;
  }
  if (selector) {
    chosenSelectors.set(element, selector);
    return selector;
  }
  try {
    const stamp = `tw-${twRefCounter++}`;
    // the observer ignores data-tw-ref attribute mutations
    element.setAttribute('data-tw-ref', stamp);
    return `[data-tw-ref=${attrValue(stamp)}]`;
  } catch {
    return computeSelector(element);
  }
}

/*************************************************************************************************
Roles and accessible names
*************************************************************************************************/

/*
Get the role of an element
*/
const INPUT_TYPE_ROLE: Record<string, string> = {
  checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  email: 'textbox', tel: 'textbox', url: 'textbox', text: 'textbox', password: 'textbox',
  submit: 'button', button: 'button', reset: 'button',
};
export function computeRole(element: Element): string {
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

/*
Helpers used by compute Accessible Name and computer Accessible Description
*/
const idrefs = (element: Element, attribute: string): string[] =>
  (element.getAttribute(attribute) || '').split(/\s+/).filter(Boolean);

const clean = (text: string | null | undefined): string => (text || '').replace(/\s+/g, ' ').trim();

function textOfIds(element: Element, ids: string[]): string {
  return clean([...new Set(ids)]
    .map((id) => element.ownerDocument.getElementById(id)?.textContent || '')
    .join(' '));
}

// Links, buttons and headings are named by their own text when nothing ARIA overrides it.
const NAME_FROM_CONTENT = 'a, button, h1, h2, h3, h4, h5, h6, [role="link"], [role="button"], [role="heading"]';
const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset']);

/*
Get the accessible name of an element
*/
export function computeAccessibleName(element: Element): string {
  const labelledBy = textOfIds(element, idrefs(element, 'aria-labelledby'));
  if (labelledBy) return labelledBy;

  const label = clean(element.getAttribute('aria-label'));
  if (label) return label;

  // <img>, <area> and <input type="image">
  const alt = clean(element.getAttribute('alt'));
  if (alt) return alt;

  if (element.matches(NAME_FROM_CONTENT)) {
    // an icon-only link/button is named by its image's alt text
    const content = clean(element.textContent) || clean(element.querySelector('img[alt]')?.getAttribute('alt'));
    if (content) return content;
  }
  if (element.tagName.toLowerCase() === 'input' && BUTTON_INPUT_TYPES.has((element.getAttribute('type') || '').toLowerCase())) {
    // a submit or button input is named by its value
    const value = clean(element.getAttribute('value'));
    if (value) return value;
  }

  const id = (element as HTMLElement).id;
  if (id) {
    const forLabel = clean(element.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent);
    if (forLabel) return forLabel;
  }
  const wrappingLabel = clean(element.closest('label')?.textContent);
  if (wrappingLabel) return wrappingLabel;

  const placeholder = clean(element.getAttribute('placeholder'));
  if (placeholder) return placeholder;
  return clean(element.getAttribute('title'));
}

/*
Give the accessible description for an element
*/
export function computeAccessibleDescription(element: Element): string {
  const ids = idrefs(element, 'aria-describedby');
  if (element.getAttribute('aria-invalid') === 'true') ids.push(...idrefs(element, 'aria-errormessage'));
  const described = textOfIds(element, ids);
  if (described) return described;
  const title = clean(element.getAttribute('title'));
  if (title && title !== computeAccessibleName(element)) return title;
  return '';
}
