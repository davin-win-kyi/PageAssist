/*
Completion contains the logic for the completion of
elements that are within the page for a specific task
that the user wants to be able to accomplish
- only elements whose state changes when they are answered are checked, such as fields,
  checkboxes, radio buttons, dropdowns and custom widgets
- buttons and links are actions that don't change when used, so they are never complete
*/

// Quotes a value for an attribute selector
export function attrValue(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

/*************************************************************************************************
Actions
*************************************************************************************************/

/*
Input types that are buttons or hidden data rather than answers
*/
const NON_FIELD_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/*
Every element that can hold an answer, used to find the control inside a label or a wrapper
*/
export const ANSWERABLE_SELECTOR = [
  [...NON_FIELD_INPUT_TYPES].reduce((selector, type) => `${selector}:not([type="${type}" i])`, 'input'),
  'select', 'textarea', '[contenteditable]:not([contenteditable="false"])',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="combobox"]', '[role="listbox"]',
  '[role="textbox"]', '[role="searchbox"]', '[role="slider"]', '[role="spinbutton"]',
].join(', ');

const ACTION_SELECTOR = [
  'a[href]', 'button', 'summary', '[role="button"]', '[role="link"]', '[role="menuitem"]',
  ...[...NON_FIELD_INPUT_TYPES].filter((type) => type !== 'hidden').map((type) => `input[type="${type}" i]`),
].join(', ');

// States that make a button a toggle or a dropdown that shows its choice, rather than an action
const BUTTON_STATE_SELECTOR = '[aria-checked], [aria-pressed], [aria-selected], [aria-valuenow], [aria-haspopup="listbox"]';

/*
Whether an element is an action, such as a submit, autofill or apply button, a link, or a tab. These
don't change when used, so nothing on the page could show them as done.
*/
export function isActionElement(element: Element): boolean {
  if (element.matches?.('[role="tab"]')) return true;
  if (!element.matches?.(ACTION_SELECTOR) || element.matches(BUTTON_STATE_SELECTOR)) return false;
  const cls = element.getAttribute('class') || '';
  if (hasChosenClass(element) || DROPDOWN_CLASS_RE.test(cls)) return false;
  return !element.querySelector(ANSWERABLE_SELECTOR);
}

/*************************************************************************************************
Native fields
*************************************************************************************************/

/*
Elements answered by their own value: an input, textarea, select or editable region
*/
export function isFillableElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input') return !NON_FIELD_INPUT_TYPES.has((element.getAttribute('type') || 'text').toLowerCase());
  return tag === 'textarea' || tag === 'select' || (element as HTMLElement).isContentEditable;
}

const isChecked = (element: Element): boolean => element.matches(':checked');

/*
The radio or checkbox group an input belongs to, by name or by its enclosing group
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
A dropdown is answered when a chosen option is enabled and not blank
*/
function selectHasAnswer(select: HTMLSelectElement): boolean {
  return [...select.querySelectorAll('option:checked')].some((option) => {
    if (option.hasAttribute('disabled')) return false;
    const value = option.hasAttribute('value') ? option.getAttribute('value') : option.textContent;
    return (value || '').trim().length > 0;
  });
}

/*
Whether a field holds an answer: a checked option in its group, a chosen file, a valid dropdown
option, or non-blank text
*/
export function isElementFilled(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    const type = (element.type || 'text').toLowerCase();
    if (NON_FIELD_INPUT_TYPES.has(type)) return false;
    if (type === 'radio') return choiceGroup(element, 'radio').some(isChecked);
    if (type === 'checkbox') return choiceGroup(element, 'checkbox').some(isChecked);
    if (type === 'file') return fileChosen(element);
    return element.value.trim().length > 0;
  }
  if (element instanceof HTMLSelectElement) return selectHasAnswer(element);
  if (element instanceof HTMLTextAreaElement) return element.value.trim().length > 0;
  if ((element as HTMLElement).isContentEditable) return (element.textContent || '').trim().length > 0;
  if (isValueWidget(element)) return (element.getAttribute('aria-valuenow') || '').trim().length > 0;
  return false;
}

/*************************************************************************************************
File uploads
*************************************************************************************************/

/*
A button an upload area only shows once a file is chosen, to remove or delete it
*/
const CHOSEN_FILE_SELECTOR = ['remove', 'delete'].flatMap((word) => ['button', '[role="button"]']
  .flatMap((control) => [`${control}[aria-label*="${word}" i]`, `${control}[title*="${word}" i]`])).join(', ');

