// Runs the REAL completion-detection logic against the REAL Greenhouse (Snorkel AI) EEO field markup.
//   node tests/plugin/completion.test.ts
// Uses linkedom for a DOM; no test framework.
import { parseHTML } from 'linkedom';

const dom = parseHTML('<!doctype html><html><body></body></html>');
// The completion module does `x instanceof HTMLInputElement` etc. against globals.
for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'] as const) {
  (globalThis as Record<string, unknown>)[k] = (dom as Record<string, unknown>)[k];
}

const { isElementComplete, enclosingChoiceWidget, isItemComplete, recordInitialValues } = await import('../../plugin/lib/completion.ts');

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
// The extracted edge-case fixes from the AccessCrafter audit.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 2. audit fixes ==');
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
// 3. Greenhouse phone field: <input type="tel"> in a <fieldset> that ALSO holds a country-code
//    react-select with a default value. The default must NOT complete an empty phone number.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 3. phone field next to a defaulted country dropdown ==');
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
// 4. Multi-selector items (state.items[].selectors) — a bundled question ("First & Last Name") is
//    only complete once EVERY required control is, not just whichever one the model listed first.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 4. multi-selector item (first + last name) ==');
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

// ---------------------------------------------------------------------------------------------------
// 5. A changed value has to be an answer too — not just different from where it started.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 5. pre-filled fields: changed AND still an answer ==');
{
  const baselines = new Map([['#start', '2026-10-08'], ['#pri', 'mid']]);
  const date = (value: string) => frag(`<input id="start" type="date" value="${value}" />`).querySelector('#start')!;
  check('a pre-filled date left as-is -> incomplete', isElementComplete(date('2026-10-08'), '#start', baselines), false);
  check('a pre-filled date CLEARED -> incomplete (a change, but not an answer)', isElementComplete(date(''), '#start', baselines), false);
  check('a pre-filled date changed to another date -> complete', isElementComplete(date('2026-11-01'), '#start', baselines), true);
  const blanked = frag('<select id="pri"><option value="" selected>Select…</option><option value="mid">Mid</option></select>').querySelector('#pri')!;
  check('a defaulted <select> moved to its blank "Select…" option -> incomplete', isElementComplete(blanked, '#pri', baselines), false);
  const wrappedSelect = frag('<div class="select-wrapper"><select id="pri"><option value="mid" selected>Mid</option></select></div>').querySelector('#pri')!;
  check('an untouched default stays incomplete even inside a "select"-classed wrapper', isElementComplete(wrappedSelect, '#pri', baselines), false);
}

// ---------------------------------------------------------------------------------------------------
// 5b. Leaving a default can be the answer: once the user has visited the field (focused it, then
//     moved on), a real default left in place counts. An untouched default still doesn't.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 5b. a visited field\'s kept default is an answer ==');
{
  const baselines = new Map([['#start', '2026-10-08'], ['#pri', 'mid'], ['#size', '']]);
  const visitedOnly = (element: Element) => ({ has: (e: Element) => e === element });
  const date = frag('<input id="start" type="date" value="2026-10-08" />').querySelector('#start')!;
  check('a pre-filled date the user visited and left as-is -> complete',
    isElementComplete(date, '#start', baselines, undefined, visitedOnly(date)), true);
  check('  the same date never visited -> incomplete', isElementComplete(date, '#start', baselines), false);
  const pri = frag('<select id="pri"><option value="low">Low</option><option value="mid" selected>Mid</option></select>').querySelector('#pri')!;
  check('a defaulted <select> the user visited and kept -> complete',
    isElementComplete(pri, '#pri', baselines, undefined, visitedOnly(pri)), true);
  const placeholder = frag('<select id="size"><option value="" selected>Select…</option><option value="m">M</option></select>').querySelector('#size')!;
  check('a visited <select> left on its blank "Select…" placeholder -> incomplete (not an answer)',
    isElementComplete(placeholder, '#size', baselines, undefined, visitedOnly(placeholder)), false);
  const other = frag('<input id="start" type="date" value="2026-10-08" />').querySelector('#start')!;
  check('visiting a DIFFERENT field doesn\'t confirm this one\'s default',
    isElementComplete(other, '#start', baselines, undefined, visitedOnly(date)), false);
}

