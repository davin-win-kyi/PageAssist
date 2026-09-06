// Completion detection: given a real DOM element a checklist item is grounded on, is it "done"?
// Pure DOM reads only — no model, no network. Extracted from content.ts so it can be unit-tested
// against real markup (see completion.test.mjs). Every rule here is defensive against how framework
// UIs (react-select, segmented toggles, custom radio widgets) actually render on real ATS pages.

// Attribute-value string, quote/backslash-escaped for use inside [attr="..."].
export function attrValue(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

// A fill-based element (form control / editable region) has inherent, re-readable "has content" state.
export function isFillableElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || (element as HTMLElement).isContentEditable;
}

// Whether a fillable element currently has real content, read live from the actual element.
export function isElementFilled(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    const type = (element.type || 'text').toLowerCase();
    if (type === 'radio') {
      // Radios in a group are mutually exclusive — "answered" means ANY option in the group is
      // checked, never all of them. Query the group by name (form-scoped when there is a form).
      const name = element.name;
      if (name) {
        const scope: ParentNode = element.form || element.ownerDocument;
        return !!scope.querySelector(`input[type="radio"][name=${attrValue(name)}]:checked`);
      }
      return element.checked;
    }
    if (type === 'checkbox') return element.checked;
    if (type === 'file') return element.files !== null && element.files.length > 0;
    return element.value.trim().length > 0;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value.trim().length > 0;
  }
  if ((element as HTMLElement).isContentEditable) return (element.textContent || '').trim().length > 0;
  return false;
}

// Fields that commonly render with a real value before the user touches them (a <select> with no
// blank option; date/number/range/color/time inputs). For these, "filled" must mean "changed from
// the value it had when the widget was applied", not just "non-empty".
export const DEFAULT_PRONE_INPUT_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time', 'number', 'range', 'color']);
export function isDefaultProneField(element: Element): boolean {
  if (element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return DEFAULT_PRONE_INPUT_TYPES.has((element.type || 'text').toLowerCase());
  return false;
}
export function fieldValue(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value;
  }
  return '';
}

// A chosen option — a checked control or an ARIA/data "selected/pressed/on" state. Covers segmented
// Yes/No toggles, custom radio/checkbox widgets, chips, etc.
export const SELECTED_CHOICE_SELECTOR = [
  'input:checked',
  '[aria-checked="true"]', '[aria-pressed="true"]', '[aria-selected="true"]',
  '[data-checked="true"]', '[data-selected="true"]', '[data-active="true"]',
  '[data-state="checked"]', '[data-state="active"]', '[data-state="on"]', '[data-state="selected"]',
].join(', ');

// react-select / custom-combobox widgets: a rendered value chip, or a "clear" (×) control that only
// exists once something is chosen.
export const HAS_VALUE_SELECTOR = [
  '[class*="singleValue" i]', '[class*="single-value" i]',
  '[class*="multiValue" i]', '[class*="multi-value" i]',
  '[class*="clearIndicator" i]', '[class*="clear-indicator" i]',
  'button[aria-label*="clear" i]', 'button[aria-label*="remove" i]',
].join(', ');

// A class name marking "this option is the chosen one" — matches hashed names like `_selected_1s2`,
// `is-selected`, `optionSelected`. Deliberately narrow words so an unrelated `.active` doesn't count.
export const CHOSEN_CLASS_RE = /selected|checked|chosen|pressed/i;

export function isChosenOption(element: Element): boolean {
  if (element.matches?.(SELECTED_CHOICE_SELECTOR)) return true;
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  const optionish = tag === 'button' || tag === 'li' || tag === 'label' || role === 'button' || role === 'option' || role === 'radio';
  return optionish && CHOSEN_CLASS_RE.test((element as HTMLElement).className || '');
}

// A select/dropdown/combobox showing a real value rather than its placeholder. Covers native ARIA
// comboboxes AND class-only custom widgets (Ashby / SnorkelAI `div.select_container`, etc.).
export const PLACEHOLDER_RE = /^(select|choose|pick|please|search|type|--|—|none|n\/a|\.\.\.|…)\b/i;
export function comboboxHasValue(root: Element): boolean {
  const control = root.matches?.('[role="combobox"], [aria-haspopup="listbox"], [class*="select" i], [class*="dropdown" i], [class*="combobox" i]')
    ? root
    : root.querySelector?.('[role="combobox"], [aria-haspopup="listbox"], [class*="select" i], [class*="dropdown" i], [class*="combobox" i]');
  if (!control) return false;
  // Skip if this element also wraps the question's label/heading — its text would include the question,
  // which is never a placeholder, giving a false "complete".
  if (control.querySelector('label, legend, h1, h2, h3, h4, [class*="label" i]')) return false;
  const text = (control.textContent || '').replace(/\s+/g, ' ').trim()
    .replace(/[×✕✖⌄▾▼▾⌄˅]\s*$/g, '').trim(); // strip a trailing clear/caret glyph
  return text.length > 0 && !PLACEHOLDER_RE.test(text);
}

// A container's OWN answer field — the real, user-facing input/textarea/select whose value IS the
// answer. Excludes radio/checkbox (group-answered, handled separately), hidden/submit inputs, and the
// internal search box of a custom combobox/select widget (that's not the answer, the value chip is).
const NON_ANSWER_INPUT_TYPES = new Set(['radio', 'checkbox', 'hidden', 'submit', 'button', 'reset', 'image']);
const TEXT_INPUT_TYPES = new Set(['text', 'tel', 'email', 'url', 'number', 'search', 'password', 'date',
  'datetime-local', 'month', 'week', 'time', 'color', 'range']);
