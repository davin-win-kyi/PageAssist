// Runs the REAL completion-detection logic against the REAL Greenhouse (Snorkel AI) EEO field markup.
//   node tests/plugin/completion.test.ts
// Uses linkedom for a DOM; no test framework.
import { parseHTML } from 'linkedom';

const dom = parseHTML('<!doctype html><html><body></body></html>');
// The completion module does `x instanceof HTMLInputElement` etc. against globals.
for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'] as const) {
  (globalThis as Record<string, unknown>)[k] = (dom as Record<string, unknown>)[k];
}

const { isElementComplete, enclosingChoiceWidget, isItemComplete } = await import('../../plugin/lib/completion.ts');

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${ok ? '' : `  got ${got}, want ${want}`}`);
  ok ? (pass += 1) : (fail += 1);
}

function frag(html: string): Element {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return document.body as unknown as Element;
}

// ---------------------------------------------------------------------------------------------------
// Greenhouse react-select markup for "Are you Hispanic/Latino?" — from the live page source.
// ---------------------------------------------------------------------------------------------------
const hispanicControl = (valueRow: string, indicators: string) => `
  <div class="field">
    <label id="hispanic_ethnicity-label" for="hispanic_ethnicity" class="label select__label">Are you Hispanic/Latino?</label>
    <div class="select__container">
      <div class="select__control remix-css-13cymwt-control">
        <div class="select__value-container remix-css-hlgwow">
          ${valueRow}
          <div class="select__input-container remix-css-19bb58m">
            <input id="hispanic_ethnicity" class="select__input" type="text" role="combobox"
                   aria-expanded="false" aria-haspopup="true" aria-labelledby="hispanic_ethnicity-label" value="" />
          </div>
        </div>
        <div class="select__indicators remix-css-1wy0on6">${indicators}</div>
      </div>
    </div>
  </div>`;

const EMPTY = hispanicControl(
  '<div class="select__placeholder remix-css-1jqq78o-placeholder" id="react-select-hispanic_ethnicity-placeholder">Select...</div>',
  '<div class="select__indicator select__dropdown-indicator remix-css-1xc3v61-indicatorContainer">▾</div>',
);
const FILLED = hispanicControl(
  '<div class="select__single-value remix-css-1dimb5e-singleValue">Not Hispanic or Latino</div>',
  '<div class="select__indicator select__clear-indicator remix-css-1xc3v61">×</div>' +
  '<div class="select__indicator select__dropdown-indicator remix-css-1xc3v61">▾</div>',
);

console.log('== 1. "Are you Hispanic/Latino?" completion (real react-select) ==');
{
  const body = frag(EMPTY);
  const input = body.querySelector('#hispanic_ethnicity')!;
  check('enclosingChoiceWidget resolves to .select__container',
    enclosingChoiceWidget(input)?.className.includes('select__container'), true);
  check('empty (placeholder "Select...") -> incomplete', isElementComplete(input, '#hispanic_ethnicity'), false);
}
{
  const body = frag(FILLED);
  const input = body.querySelector('#hispanic_ethnicity')!;
  check('value chosen ("Not Hispanic or Latino") -> complete', isElementComplete(input, '#hispanic_ethnicity'), true);
}

// ---------------------------------------------------------------------------------------------------
// Structural detection: value-select must NOT count; a revealed field (race) MUST.
// Mirrors the field-set diff in content.ts's handlePageChange.
// ---------------------------------------------------------------------------------------------------
const FIELD_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'spinbutton', 'switch']);
const POPUP_SELECTOR = '[role="listbox"], [role="menu"], [role="tooltip"], [aria-modal="true"], [class*="menu" i], [class*="popover" i], [class*="popup" i], [class*="tooltip" i], [class*="option-list" i], [class*="options-list" i]';
const PAGE_ELEMENT_SELECTOR = 'a, button, input, textarea, select, option, label, fieldset, legend, form, h1, h2, h3, h4, h5, h6, [id], [data-testid], [aria-label], [aria-labelledby], [aria-required], [role], [contenteditable="true"]';

function fieldSet(body: Element): Set<string> {
  const els = [...body.querySelectorAll(PAGE_ELEMENT_SELECTOR)].filter((e) => !e.closest?.(POPUP_SELECTOR));
  return new Set(
    els
      // No 'label' — a <label> is a control's accessible name, not a field of its own (see page-scan.ts).
      .filter((e) => ['input', 'textarea', 'select', 'fieldset', 'legend'].includes(e.tagName.toLowerCase())
        || FIELD_ROLES.has(e.getAttribute('role') || ''))
      .map((e, i) => e.id || e.getAttribute('for') || `${e.tagName}#${i}`),
  );
}
function diff(before: Set<string>, after: Set<string>) {
  let added = 0;
  let removed = 0;
  after.forEach((s) => { if (!before.has(s)) added += 1; });
  before.forEach((s) => { if (!after.has(s)) removed += 1; });
  return { added, removed, structural: added + removed >= 1 };
}

const raceField = `
  <div class="field">
    <label id="race-label" for="race" class="label select__label">Please identify your race</label>
    <div class="select__container"><div class="select__control"><div class="select__value-container">
      <div class="select__placeholder">Select...</div>
      <div class="select__input-container"><input id="race" role="combobox" type="text" value="" /></div>
    </div></div></div>
  </div>`;
const openMenu = `
  <div class="select__menu remix-css-menu"><div class="select__menu-list" role="listbox">
    <div class="select__option" role="option" id="react-select-hispanic_ethnicity-option-0">Decline To Self Identify</div>
    <div class="select__option" role="option" id="react-select-hispanic_ethnicity-option-1">Hispanic or Latino</div>
    <div class="select__option" role="option" id="react-select-hispanic_ethnicity-option-2">Not Hispanic or Latino</div>
  </div></div>`;

