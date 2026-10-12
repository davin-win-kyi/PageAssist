// Get the value of the current element without including whitespaces as an answer
export function attrValue(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

/*
Check if something is text fillable element, this includes the following: 
- input element 
- textarea element  
- select element
- any HTML element where the content is editable 
*/
export function isFillableElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || (element as HTMLElement).isContentEditable;
}

// typescript function call to check if something is checked or not
const isChecked = (element: Element): boolean => element.matches(':checked');

/*
basically returns the grouping for a given radio selection grouping or checkbox grouping
*/
function choiceGroup(input: HTMLInputElement, type: 'radio' | 'checkbox'): Element[] {
  const name = input.getAttribute('name');
  if (name) {
    const scope: ParentNode = input.form || input.ownerDocument;
    return [...scope.querySelectorAll(`input[type="${type}" i][name=${attrValue(name)}]`)];
  }
  const group = type === 'radio' ? input.closest('[role="radiogroup"], fieldset') : null;
  return group ? [...group.querySelectorAll('input[type="radio" i]')] : [input];
}

/*
This is to basically to check to see if a dropdown has a selected element
- check to see if the value is not disabled 
- if there is a value attribute
- and if the option with no spaces is greater than 0, to make sure it is a valid option
*/
function selectHasAnswer(select: HTMLSelectElement): boolean {
  return [...select.querySelectorAll('option:checked')].some((option) => {
    if (option.hasAttribute('disabled')) return false;
    const value = option.hasAttribute('value') ? option.getAttribute('value') : option.textContent;
    return (value || '').trim().length > 0;
  });
}

/*
Make sure if an element is filled with the following conditions: 
- radio: make sure that something is checked
- checkbox: make sure that something is checked
- file: make sure that the given file is not empty
- make sure that text of the element is not empty 
- dropdown: check to make sure the option chosen is valid
- area element: check that it is not empty 
- editable elements: check that is has content within it 
*/
export function isElementFilled(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    const type = (element.type || 'text').toLowerCase();

    // answering an ordinary radio group: any one of its options checked (never all of them)
    if (type === 'radio') return choiceGroup(element, 'radio').some(isChecked);

    // checking a checkbox answers it (in a same-name group, checking any one of them does)
    if (type === 'checkbox') return choiceGroup(element, 'checkbox').some(isChecked);

    // choosing a file answers it
    if (type === 'file') return (element.files?.length ?? 0) > 0;

    // entering non-empty text answers it — a field left with just spaces does not
    return element.value.trim().length > 0;
  }

  // choosing a non-empty option from a dropdown answers it
  if (element instanceof HTMLSelectElement) return selectHasAnswer(element);

  // if the area element is filled in or not (just spaces does not count)
  if (element instanceof HTMLTextAreaElement) return element.value.trim().length > 0;

  // if editable, is this elemenet filled in or not
  if ((element as HTMLElement).isContentEditable) return (element.textContent || '').trim().length > 0;
  return false;
}


// make sure that what is filled in is different from the given default value
export const DEFAULT_PRONE_INPUT_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time', 'number', 'range', 'color']);
export function isDefaultProneField(element: Element): boolean {
  if (element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return DEFAULT_PRONE_INPUT_TYPES.has((element.type || 'text').toLowerCase());
  return false;
}

/*
This is to get the field values of a given element
*/
export function fieldValue(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value;
  }
  return '';
}

const DEFAULT_PRONE_SELECTOR = ['select', ...[...DEFAULT_PRONE_INPUT_TYPES].map((type) => `input[type="${type}" i]`)].join(', ');

/*
This is used in order to get the initial default values for all of the elements 
- this is used in order to make sure that the updates are different from the user given values
*/
export function recordInitialValues(root: ParentNode, initialValues: WeakMap<Element, string>): void {
  const fields = [...(root.querySelectorAll?.(DEFAULT_PRONE_SELECTOR) ?? [])];
  if (root instanceof Element && root.matches(DEFAULT_PRONE_SELECTOR)) fields.unshift(root);
  for (const field of fields) {
    if (!initialValues.has(field)) initialValues.set(field, fieldValue(field));
  }
}


// Fields the user has visited (focused, then moved on from). Leaving a real default in a field you
// visited is choosing it as your answer.
export type VisitedFields = { has(element: Element): boolean };
const NONE_VISITED: VisitedFields = { has: () => false };

/*
This is used to check whether a user has completed an item with the following condiitons: 
- the element is filled
- for default prone elements, either:
  - its value is different from the baseline (the user changed it), or
  - the user visited it and left the default, which is itself a real answer (an untouched default
    is not — the user may not have seen it yet)
*/
function isFieldAnswered(element: Element, baseline: string | undefined, visited: VisitedFields): boolean {
  if (!isElementFilled(element)) return false;
  if (baseline === undefined || !isDefaultProneField(element)) return true;
  return fieldValue(element) !== baseline || visited.has(element);
}