// ---------------------------------------------------------------------------------------------------
// 6. A wrapper is decided by its OWN answer, and nothing unchosen ever reads as complete.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 6. a wrapper\'s own answer decides; all-unchosen is never complete ==');
{
  const consent = (checked: string) => frag(`<div id="consent">
    <input type="hidden" name="agree" value="0" />
    <label><input type="checkbox" id="agree" name="agree" value="1" ${checked} /> I agree to the terms</label></div>`).querySelector('#consent')!;
  check('Rails-style hidden "0" + an UNCHECKED checkbox -> incomplete', isElementComplete(consent(''), '#consent'), false);
  check('  the same checkbox checked -> complete', isElementComplete(consent('checked'), '#consent'), true);

  const email = frag(`<div id="email-q"><label for="email">Email</label><input id="email" type="email" value="" />
    <input type="hidden" name="source" value="linkedin" /></div>`).querySelector('#email-q')!;
  check('an empty answer field is not completed by a filled hidden input beside it', isElementComplete(email, '#email-q'), false);

  const phone = (number: string) => frag(`<fieldset id="phone-q"><legend>Phone</legend>
    <input type="hidden" name="phone_country" value="US" />
    <input id="phone" type="tel" value="${number}" /></fieldset>`).querySelector('#phone-q')!;
  check('an empty phone number is not completed by a filled country code beside it', isElementComplete(phone(''), '#phone-q'), false);
  check('  the phone number entered -> complete', isElementComplete(phone('4155551234'), '#phone-q'), true);

  const resume = frag(`<div id="resume-q" role="group"><div role="tablist">
      <button role="tab" aria-selected="true">Upload</button><button role="tab" aria-selected="false">Paste</button></div>
    <input id="resume" type="file" /></div>`).querySelector('#resume-q')!;
  check('a selected TAB in a file question is not an answer (no file chosen) -> incomplete', isElementComplete(resume, '#resume-q'), false);

  const toggle = (yes: string, no: string) => frag(`<div id="relocate" class="choice-group">
    <button class="option ${yes}">Yes</button><button class="option ${no}">No</button></div>`).querySelector('#relocate')!;
  check('options classed "unselected" / "is-unchecked" -> incomplete', isElementComplete(toggle('unselected', 'is-unchecked'), '#relocate'), false);
  check('options classed "not-selected" / "isNotSelected" -> incomplete', isElementComplete(toggle('not-selected', 'isNotSelected'), '#relocate'), false);
  check('  one option classed "is-selected" -> complete', isElementComplete(toggle('is-selected', 'unselected'), '#relocate'), true);

  const remote = (state: string) => frag(`<div id="remote" role="checkbox" aria-checked="${state}">Open to remote work</div>`).querySelector('#remote')!;
  check('a custom checkbox clicked on and off again (still aria-checked=false) -> incomplete',
    isElementComplete(remote('false'), '#remote', undefined, new Set(['#remote'])), false);
  check('  the same checkbox left checked -> complete', isElementComplete(remote('true'), '#remote', undefined, new Set(['#remote'])), true);
  const pressed = frag('<button id="ft" aria-pressed="false">Full-time only</button>').querySelector('#ft')!;
  check('a toggle button pressed and released (aria-pressed=false) -> incomplete',
    isElementComplete(pressed, '#ft', undefined, new Set(['#ft'])), false);
  const autofill = frag('<button id="autofill">Autofill with resume</button>').querySelector('#autofill')!;
  check('  while a plain button still counts once clicked', isElementComplete(autofill, '#autofill', undefined, new Set(['#autofill'])), true);

  const twoConsents = frag(`<div role="group">
    <label><input type="checkbox" id="terms" name="terms" /> I accept the terms</label>
    <label><input type="checkbox" id="news" name="newsletter" checked /> Send me news</label></div>`);
  check('an unchecked checkbox is not completed by a DIFFERENT checkbox next to it',
    isElementComplete(twoConsents.querySelector('#terms')!, '#terms'), false);

  const listboxDropdown = frag(`<div id="size" class="custom-dropdown"><span class="dd-display">Select…</span>
    <ul role="listbox" hidden><li role="option" aria-selected="true">Select…</li><li role="option">Small</li></ul></div>`).querySelector('#size')!;
  check('a dropdown whose hidden list pre-selects its "Select…" option -> incomplete', isElementComplete(listboxDropdown, '#size'), false);

  const typing = frag(hispanicControl('<div class="select__placeholder">Select...</div>', '')
    .replace('value=""', 'value="Not His"')).querySelector('#hispanic_ethnicity')!;
  check('filter text typed into a react-select (nothing chosen yet) -> incomplete', isElementComplete(typing, '#hispanic_ethnicity'), false);
  const city = frag('<label for="city">City</label><input id="city" type="text" role="combobox" aria-autocomplete="list" value="Seattle" />').querySelector('#city')!;
  check('  while a free-text autocomplete answers by its own text', isElementComplete(city, '#city'), true);
}