console.log('\n== 2. structural change detection ==');
{
  const base = fieldSet(frag(EMPTY));
  check('picking a value (placeholder -> single-value) is NOT structural',
    diff(base, fieldSet(frag(FILLED))).structural, false);
  check('opening the dropdown menu is NOT structural (options are in a popup)',
    diff(base, fieldSet(frag(EMPTY + openMenu))).structural, false);
  const afterRace = diff(base, fieldSet(frag(EMPTY + raceField)));
  check('a revealed "race" field IS structural', afterRace.structural, true);
  check('  and reports fieldsAdded = 1 (the combobox input; the <label> does not count)', afterRace.added, 1);
}

// ---------------------------------------------------------------------------------------------------
// The extracted edge-case fixes from the AccessCrafter audit.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 3. audit fixes ==');
{
  const body = frag(`
    <fieldset id="veteran">
      <label><input type="radio" name="veteran_status" value="1" /> I am not a protected veteran</label>
      <label><input type="radio" name="veteran_status" value="2" checked /> I identify as a protected veteran</label>
      <label><input type="radio" name="veteran_status" value="3" /> I don't wish to answer</label>
    </fieldset>`);
  const firstRadio = body.querySelector('input[value="1"]')!; // NOT the checked one
  check('radio group: complete when ANY option in the name-group is checked',
    isElementComplete(firstRadio, 'input[name="veteran_status"][value="1"]'), true);
}
{
  const baselines = new Map([['#pri', 'mid']]); // its value at widget-apply time
  const unchanged = frag('<select id="pri"><option value="mid" selected>Mid</option><option value="high">High</option></select>').querySelector('#pri')!;
  check('default-prone <select>: unchanged from baseline -> incomplete',
    isElementComplete(unchanged, '#pri', baselines), false);
  const changed = frag('<select id="pri"><option value="mid">Mid</option><option value="high" selected>High</option></select>').querySelector('#pri')!;
  check('default-prone <select>: moved off baseline -> complete',
    isElementComplete(changed, '#pri', baselines), true);
}

// ---------------------------------------------------------------------------------------------------
// 4. Greenhouse phone field: <input type="tel"> in a <fieldset> that ALSO holds a country-code
//    react-select with a default value. The default must NOT complete an empty phone number.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 4. phone field next to a defaulted country dropdown ==');
{
  const phoneFieldset = (phoneValue: string) => `
    <fieldset id="phone-fs">
      <div class="select"><div class="select__container">
        <label id="phone_country-label" for="phone_country" class="select__label">Country code</label>
        <div class="select__control"><div class="select__value-container">
          <div class="select__single-value">United States +1</div>
          <div class="select__input-container"><input id="phone_country" class="select__input" role="combobox" value="" /></div>
        </div><div class="select__indicators"><div class="select__indicator select__clear-indicator">×</div></div></div>
      </div></div>
      <input required tabindex="-1" aria-hidden="true" class="requiredInput" value="" />
      <div class="phone-input__phone"><div class="input-wrapper">
        <label id="phone-label" for="phone" class="label">Phone<span aria-hidden="true">*</span></label>
        <input id="phone" class="input" aria-label="Phone" type="tel" value="${phoneValue}" />
      </div></div>
    </fieldset>`;
  // Item grounded on the fieldset wrapper (the failure mode).
  const emptyFs = frag(phoneFieldset('')).querySelector('#phone-fs')!;
  check('empty phone (country dropdown defaulted) -> incomplete', isElementComplete(emptyFs, '#phone-fs'), false);
  const filledFs = frag(phoneFieldset('4155551234')).querySelector('#phone-fs')!;
  check('phone number entered -> complete', isElementComplete(filledFs, '#phone-fs'), true);
  // Item grounded directly on the <input type="tel">.
  const emptyInput = frag(phoneFieldset('')).querySelector('#phone')!;
  check('empty phone (grounded on the input) -> incomplete', isElementComplete(emptyInput, '#phone'), false);
  // The country dropdown itself, grounded on its own container, IS complete (it has a value).
  const country = frag(phoneFieldset('')).querySelector('#phone-fs .select__container')!;
  check('the country dropdown (its own container) -> complete', isElementComplete(country, '.select__container'), true);
}

// ---------------------------------------------------------------------------------------------------
// 5. Multi-selector items (state.items[].selectors) — a bundled question ("First & Last Name") is
//    only complete once EVERY required control is, not just whichever one the model listed first.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 5. multi-selector item (first + last name) ==');
{
  const nameForm = (first: string, last: string) => frag(`
    <label for="first_name">First Name</label><input id="first_name" type="text" value="${first}" />
    <label for="last_name">Last Name</label><input id="last_name" type="text" value="${last}" />`);
  const resolve = (root: Element) => (selector: string) => root.querySelector(selector);

  const onlyFirst = nameForm('Davin', '');
  check('first filled, last empty -> item NOT complete (the actual reported bug)',
    isItemComplete(['#first_name', '#last_name'], resolve(onlyFirst)), false);

  const bothFilled = nameForm('Davin', 'Winkyi');
  check('both filled -> item complete',
    isItemComplete(['#first_name', '#last_name'], resolve(bothFilled)), true);

  const neitherFilled = nameForm('', '');
  check('neither filled -> item NOT complete',
    isItemComplete(['#first_name', '#last_name'], resolve(neitherFilled)), false);

  check('a selector that fails to resolve -> item NOT complete',
    isItemComplete(['#first_name', '#missing'], resolve(bothFilled)), false);

  check('empty selector list -> not complete (caller should use a manual item instead)',
    isItemComplete([], resolve(bothFilled)), false);
}

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