/*
check for the answering of elements that include: 
- radio buttons, checkboxes, toggle buttons, option lists and custom select components
*/
export const SELECTED_CHOICE_SELECTOR = [
  'input:checked',
  '[aria-checked="true"]', '[aria-pressed="true"]', '[aria-selected="true"]',
  '[data-checked="true"]', '[data-selected="true"]', '[data-active="true"]',
  '[data-state="checked"]', '[data-state="active"]', '[data-state="on"]', '[data-state="selected"]',
].join(', ');

export const HAS_VALUE_SELECTOR = [
  '[class*="singleValue" i]', '[class*="single-value" i]',
  '[class*="multiValue" i]', '[class*="multi-value" i]',
  '[class*="clearIndicator" i]', '[class*="clear-indicator" i]',
  'button[aria-label*="clear" i]', 'button[aria-label*="remove" i]',
].join(', ');


/*
Completion through class names: 
- Considers the cases where the class name can indicate whether an element is completed or not
*/
const CHOSEN_WORDS = new Set(['selected', 'checked', 'chosen', 'pressed']);
const NEGATIONS = new Set(['un', 'not', 'non', 'no', 'de']);
function hasChosenClass(element: Element): boolean {
  return (element.getAttribute('class') || '').split(/\s+/).some((name) => {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/);
    return words.some((word, i) => CHOSEN_WORDS.has(word) && !NEGATIONS.has(words[i - 1] ?? ''));
  });
}

/*
Checks to see if for the following elements that a chosen class has been chosen
*/
export function isChosenOption(element: Element): boolean {
  if (element.matches?.(SELECTED_CHOICE_SELECTOR)) return true;
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  const optionish = tag === 'button' || tag === 'li' || tag === 'label'
    || role === 'button' || role === 'option' || role === 'radio' || role === 'checkbox' || role === 'switch';
  return optionish && hasChosenClass(element);
}

// Placeholder values for HTML Elements
export const PLACEHOLDER_RE = /^(select|choose|pick|search|enter|type to|start typing|please (select|choose|pick|enter|specify))\b|^(-{2,}|—|\.{3}|…)|^(none|nothing|no \w+) selected\b/i;

// For dropdown cases that can occur 
const DROPDOWN_CLASS_RE = /(^|[\s_-])(select|multiselect|dropdown|combobox)([\s_-]|$)/i;
const AUTOCOMPLETE_CLASS_RE = /(^|[\s_-])autocomplete([\s_-]|$)/i;
const isDropdownControl = (el: Element): boolean =>
  !!el.matches?.('[role="combobox"], [aria-haspopup="listbox"]') || DROPDOWN_CLASS_RE.test(el.getAttribute('class') || '');
const isSelectWidget = (el: Element): boolean =>
  isDropdownControl(el) || !!el.matches?.('[role="listbox"]') || AUTOCOMPLETE_CLASS_RE.test(el.getAttribute('class') || '');


/*
Check that a dropdown, selector or combobox does not have its default value
*/
export function comboboxHasValue(root: Element): boolean {
  const control = [root, ...(root.querySelectorAll?.('*') ?? [])].find(isDropdownControl);
  if (!control) return false;
  if (control.querySelector('label, legend, h1, h2, h3, h4, [class*="label" i]')) return false;
  // a rendered placeholder element (react-select's `__placeholder`, Ashby's `_placeholder_`) means
  // nothing is chosen, whatever its text says
  if (control.querySelector('[class*="placeholder" i]')) return false;
  const text = (control.textContent || '').replace(/\s+/g, ' ').trim()
    .replace(/[×✕✖⌄▾▼▾⌄˅]\s*$/g, '').trim();
  return text.length > 0 && !PLACEHOLDER_RE.test(text);
}

// Where there are input types that do not require text input
const NON_ANSWER_INPUT_TYPES = new Set(['radio', 'checkbox', 'hidden', 'submit', 'button', 'reset', 'image']);
const isHelperInput = (el: Element): boolean => !!el.matches?.('input[aria-hidden="true"], input[tabindex="-1"]');