// ---------------------------------------------------------------------------------------------------
// 7. The behaviors that must keep working.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 7. kept: what DOES answer a question ==');
{
  const text = (value: string) => frag(`<input id="t" type="text" value="${value}" />`).querySelector('#t')!;
  check('entering non-empty text -> complete', isElementComplete(text('Ada'), '#t'), true);
  check('leaving a text field with just spaces -> incomplete', isElementComplete(text('   '), '#t'), false);
  const area = (value: string) => frag(`<textarea id="why">${value}</textarea>`).querySelector('#why')!;
  check('a textarea with just whitespace -> incomplete', isElementComplete(area('  \n  '), '#why'), false);

  const box = (checked: string) => frag(`<input id="c" type="checkbox" ${checked} />`).querySelector('#c')!;
  check('checking a checkbox -> complete', isElementComplete(box('checked'), '#c'), true);
  check('an unchecked checkbox -> incomplete', isElementComplete(box(''), '#c'), false);
  const skills = frag(`<fieldset><legend>Languages</legend>
    <label><input type="checkbox" id="py" name="skills[]" value="py" /> Python</label>
    <label><input type="checkbox" id="go" name="skills[]" value="go" checked /> Go</label></fieldset>`);
  check('a "select all that apply" group (shared name) is answered by any one checked', isElementComplete(skills.querySelector('#py')!, '#py'), true);

  const unnamed = frag(`<fieldset id="shift"><legend>Preferred shift</legend>
    <label><input type="radio" id="day" /> Day</label><label><input type="radio" id="night" checked /> Night</label></fieldset>`);
  check('answering an ordinary radio group (unnamed radios in a fieldset) -> complete', isElementComplete(unnamed.querySelector('#day')!, '#day'), true);
  const noneChosen = frag(`<fieldset><input type="radio" id="a1" name="q" /><input type="radio" id="a2" name="q" /></fieldset>`);
  check('a radio group with nothing chosen -> incomplete', isElementComplete(noneChosen.querySelector('#a1')!, '#a1'), false);

  const file = frag('<input id="cv" type="file" />').querySelector('#cv')!;
  check('a file input with no file -> incomplete', isElementComplete(file, '#cv'), false);
  Object.defineProperty(file, 'files', { value: { length: 1 } });
  check('choosing a file -> complete', isElementComplete(file, '#cv'), true);

  const select = (options: string) => frag(`<select id="s">${options}</select>`).querySelector('#s')!;
  check('choosing a non-empty dropdown option -> complete', isElementComplete(select('<option value="">Select…</option><option value="ca" selected>Canada</option>'), '#s'), true);
  check('a dropdown on its blank option -> incomplete', isElementComplete(select('<option value="" selected>Select…</option><option value="ca">Canada</option>'), '#s'), false);
  check('a dropdown on a DISABLED placeholder option -> incomplete', isElementComplete(select('<option disabled selected>Choose one</option><option>Canada</option>'), '#s'), false);
  check('a dropdown option "None" (no value attribute) is a real answer -> complete', isElementComplete(select('<option value="">Select…</option><option selected>None</option>'), '#s'), true);

  const custom = (attrs: string) => frag(`<div role="radiogroup" id="g"><div role="radio" id="o1" ${attrs}>Yes</div><div role="radio" id="o2">No</div></div>`).querySelector('#o1')!;
  check('custom state aria-checked="true" -> complete', isElementComplete(custom('aria-checked="true"'), '#o1'), true);
  check('custom state data-state="checked" -> complete', isElementComplete(custom('data-state="checked"'), '#o1'), true);
  check('custom state data-active="true" (Mantine segmented control) -> complete', isElementComplete(custom('data-active="true"'), '#o1'), true);
  check('custom chosen class "_selected_wp0mv_44" -> complete', isElementComplete(custom('class="_option_x _selected_wp0mv_44"'), '#o1'), true);
  check('custom chosen class "optionSelected" -> complete', isElementComplete(custom('class="optionSelected"'), '#o1'), true);
  check('custom chosen class "Mui-checked" -> complete', isElementComplete(custom('class="MuiRadio-root Mui-checked"'), '#o1'), true);
  check('no custom state at all -> incomplete', isElementComplete(custom('aria-checked="false"'), '#o1'), false);
}

