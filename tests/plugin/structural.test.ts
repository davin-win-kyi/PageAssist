// Runs the REAL client-side structural-change detection (plugin/lib/page-scan.ts::currentFieldSet,
// which drives content.ts's handlePageChange) against the real Greenhouse / Snorkel AI EEO form:
// answering "Are you Hispanic/Latino?" reveals a follow-up "race" field, and that MUST register as a
// structural change (a new field-ish selector) — which is what triggers re-analyze + regenerate.
//   node tests/plugin/structural.test.ts
import { parseHTML } from 'linkedom';

// --- shims the plugin modules expect from a browser -------------------------------------------
const boot = parseHTML('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'HTMLInputElement',
                 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLIFrameElement', 'ShadowRoot'] as const) {
  (globalThis as Record<string, unknown>)[k] = (boot as unknown as Record<string, unknown>)[k];
}
(globalThis as Record<string, unknown>).CSS = { escape: (s: string) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? (pass += 1) : (fail += 1);
}

// Load `document` as the page under test, then import page-scan (its getPageElements uses the global).
// linkedom has no getComputedStyle / layout metrics — shim them so isElementVisible doesn't throw
// (in a real browser these always exist; the field-set logic doesn't depend on their values).
const VISIBLE_STYLE = { visibility: 'visible', display: 'block' } as const;
function loadPage(html: string) {
  const dom = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  (dom.window as unknown as { getComputedStyle: () => typeof VISIBLE_STYLE }).getComputedStyle = () => VISIBLE_STYLE;
  (globalThis as Record<string, unknown>).document = dom.document;
  return dom.document;
}

// --- Greenhouse / Snorkel AI EEO section markup (real ids; react-select fields) ---------------
// Each question: <label for=…> sibling of a .select__container wrapping a role="combobox" <input>.
const eeoField = (id: string, label: string, filled = false) => `
  <div class="field">
    <label id="${id}-label" class="label select__label" for="${id}">${label}</label>
    <div class="select__container">
      <div class="select__control">
        <div class="select__value-container">
          ${filled
            ? '<div class="select__single-value">Not Hispanic or Latino</div>'
            : '<div class="select__placeholder">Select...</div>'}
          <div class="select__input-container">
            <input id="${id}" class="select__input" type="text" role="combobox" aria-expanded="false" value="" />
          </div>
        </div>
      </div>
    </div>
  </div>`;

// Every element carries a stable id — so stableSelector never has to stamp a data-tw-ref, whose
// per-scan counter would otherwise churn across the fresh documents this test builds.
const IDENTITY = `
  <label id="first_name-label" for="first_name">First Name</label><input id="first_name" type="text" value="" />
  <label id="last_name-label" for="last_name">Last Name</label><input id="last_name" type="text" value="" />
  <label id="email-label" for="email">Email</label><input id="email" type="email" value="" />`;

const EEO_BEFORE = IDENTITY
  + eeoField('gender', 'Gender')
  + eeoField('hispanic_ethnicity', 'Are you Hispanic/Latino?')
  + eeoField('veteran_status', 'Veteran Status')
  + eeoField('disability_status', 'Disability Status');

// After answering "Are you Hispanic/Latino?": that field now shows a value AND a new "race" field
// has been inserted after it.
const EEO_AFTER = IDENTITY
  + eeoField('gender', 'Gender')
  + eeoField('hispanic_ethnicity', 'Are you Hispanic/Latino?', true)
  + eeoField('race', 'Please identify your race/ethnicity')
  + eeoField('veteran_status', 'Veteran Status')
  + eeoField('disability_status', 'Disability Status');

// Opening the hispanic_ethnicity dropdown injects a menu/listbox of options.
const MENU_OPEN = EEO_BEFORE + `
  <div class="select__menu"><div class="select__menu-list" role="listbox">
    <div class="select__option" role="option" id="react-select-2-option-0">Decline To Self Identify</div>
    <div class="select__option" role="option" id="react-select-2-option-1">Hispanic or Latino</div>
    <div class="select__option" role="option" id="react-select-2-option-2">Not Hispanic or Latino</div>
  </div></div>`;

