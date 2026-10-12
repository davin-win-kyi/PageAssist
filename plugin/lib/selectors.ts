// Selector / role / accessible-name computation, shared by content.ts (page scan, click tracking,
// widget-item grounding). One implementation so every caller agrees on how an element is named.
import { attrValue } from './completion.ts';

export { attrValue };

// Used everywhere a real element needs a selector: gathering page elements, tracking clicks, grounding
// a widget item. Identity-based, never positional (no nth-child), so it keeps naming the same element
// when siblings are added or removed around it. A data-tw-ref stamp outranks the natural attributes:
// stableSelector only stamps an element that has a natural selector when that selector is shared with
// an earlier element, and once stamped the element must keep its identity.
export function computeSelector(element: Element): string {
  const el = element as HTMLElement;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const ref = element.getAttribute('data-tw-ref');
  if (ref) return `[data-tw-ref=${attrValue(ref)}]`;
  const testId = element.getAttribute('data-testid');
  if (testId) return `[data-testid=${attrValue(testId)}]`;
  const name = element.getAttribute('name');
  if (name) return `${element.tagName.toLowerCase()}[name=${attrValue(name)}]`;
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label=${attrValue(ariaLabel)}]`;
  return element.tagName.toLowerCase();
}

// Does `selector` resolve to THIS element (the first match in its document / shadow root)? False when
// the selector can't be parsed — e.g. an aria-label containing a newline.
function resolvesTo(element: Element, selector: string): boolean {
  try {
    const root = (element.getRootNode?.() ?? element.ownerDocument) as ParentNode;
    return root.querySelector(selector) === element;
  } catch {
    return false;
  }
}

// The selector to hand to the model / store on a widget item — it must resolve back to this element.
// A testid / name / aria-label selector is kept only while this element is its first match: a second
// education entry reusing name="school", or a row of "Remove" buttons, would otherwise all ground on
// the first one. Otherwise — or when there's nothing natural at all (Ashby's div.select_container,
// SnorkelAI's toggle wrappers) — stamp a data-tw-ref and reference that.
let twRefCounter = 0;
export function stableSelector(element: Element): string {
  const current = computeSelector(element);
  if (current.startsWith('#') || current.startsWith('[data-tw-ref=')) return current;
  if (current !== element.tagName.toLowerCase() && resolvesTo(element, current)) return current;
  try {
    const ref = `tw-${twRefCounter++}`;
    element.setAttribute('data-tw-ref', ref); // observer ignores data-tw-ref attribute mutations
    return `[data-tw-ref=${attrValue(ref)}]`;
  } catch {
    return current;
  }
}

// ARIA role: explicit role= if present, else the implicit role for the tag / input type. Empty string
// when there's no meaningful role.
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

// Accessible name, in the order a screen reader resolves it: aria-labelledby → aria-label → alt → a
// link/button/heading's own text → associated <label> → placeholder → title. Returned in full — any
// length limit is the caller's call, never made during extraction. Empty when nothing names the element.
export function computeAccessibleName(element: Element): string {
  const labelledBy = textOfIds(element, idrefs(element, 'aria-labelledby'));
  if (labelledBy) return labelledBy;

  const label = clean(element.getAttribute('aria-label'));
  if (label) return label;

  const alt = clean(element.getAttribute('alt')); // <img>, <area>, <input type="image">
  if (alt) return alt;

  if (element.matches(NAME_FROM_CONTENT)) {
    // an icon-only link/button is named by its image's alt text
    const content = clean(element.textContent) || clean(element.querySelector('img[alt]')?.getAttribute('alt'));
    if (content) return content;
  }
  if (element.tagName.toLowerCase() === 'input' && BUTTON_INPUT_TYPES.has((element.getAttribute('type') || '').toLowerCase())) {
    const value = clean(element.getAttribute('value')); // <input type="submit" value="Apply">
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

// Accessible description — the help text, hint, or validation message wired to the element:
// aria-describedby, plus aria-errormessage while aria-invalid="true", else a title that isn't already
// serving as the name. Returned in full; empty when nothing describes it.
export function computeAccessibleDescription(element: Element): string {
  const ids = idrefs(element, 'aria-describedby');
  if (element.getAttribute('aria-invalid') === 'true') ids.push(...idrefs(element, 'aria-errormessage'));
  const described = textOfIds(element, ids);
  if (described) return described;
  const title = clean(element.getAttribute('title'));
  if (title && title !== computeAccessibleName(element)) return title;
  return '';
}