// ---------------------------------------------------------------------------------------------------
// 8. Answers that look like placeholders: "None" / "N/A" are real choices.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 8. "None" and "N/A" are answers, not placeholders ==');
{
  const ashbyCombo = (display: string) => frag(`<div class="ashby-application-form-field-entry"><label>Disability status</label>
    <div class="_wrapper_1v5zz_28"><div id="dis" class="_select_1v5zz_36" role="combobox" aria-haspopup="listbox">${display}</div></div></div>`).querySelector('#dis')!;
  check('a chosen value "None" -> complete', isElementComplete(ashbyCombo('<div class="_value_1v5zz_58">None</div>'), '#dis'), true);
  check('a chosen value "N/A" -> complete', isElementComplete(ashbyCombo('<div class="_value_1v5zz_58">N/A</div>'), '#dis'), true);
  check('a chosen value "No" -> complete', isElementComplete(ashbyCombo('<div class="_value_1v5zz_58">No</div>'), '#dis'), true);
  check('"None selected" placeholder text -> incomplete', isElementComplete(ashbyCombo('<div class="_display_x">None selected</div>'), '#dis'), false);
  check('"Select..." placeholder text -> incomplete', isElementComplete(ashbyCombo('<div class="_display_x">Select...</div>'), '#dis'), false);
  check('a rendered placeholder element -> incomplete, whatever its text says', isElementComplete(ashbyCombo('<div class="_placeholder_1v5zz_50">None</div>'), '#dis'), false);
}

// ---------------------------------------------------------------------------------------------------
// 9. A field's default is its value when it FIRST appeared — not whatever it holds when a widget is
//    (re)applied. Greenhouse's "Start date year" is an <input type="number">: answering a question
//    that reveals another field regenerates the widget, and re-reading baselines then took the year
//    the user already typed as its "default", flipping "Start date" back to incomplete.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 9. first-seen values, not apply-time values, are the baseline ==');
{
  const body = frag(`<label for="start-year">Start date year</label><input id="start-year" type="number" value="" />
    <label for="country">Country</label><select id="country"><option value="us" selected>United States</option><option value="ca">Canada</option></select>`);
  const year = body.querySelector('#start-year')!;
  const country = body.querySelector('#country')!;
  const initial = new WeakMap<Element, string>();
  recordInitialValues(body, initial);                       // page load: nothing typed yet
  check('the empty year and the defaulted country are recorded as found', [initial.get(year), initial.get(country)].join('|'), '|us');

  year.setAttribute('value', '2020');                       // the user types the year
  recordInitialValues(body, initial);                       // the widget is regenerated and re-applied
  check('recording again never overwrites a first-seen value', initial.get(year), '');
  check('a typed year counts against its first-seen baseline -> complete',
    isElementComplete(year, '#start-year', new Map([['#start-year', initial.get(year)!]])), true);
  check('  (re-reading the baseline at apply time is what broke it -> incomplete)',
    isElementComplete(year, '#start-year', new Map([['#start-year', '2020']])), false);
  check('an untouched defaulted <select> is still not an answer',
    isElementComplete(country, '#country', new Map([['#country', initial.get(country)!]])), false);

  const revealed = frag('<div class="field"><input id="end-year" type="number" value="" /></div>').querySelector('.field')!;
  recordInitialValues(revealed, initial);                   // a field revealed later, as it appears
  check('a field that appears later is recorded when it appears', initial.has(revealed.querySelector('#end-year')!), true);
}

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