// File types an upload area names its chosen file with
const FILE_TYPE_RE = /\.(pdf|docx?|odt|rtf|txt|md|pages|png|jpe?g|gif|webp|heic|mp4|mov|mp3|wav|m4a|zip)\b/gi;

/*
Whether text is a chosen file's name on its own, like "resume.pdf" or "My CV (2).docx (120 KB)",
rather than a sentence that mentions one ("e.g. resume.pdf", "upload resume.pdf or resume.docx") or a
list of accepted types (".pdf, .docx")
*/
function isFileName(text: string): boolean {
  const name = text.trim().replace(/\s*\([^)]*\)$/, '');
  const types = name.match(FILE_TYPE_RE) ?? [];
  return types.length === 1 && name.toLowerCase().endsWith(types[0].toLowerCase())
    && name.length <= 160 && /^[^\s.]/.test(name) && !/[,:\\/*?"<>|]|\.\s/.test(name);
}

/*
The area around a file input that shows the chosen file: the widest of its nearby wrappers that
holds no other field
*/
function uploadArea(input: Element): Element | null {
  let area: Element | null = null;
  for (let node = input.parentElement, i = 0; node && i < 4; node = node.parentElement, i += 1) {
    if ([...node.querySelectorAll(ANSWERABLE_SELECTOR)].some((field) => field !== input)) break;
    area = node;
  }
  return area;
}

/*
Whether an upload area shows a chosen file, by its name or a button to remove it
*/
export function showsChosenFile(area: Element): boolean {
  if (area.querySelector(CHOSEN_FILE_SELECTOR)) return true;
  return [...area.querySelectorAll('*')].some((el) => el.children.length === 0 && isFileName(el.textContent || ''));
}

/*
A file input is answered once a file is chosen: the input holds it, or the area around it shows it.
Many upload areas empty or replace their input once they've taken the file.
*/
function fileChosen(input: HTMLInputElement): boolean {
  if ((input.files?.length ?? 0) > 0) return true;
  const area = uploadArea(input);
  return !!area && showsChosenFile(area);
}

/*************************************************************************************************
Fields that always hold a value (defaults)
*************************************************************************************************/

/*
Fields that start with a value, like dates, numbers, sliders and dropdowns, so having one isn't an
answer on its own. Custom sliders and spin buttons are read through aria-valuenow.
*/
export const DEFAULT_PRONE_INPUT_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time', 'number', 'range', 'color']);
const VALUE_WIDGET_SELECTOR = '[role="slider"], [role="spinbutton"]';
const isValueWidget = (element: Element): boolean =>
  !isFillableElement(element) && !!element.matches?.(VALUE_WIDGET_SELECTOR);

export function isDefaultProneField(element: Element): boolean {
  if (element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return DEFAULT_PRONE_INPUT_TYPES.has((element.type || 'text').toLowerCase());
  return isValueWidget(element);
}

export function fieldValue(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value;
  }
  return isValueWidget(element) ? element.getAttribute('aria-valuenow') || '' : '';
}

const DEFAULT_PRONE_SELECTOR = [
  'select', VALUE_WIDGET_SELECTOR, ...[...DEFAULT_PRONE_INPUT_TYPES].map((type) => `input[type="${type}" i]`),
].join(', ');

/*
Records each default-prone field's starting value, so a later value can be compared against it
*/
export function recordInitialValues(root: ParentNode, initialValues: WeakMap<Element, string>): void {
  const fields = [...(root.querySelectorAll?.(DEFAULT_PRONE_SELECTOR) ?? [])];
  if (root instanceof Element && root.matches(DEFAULT_PRONE_SELECTOR)) fields.unshift(root);
  for (const field of fields) {
    if (!initialValues.has(field)) initialValues.set(field, fieldValue(field));
  }
}

/*
Fields the user focused and then left. Leaving a default in a visited field is choosing it.
*/
export type VisitedFields = { has(element: Element): boolean };
const NONE_VISITED: VisitedFields = { has: () => false };

/*
A filled field is answered, except a default-prone one still on its starting value that the user
never visited
*/
function isFieldAnswered(element: Element, baseline: string | undefined, visited: VisitedFields): boolean {
  if (!isElementFilled(element)) return false;
  if (baseline === undefined || !isDefaultProneField(element)) return true;
  return fieldValue(element) !== baseline || visited.has(element);
}

/*************************************************************************************************
Custom widgets
*************************************************************************************************/

/*
States that mark a custom radio, checkbox, toggle or option as chosen. A checkbox in the "mixed"
state has some of its options chosen.
*/
export const SELECTED_CHOICE_SELECTOR = [
  'input:checked',
  '[aria-checked="true"]', '[aria-checked="mixed"]', '[aria-pressed="true"]', '[aria-selected="true"]',
  '[data-checked="true"]', '[data-selected="true"]', '[data-active="true"]',
  '[data-state="checked"]', '[data-state="active"]', '[data-state="on"]', '[data-state="selected"]',
].join(', ');

/*
Pieces a custom dropdown only shows once something is chosen, like a value chip or a clear button
*/
export const HAS_VALUE_SELECTOR = [
  '[class*="singleValue" i]', '[class*="single-value" i]',
  '[class*="multiValue" i]', '[class*="multi-value" i]',
  '[class*="clearIndicator" i]', '[class*="clear-indicator" i]',
  'button[aria-label*="clear" i]', 'button[aria-label*="remove" i]',
].join(', ');

/*
A class name saying the element is chosen, like "is-selected" or "optionChecked", but not a
negated one like "unselected" or "not-checked"
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
Whether an option-like element, such as a button, list item, label or ARIA option, is the chosen
one. A selected tab is navigation, not an answer.
*/
export function isChosenOption(element: Element): boolean {
  if (element.matches?.('[role="tab"]')) return false;
  if (element.matches?.(SELECTED_CHOICE_SELECTOR)) return true;
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  const optionish = tag === 'button' || tag === 'li' || tag === 'label'
    || role === 'button' || role === 'option' || role === 'radio' || role === 'checkbox' || role === 'switch';
  return optionish && hasChosenClass(element);
}

/*
Options that exclude each other, like radio buttons or a Yes/No pair of toggle buttons
*/
const EXCLUSIVE_OPTION_SELECTOR = 'button[aria-pressed], [role="button"][aria-pressed], [role="radio"], [role="option"], [role="menuitemradio"]';

/*
The group an option or its hidden input belongs to: the nearest wrapper, within a few levels, that
holds at least two options
*/
function optionGroup(element: Element): Element | null {
  for (let node = element.parentElement, i = 0; node && i < 3; node = node.parentElement, i += 1) {
    if (node.querySelectorAll(EXCLUSIVE_OPTION_SELECTOR).length >= 2) return node;
  }
  return null;
}

// Placeholder text a dropdown shows before anything is chosen
export const PLACEHOLDER_RE = /^(select|choose|pick|search|enter|type to|start typing|please (select|choose|pick|enter|specify))\b|^(-{2,}|—|\.{3}|…)|^(none|nothing|no \w+) selected\b/i;

const DROPDOWN_CLASS_RE = /(^|[\s_-])(select|multiselect|dropdown|combobox)([\s_-]|$)/i;
const AUTOCOMPLETE_CLASS_RE = /(^|[\s_-])autocomplete([\s_-]|$)/i;
const isDropdownControl = (el: Element): boolean =>
  !!el.matches?.('[role="combobox"], [aria-haspopup="listbox"]') || DROPDOWN_CLASS_RE.test(el.getAttribute('class') || '');
const isSelectWidget = (el: Element): boolean =>
  isDropdownControl(el) || !!el.matches?.('[role="listbox"]') || AUTOCOMPLETE_CLASS_RE.test(el.getAttribute('class') || '');

/*
A custom dropdown shows a chosen value: text that isn't a label, a rendered placeholder or
placeholder wording
*/
export function comboboxHasValue(root: Element): boolean {
  const control = [root, ...(root.querySelectorAll?.('*') ?? [])].find(isDropdownControl);
  if (!control) return false;
  if (control.querySelector('label, legend, h1, h2, h3, h4, [class*="label" i]')) return false;
  if (control.querySelector('[class*="placeholder" i]')) return false;
  const text = (control.textContent || '').replace(/\s+/g, ' ').trim()
    .replace(/[×✕✖⌄▾▼▾⌄˅]\s*$/g, '').trim();
  return text.length > 0 && !PLACEHOLDER_RE.test(text);
}

/*
A listbox is answered once one of its options is selected or checked
*/
function listboxHasSelection(listbox: Element): boolean {
  return !!listbox.querySelector('[role="option"][aria-selected="true"], [role="option"][aria-checked="true"]');
}

/*
A custom textbox (role textbox or searchbox, not a native field) is answered by its text, unless
that text is its own placeholder
*/
const CUSTOM_TEXTBOX_SELECTOR = '[role="textbox"], [role="searchbox"]';
function customTextboxHasText(element: Element): boolean {
  const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
  const placeholder = (element.getAttribute('aria-placeholder') || element.getAttribute('data-placeholder') || '').trim();
  return text.length > 0 && text !== placeholder;
}

/*************************************************************************************************
Containers around a question
*************************************************************************************************/

const NON_ANSWER_INPUT_TYPES = new Set(['radio', 'checkbox', ...NON_FIELD_INPUT_TYPES]);
const isHelperInput = (el: Element): boolean => !!el.matches?.('input[aria-hidden="true"], input[tabindex="-1"]');

/*
The text box inside a custom dropdown, used to filter its options. Its text is a search, not the
answer.
*/
function isComboboxSearchInput(el: Element): boolean {
  if (el.tagName !== 'INPUT' || !['text', 'search'].includes(((el as HTMLInputElement).type || 'text').toLowerCase())) return false;
  if (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete')) return true;
  for (let node = el.parentElement, i = 0; node && i < 6; node = node.parentElement, i += 1) {
    if (isSelectWidget(node)) return true;
  }
  return false;
}

const isFileInput = (el: Element): boolean => el.tagName === 'INPUT' && (el as HTMLInputElement).type?.toLowerCase() === 'file';

/*
The field in a container that holds its answer, skipping helper and search inputs. A hidden file
input still holds the answer, since an upload's own button stands in for it.
*/
export function primaryAnswerField(container: Element): Element | null {
  for (const el of container.querySelectorAll?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') ?? []) {
    if (el.tagName === 'INPUT' && NON_ANSWER_INPUT_TYPES.has((el as HTMLInputElement).type?.toLowerCase() || 'text')) continue;
    if ((isHelperInput(el) && !isFileInput(el)) || isComboboxSearchInput(el)) continue;
    return el;
  }
  return null;
}

const CHOICE_SELECTOR = 'input[type="radio" i], input[type="checkbox" i], [role="radio"], [role="checkbox"], [role="switch"]';

/*
Whether a container around a question looks answered:
- a chosen option among its choices. An unchosen one doesn't settle it, since a page can keep a
  hidden checkbox under a Yes/No pair that stays unchecked when "No" is chosen.
- else its answer field is filled, or an upload shows its chosen file
- else a custom dropdown or a standalone listbox shows a value
- else one of its option buttons is chosen
*/
export function containerLooksComplete(element: Element): boolean {
  const choices = [...(element.querySelectorAll?.(CHOICE_SELECTOR) ?? [])];
  if (choices.some(isChosenOption)) return true;

  const primary = primaryAnswerField(element);
  if (primary) {
    if (isElementFilled(primary)) return true;
    return isFileInput(primary) && (!!element.querySelector?.(HAS_VALUE_SELECTOR) || showsChosenFile(element));
  }

  if (element.querySelector?.(HAS_VALUE_SELECTOR) || comboboxHasValue(element)) return true;
  // a standalone listbox, not the option list of a dropdown (which may pre-select its placeholder)
  const listbox = element.matches?.('[role="listbox"]') ? element : element.querySelector?.('[role="listbox"]');
  const inDropdown = [element, ...(element.querySelectorAll?.('*') ?? [])].some(isDropdownControl);
  if (listbox && !inDropdown && listboxHasSelection(listbox)) return true;
  return [...(element.querySelectorAll?.('button, [role="button"], li, label') ?? [])]
    .some((option) => !option.closest('[role="listbox"], [role="menu"]') && isChosenOption(option));
}

/*
The nearest custom dropdown or choice group around an element, within a few levels
*/
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

/*************************************************************************************************
Labels: judged by the question they name
*************************************************************************************************/

// A label for one option of a question, like "Yes" beside its radio button, rather than the question
function isOptionLabel(label: Element): boolean {
  const id = label.getAttribute('for');
  const target = (id ? label.ownerDocument.getElementById(id) : null) ?? label.querySelector(ANSWERABLE_SELECTOR);
  return !!target?.matches(CHOICE_SELECTOR);
}

/*
The field around a label whose `for` names no element, as when a page puts the question's id in a
name instead: the nearest wrapper holding a control or options, unless another question's label is
in it too
*/
function labelledField(label: Element): Element | null {
  for (let node = label.parentElement, i = 0; node && i < 3; node = node.parentElement, i += 1) {
    if (!node.querySelector(`${ANSWERABLE_SELECTOR}, ${EXCLUSIVE_OPTION_SELECTOR}`)) continue;
    const questions = [...node.querySelectorAll('label')].filter((other) => !isOptionLabel(other));
    return questions.length === 1 ? node : null;
  }
  return null;
}

/*
The question an element names, for an element that holds no answer itself:
- a <label> names its `for` control, or the control inside it, or else the field it sits in
- an element whose id a control or group points at with aria-labelledby
- a <legend> names its fieldset, and a table row's header names its row
*/
function labelledQuestion(element: Element): Element | null {
  const tag = element.tagName.toLowerCase();
  if (tag === 'label') {
    const id = element.getAttribute('for');
    const control = (id ? element.ownerDocument.getElementById(id) : null) ?? element.querySelector(ANSWERABLE_SELECTOR);
    if (control) return control;
    const field = labelledField(element);
    if (field) return field;
  }
  const ownId = (element as HTMLElement).id;
  const named = ownId ? element.ownerDocument.querySelector(`[aria-labelledby~=${attrValue(ownId)}]`) : null;
  if (named && named !== element) return named;
  const parent = element.parentElement;
  if (tag === 'legend' && parent?.tagName.toLowerCase() === 'fieldset') return parent;
  if (tag === 'th' && parent?.tagName.toLowerCase() === 'tr' && parent.querySelector(ANSWERABLE_SELECTOR)) return parent;
  return null;
}

/*
The element that actually holds the answer for an element: the question a label-like element
names, else the element itself
*/
export function answeringElement(element: Element): Element {
  if (element.matches(ANSWERABLE_SELECTOR) || element.querySelector(ANSWERABLE_SELECTOR)) return element;
  return labelledQuestion(element) ?? element;
}

/*************************************************************************************************
Item completion
*************************************************************************************************/

/*
Whether the element a checklist item tracks is answered. An action is never complete. A search or
helper input inside a custom dropdown is judged by the dropdown, and a label by what it names.
*/
export function isElementComplete(
  element: Element,
  selector: string,
  baselines?: Map<string, string>,
  visited: VisitedFields = NONE_VISITED,
): boolean {
  if (isActionElement(element)) return false;
  const answering = answeringElement(element);
  if (answering !== element && !isActionElement(answering)) return elementHoldsAnswer(answering, selector, baselines, visited);
  return elementHoldsAnswer(element, selector, baselines, visited);
}

function elementHoldsAnswer(element: Element, selector: string, baselines: Map<string, string> | undefined, visited: VisitedFields): boolean {
  if (isFillableElement(element)) {
    if (isComboboxSearchInput(element) || isHelperInput(element)) {
      // judged by its dropdown, or for a hidden checkbox or radio, by the options it stands behind
      const behind = element.matches(CHOICE_SELECTOR) ? optionGroup(element) : null;
      const widget = enclosingChoiceWidget(element) ?? behind;
      if (widget) return containerLooksComplete(widget);
    }
    return isFieldAnswered(element, baselines?.get(selector), visited);
  }
  if (isValueWidget(element)) return isFieldAnswered(element, baselines?.get(selector), visited);
  if (element.matches?.(CUSTOM_TEXTBOX_SELECTOR)) return customTextboxHasText(element);

  if (isChosenOption(element) || containerLooksComplete(element)) return true;
  // an option answers for its group, as a radio button does: "Yes" is answered once "No" is chosen
  const group = element.matches?.(EXCLUSIVE_OPTION_SELECTOR) ? optionGroup(element) : null;
  if (group && containerLooksComplete(group)) return true;
  const widget = enclosingChoiceWidget(element);
  return !!widget && widget !== element && containerLooksComplete(widget);
}

/*
An item is complete once every element it tracks is answered, such as both the country code and
the number of a phone question
*/
export function isItemComplete(
  selectors: string[],
  resolve: (selector: string) => Element | null,
  baselines?: Map<string, string>,
  visited: VisitedFields = NONE_VISITED,
): boolean {
  if (selectors.length === 0) return false;
  return selectors.every((selector) => {
    const element = resolve(selector);
    return !!element && isElementComplete(element, selector, baselines, visited);
  });
}