/*
Dealing with ComboBoxes: 
- checks to see that if the element within a combo box that is meant to be filled is filled, and if it is
  filled it makes sure to see that the element is actually filled with the proper class name 
*/
function isComboboxSearchInput(el: Element): boolean {
  if (el.tagName !== 'INPUT' || !['text', 'search'].includes(((el as HTMLInputElement).type || 'text').toLowerCase())) return false;
  if (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete')) return true;
  for (let node = el.parentElement, i = 0; node && i < 6; node = node.parentElement, i += 1) {
    if (isSelectWidget(node)) return true;
  }
  return false;
}

/*
Some elements can have multiple possible fields, but only one of them is the main answer field which can be used 
- this function finds this main answer field and returns it to the user or return null if none is found
*/
export function primaryAnswerField(container: Element): Element | null {
  for (const el of container.querySelectorAll?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') ?? []) {
    if (el.tagName === 'INPUT' && NON_ANSWER_INPUT_TYPES.has((el as HTMLInputElement).type?.toLowerCase() || 'text')) continue;
    if (isHelperInput(el) || isComboboxSearchInput(el)) continue;
    return el;
  }
  return null;
}

// This method is a function variable which can be used to do a basic check of whether or not 
// an input type if a file or not 
const isFileInput = (el: Element): boolean => el.tagName === 'INPUT' && (el as HTMLInputElement).type?.toLowerCase() === 'file';

/*
This is used to check whether or not something is a radio type or not
*/
const CHOICE_SELECTOR = 'input[type="radio" i], input[type="checkbox" i], [role="radio"], [role="checkbox"], [role="switch"]';

/*
Checks to see if a container based element looks complete in other words elements that include: 
- primary answer fields, comboboxes
*/
export function containerLooksComplete(element: Element): boolean {
  const choices = [...(element.querySelectorAll?.(CHOICE_SELECTOR) ?? [])];
  if (choices.length > 0) return choices.some(isChosenOption);

  // This is a check for elements that are a file 
  const primary = primaryAnswerField(element);
  if (primary) {
    if (isElementFilled(primary)) return true;
    // a chosen file still counts after the widget resets its <input>: the attached file's remove button
    return isFileInput(primary) && !!element.querySelector?.(HAS_VALUE_SELECTOR);
  }

  // this is to check if a combobox is filled in or not
  if (element.querySelector?.(HAS_VALUE_SELECTOR) || comboboxHasValue(element)) return true;
  return [...(element.querySelectorAll?.('button, [role="button"], li, label') ?? [])]
    .some((option) => !option.closest('[role="listbox"], [role="menu"]') && isChosenOption(option));
}

// tries to see which of the parent elements that the element is associated with 
export function enclosingChoiceWidget(element: Element): Element | null {
  let node: Element | null = element.parentElement;
  let widget: Element | null = null;
  for (let i = 0; i < 6 && node; i += 1, node = node.parentElement) {
    const cls = typeof (node as HTMLElement).className === 'string' ? (node as HTMLElement).className : '';
    const selectish = /(^|[\s_-])(select|dropdown|combobox|listbox)([\s_-]|$)/i.test(cls)
      || node.matches?.('[role="radiogroup"], [role="group"], [aria-haspopup="listbox"]');
    if (selectish && node.querySelectorAll('input, textarea, select').length <= 3) {
      widget = node;
    } else if (widget) {
      break;
    }
  }
  return widget;
}

/*
So it checks if something is associated with something for a choice: 
- and this is mostly for radio button based elements 
- checkboxes
- as well as for toggles as well
*/
function hasChoiceState(element: Element): boolean {
  return element.matches(CHOICE_SELECTOR) || element.hasAttribute('aria-checked') || element.hasAttribute('aria-pressed')
    || !!element.querySelector(CHOICE_SELECTOR);
}

const EMPTY_SET: ReadonlySet<string> = new Set();

// check if checklist item is complete
export function isElementComplete(
  element: Element,
  selector: string,
  baselines?: Map<string, string>,
  interacted: ReadonlySet<string> = EMPTY_SET,
  visited: VisitedFields = NONE_VISITED,
): boolean {
  if (isFillableElement(element)) {
    // a react-select / custom combobox search box only holds filter text — the answer is the value the
    // widget shows. A free-text autocomplete (no enclosing widget) answers by its own text.
    if (isComboboxSearchInput(element) || isHelperInput(element)) {
      const widget = enclosingChoiceWidget(element);
      if (widget) return containerLooksComplete(widget);
    }
    // every other field answers by its own value alone
    return isFieldAnswered(element, baselines?.get(selector), visited);
  }
  if (isChosenOption(element) || containerLooksComplete(element)) return true;
  const widget = enclosingChoiceWidget(element);
  if (widget && widget !== element && containerLooksComplete(widget)) return true;
  // a plain button/link counts once clicked — but not a checkbox/switch/toggle, since clicking it on
  // and off again still leaves it unchecked
  return !hasChoiceState(element) && interacted.has(selector);
}

// method to check if an item is complete, and checks if all of the
// things encompasing the item is completed or not
export function isItemComplete(
  selectors: string[],
  resolve: (selector: string) => Element | null,
  baselines?: Map<string, string>,
  interacted: ReadonlySet<string> = EMPTY_SET,
  visited: VisitedFields = NONE_VISITED,
): boolean {
  if (selectors.length === 0) return false;
  return selectors.every((selector) => {
    const element = resolve(selector);
    return !!element && isElementComplete(element, selector, baselines, interacted, visited);
  });
}