const SELECT_WIDGET_SELECTOR = '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [class*="select" i], [class*="combobox" i], [class*="dropdown" i], [class*="autocomplete" i]';
function isComboboxSearchInput(el: Element): boolean {
  if (el.matches?.('input[aria-hidden="true"], input[tabindex="-1"]')) return true;
  if (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete')) return true;
  return !!el.parentElement?.closest?.(SELECT_WIDGET_SELECTOR);
}
export function primaryAnswerField(container: Element): Element | null {
  for (const el of container.querySelectorAll?.('input, textarea, select') ?? []) {
    if (el.tagName === 'INPUT' && NON_ANSWER_INPUT_TYPES.has((el as HTMLInputElement).type?.toLowerCase() || 'text')) continue;
    if (isComboboxSearchInput(el)) continue;
    return el;
  }
  return null;
}
// A plain typed-value field (vs. a file input, or a custom widget with no real field).
function isPlainValueField(el: Element): boolean {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type?.toLowerCase() || 'text');
}

// The model often grounds a question on a WRAPPER (a labelled <div>, a <label>, a fieldset). "Complete"
// for a wrapper = it contains a filled field or a chosen option, by the strategies below.
export function containerLooksComplete(element: Element): boolean {
  if (element.querySelector?.(SELECTED_CHOICE_SELECTOR)) return true;              // native checked / ARIA / data-state
  for (const field of element.querySelectorAll?.('input, textarea, select') ?? []) {
    if (isElementFilled(field)) return true;                                      // a real filled control (incl. a paste-instead textarea)
  }
  // When this wrapper's own answer field is a plain, EMPTY typed-value field, don't let a
  // NEIGHBOURING widget's default value chip mark it done — a phone field's country-code dropdown
  // showing "+1" must not complete an empty phone number.
  const primary = primaryAnswerField(element);
  const emptyPlainField = !!primary && isPlainValueField(primary) && !isElementFilled(primary);
  if (!emptyPlainField) {
    if (element.querySelector?.(HAS_VALUE_SELECTOR)) return true;                  // react-select value chip / clear button
    if (comboboxHasValue(element)) return true;                                   // combobox showing a value, not a placeholder
  }
  for (const option of element.querySelectorAll?.('button, [role="button"], [role="option"], [role="radio"], li, label') ?? []) {
    if (isChosenOption(option)) return true;                                      // segmented toggle etc. marked by class
  }
  return false;
}

// Climb from a grounded element to the ANCESTOR container of the single-field widget it belongs to
// (a react-select `.select__container`, a radiogroup, a custom dropdown) — the element itself is never
// the answer (a react-select's own <input role="combobox"> is just the search box, always empty).
// Bounded so it can't reach a whole form section; returns null when there's no such wrapper.
export function enclosingChoiceWidget(element: Element): Element | null {
  let node: Element | null = element.parentElement;
  let widget: Element | null = null;
  for (let i = 0; i < 6 && node; i += 1, node = node.parentElement) {
    const cls = typeof (node as HTMLElement).className === 'string' ? (node as HTMLElement).className : '';
    const selectish = /(^|[\s_-])(select|dropdown|combobox|listbox)([\s_-]|$)/i.test(cls)
      || node.matches?.('[role="radiogroup"], [role="group"], [aria-haspopup="listbox"]');
    // A single-field widget has at most a couple of native inputs (search box + hidden submit value).
    if (selectish && node.querySelectorAll('input, textarea, select').length <= 3) {
      widget = node; // keep climbing — prefer the OUTERMOST single-field wrapper (holds the value display)
    } else if (widget) {
      break; // we've climbed out of the widget
    }
  }
  return widget;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

// The one entry point: is the checklist item grounded on `element` (with stored `selector`) complete?
// `baselines` = value each default-prone field had when the widget was applied.
// `interacted`  = selectors of buttons/links the user has activated this page-view.
export function isElementComplete(
  element: Element,
  selector: string,
  baselines?: Map<string, string>,
  interacted: ReadonlySet<string> = EMPTY_SET,
): boolean {
  if (isFillableElement(element)) {
    if (baselines && baselines.has(selector) && isDefaultProneField(element)) {
      if (fieldValue(element) !== baselines.get(selector)) return true;
    } else if (isElementFilled(element)) {
      return true;
    }
    // Empty — but it may be the search box of a react-select / a radio in a group whose value is
    // elsewhere. Check the enclosing single-field widget.
    const widget = enclosingChoiceWidget(element);
    return !!widget && containerLooksComplete(widget);
  }
  if (isChosenOption(element) || containerLooksComplete(element)) return true;
  // An option in a choice group (a custom radio, a segmented Yes/No): the chosen answer may be a
  // SIBLING option, so check the enclosing single-choice widget — same rule as native radio groups.
  const widget = enclosingChoiceWidget(element);
  if (widget && widget !== element && containerLooksComplete(widget)) return true;
  // A genuine button/link (or a wrapper with nothing filled inside) — did the user activate it?
  return interacted.has(selector);
}

// A checklist item grounded on MULTIPLE required controls (a widget item's `selectors: string[]` — a
// full name split into first/last, a full address) is complete only when EVERY one of them is. A
// single missing control (an empty Last Name next to a filled First Name) must not read as done —
// that was the bug: one selector per item could only ever track one of several required parts.
// `resolve` looks a selector up to a live Element (deepQuerySelector on the real page); a selector
// that no longer resolves counts as incomplete, same as isElementComplete's own missing-selector case.
export function isItemComplete(
  selectors: string[],
  resolve: (selector: string) => Element | null,
  baselines?: Map<string, string>,
  interacted: ReadonlySet<string> = EMPTY_SET,
): boolean {
  if (selectors.length === 0) return false;
  return selectors.every((selector) => {
    const element = resolve(selector);
    return !!element && isElementComplete(element, selector, baselines, interacted);
  });
}
