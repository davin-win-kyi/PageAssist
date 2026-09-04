// Selector / role / accessible-name computation, shared by content.ts (page scan, click tracking,
// widget-item grounding). One implementation so every caller agrees on how an element is named.
import { attrValue } from './completion.ts';

export { attrValue };

// Used everywhere a real element needs a selector: gathering page elements, tracking clicks, grounding
// a widget item.
export function computeSelector(element: Element): string {
  const el = element as HTMLElement;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = element.getAttribute('data-testid');
  if (testId) return `[data-testid=${attrValue(testId)}]`;
  // Real form controls almost always have a name — unique and stable even when nothing else is.
  const name = element.getAttribute('name');
  if (name) return `${element.tagName.toLowerCase()}[name=${attrValue(name)}]`;
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label=${attrValue(ariaLabel)}]`;
  // An id we injected on a previous scan (see stableSelector) — still better than a bare tag.
  const ref = element.getAttribute('data-tw-ref');
  if (ref) return `[data-tw-ref=${attrValue(ref)}]`;
  return element.tagName.toLowerCase();
}

// The selector to hand to the model / store on a widget item. When the element has nothing unique of
// its own, stamp a `data-tw-ref` on it and reference that. Custom dropdowns / toggle wrappers on real
// ATS pages (Ashby's div.select_container, SnorkelAI's, …) routinely have no id, name, testid or
// aria-label, so a bare tag selector would resolve to the wrong element.
let twRefCounter = 0;
export function stableSelector(element: Element): string {
  const natural = computeSelector(element);
  if (natural !== element.tagName.toLowerCase()) return natural; // already unique-ish
  try {
    const ref = `tw-${twRefCounter++}`;
    element.setAttribute('data-tw-ref', ref); // observer ignores data-tw-ref attribute mutations
    return `[data-tw-ref="${ref}"]`;
  } catch {
    return natural;
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

// Accessible name, in the order a screen reader resolves it: aria-label → aria-labelledby → associated
// <label> → placeholder → title. Truncated; empty when nothing names the element.
export function computeAccessibleName(element: Element): string {
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