// content.ts handlePageChange: diff currentFieldSet vs the last snapshot; structural iff it changed.
function diff(before: Set<string>, after: Set<string>) {
  let added = 0, removed = 0;
  after.forEach((s) => { if (!before.has(s)) added += 1; });
  before.forEach((s) => { if (!after.has(s)) removed += 1; });
  return { added, removed, structural: added + removed >= 1 };
}

const { currentFieldSet, mutationsIncludeFieldChange } = await import('../../plugin/lib/page-scan.ts');

// Build a MutationRecord-ish object from real linkedom nodes.
function frag(html: string) {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
}
type FakeMutation = { type: string; addedNodes: unknown[]; removedNodes: unknown[]; attributeName: string | null; target: unknown };
function mut(o: Partial<FakeMutation>): FakeMutation {
  return { type: 'childList', addedNodes: [], removedNodes: [], attributeName: null, target: frag('').body, ...o };
}

console.log('== structural detection on the real Greenhouse EEO form ==');

loadPage(EEO_BEFORE);
const baseline = currentFieldSet();
check('baseline: hispanic_ethnicity is a tracked field', baseline.has('#hispanic_ethnicity'), true);
check('baseline: race field is NOT present yet', baseline.has('#race'), false);

loadPage(EEO_AFTER);
const afterReveal = currentFieldSet();
const revealDiff = diff(baseline, afterReveal);
check('after answering Hispanic/Latino: #race is now a tracked field', afterReveal.has('#race'), true);
check('answering Hispanic/Latino registers as a STRUCTURAL change', revealDiff.structural, true);
check('  fieldsAdded >= 1 (the input, and/or its label)', revealDiff.added >= 1, true);
check('previously-tracked fields survive the diff (no false removals of real fields)',
  ['#gender', '#veteran_status', '#disability_status', '#first_name'].every((s) => afterReveal.has(s)), true);

loadPage(MENU_OPEN);
const menuOpen = currentFieldSet();
check('merely OPENING the dropdown is NOT structural (options are a popup/listbox)',
  diff(baseline, menuOpen).structural, false);

loadPage(EEO_AFTER);
loadPage(EEO_BEFORE);
check('the race field being removed again IS structural', diff(afterReveal, currentFieldSet()).structural, true);

console.log('\n== MutationObserver gate: dropdown expand/collapse must NOT reach the structural pipeline ==');

const menuNodes = [frag(`
  <div class="select__menu"><div class="select__menu-list" role="listbox">
    <div class="select__option" role="option">A</div><div class="select__option" role="option">B</div>
  </div></div>`).querySelector('.select__menu')];
check('opening a react-select menu (adds menu/listbox/option nodes) is NOT a field change',
  mutationsIncludeFieldChange([mut({ addedNodes: menuNodes })]), false);
check('closing it (removes those nodes) is NOT a field change',
  mutationsIncludeFieldChange([mut({ removedNodes: menuNodes })]), false);

const raceNodes = [frag(eeoField('race', 'Please identify your race/ethnicity')).querySelector('.field')];
check('a revealed field wrapper (contains a role=combobox input) IS a field change',
  mutationsIncludeFieldChange([mut({ addedNodes: raceNodes })]), true);

const textNode = [frag('x').createTextNode('Not Hispanic or Latino')];
check('a value text node rendering is NOT a field change',
  mutationsIncludeFieldChange([mut({ addedNodes: textNode })]), false);

const inputDoc = frag('<input id="conditional" type="text" hidden />');
check('un-hiding an existing <input> (attributes/hidden) IS a field change',
  mutationsIncludeFieldChange([mut({ type: 'attributes', attributeName: 'hidden', target: inputDoc.querySelector('#conditional') })]), true);
check('an attribute flip on a plain <div> is NOT a field change',
  mutationsIncludeFieldChange([mut({ type: 'attributes', attributeName: 'class', target: frag('<div></div>').querySelector('div') })]), false);

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
