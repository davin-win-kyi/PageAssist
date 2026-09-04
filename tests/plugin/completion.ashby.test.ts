// Runs the REAL completion-detection logic against Ashby's application-form DOM patterns
// (jobs.ashbyhq.com/reducto/.../application). The live page is fully client-rendered, so the markup
// below is Ashby's stable structure: an `ashby-application-form-field-entry` wrapper per field, a
// custom `_select_`-hashed combobox with `_placeholder_` / `_value_` display divs, and a
// `[role="radiogroup"]` of `[role="radio"][aria-checked]` options for Yes/No questions.
//   node tests/plugin/completion.ashby.test.ts
import { parseHTML } from 'linkedom';

const dom = parseHTML('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'] as const) {
  (globalThis as Record<string, unknown>)[k] = (dom as unknown as Record<string, unknown>)[k];
}

const { isElementComplete } = await import('../../plugin/lib/completion.ts');

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
// 1. Plain text field ("First Name").
// ---------------------------------------------------------------------------------------------------
console.log('== 1. text field ==');
{
  const entry = (value: string) => `
    <div class="ashby-application-form-field-entry">
      <label for="_systemfield_name">First Name <span aria-hidden="true">*</span></label>
      <input id="_systemfield_name" class="_input_101oc_28" type="text" required value="${value}" />
    </div>`;
  check('empty -> incomplete',
    isElementComplete(frag(entry('')).querySelector('#_systemfield_name')!, '#_systemfield_name'), false);
  check('typed -> complete',
    isElementComplete(frag(entry('Ada')).querySelector('#_systemfield_name')!, '#_systemfield_name'), true);
}

// ---------------------------------------------------------------------------------------------------
// 2. Ashby custom combobox with a real search <input> ("How did you hear about us?").
// ---------------------------------------------------------------------------------------------------
console.log('\n== 2. custom combobox (search input) ==');
{
  const combo = (display: string) => `
    <div class="ashby-application-form-field-entry">
      <label id="src-label">How did you hear about us? <span aria-hidden="true">*</span></label>
      <div class="_wrapper_1v5zz_28">
        <div class="_select_1v5zz_36" role="combobox" aria-expanded="false" aria-haspopup="listbox">
          ${display}
          <div class="_inputWrapper_1v5zz_60">
            <input id="src" class="_searchInput_1v5zz_66" type="text" role="combobox" aria-labelledby="src-label" value="" />
          </div>
        </div>
      </div>
    </div>`;
  check('placeholder showing -> incomplete',
    isElementComplete(frag(combo('<div class="_placeholder_1v5zz_50">Select an option</div>')).querySelector('#src')!, '#src'), false);
  check('value chip showing ("LinkedIn") -> complete',
    isElementComplete(frag(combo('<div class="_value_1v5zz_58">LinkedIn</div>')).querySelector('#src')!, '#src'), true);
}

// ---------------------------------------------------------------------------------------------------
// 3. Ashby custom combobox with NO inner input — grounded on the combobox <div> itself.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 3. custom combobox (div only) ==');
{
  const combo = (display: string) => `
    <div class="ashby-application-form-field-entry">
      <label>Country <span aria-hidden="true">*</span></label>
      <div class="_wrapper_1v5zz_28">
        <div id="country" class="_select_1v5zz_36" role="combobox" aria-expanded="false" aria-haspopup="listbox" tabindex="0">
          ${display}
        </div>
      </div>
    </div>`;
  check('placeholder showing -> incomplete',
    isElementComplete(frag(combo('<div class="_placeholder_1v5zz_50">Select...</div>')).querySelector('#country')!, '#country'), false);
  check('value showing ("United States") -> complete',
    isElementComplete(frag(combo('<div class="_value_1v5zz_58">United States</div>')).querySelector('#country')!, '#country'), true);
}

// ---------------------------------------------------------------------------------------------------
// 4. Yes/No question rendered as a radiogroup of [role=radio][aria-checked] divs.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 4. Yes/No radiogroup ==');
{
  const group = (yes: string, no: string, sel: string) => ({
    body: frag(`
      <div class="ashby-application-form-field-entry">
        <label id="auth-label">Are you legally authorized to work in the United States?</label>
        <div role="radiogroup" aria-labelledby="auth-label" class="_container_wp0mv_28">
          <div id="auth-yes" class="_option_wp0mv_35${yes === 'true' ? ' _selected_wp0mv_44' : ''}" role="radio" aria-checked="${yes}" tabindex="0">Yes</div>
          <div id="auth-no" class="_option_wp0mv_35${no === 'true' ? ' _selected_wp0mv_44' : ''}" role="radio" aria-checked="${no}" tabindex="-1">No</div>
        </div>
      </div>`),
    sel,
  });
  const none = group('false', 'false', '#auth-yes');
  check('nothing chosen (grounded on "Yes" option) -> incomplete',
    isElementComplete(none.body.querySelector(none.sel)!, none.sel), false);
  const chose = group('true', 'false', '#auth-yes');
  check('"Yes" chosen (aria-checked=true) -> complete',
    isElementComplete(chose.body.querySelector(chose.sel)!, chose.sel), true);
  const choseNo = group('false', 'true', '#auth-yes');
  check('"No" chosen, but item grounded on "Yes" -> complete (group is answered)',
    isElementComplete(choseNo.body.querySelector('#auth-yes')!, '#auth-yes'), true);
  const onGroup = group('false', 'true', '.ashby-application-form-field-entry [role="radiogroup"]');
  check('grounded on the radiogroup wrapper, "No" chosen -> complete',
    isElementComplete(onGroup.body.querySelector(onGroup.sel)!, onGroup.sel), true);
}

// ---------------------------------------------------------------------------------------------------
// 5. Structural detection — mirrors content.ts handlePageChange field-set diff.
// ---------------------------------------------------------------------------------------------------
const FIELD_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'spinbutton', 'switch']);
const POPUP_SELECTOR = '[role="listbox"], [role="menu"], [role="tooltip"], [aria-modal="true"], [class*="menu" i], [class*="popover" i], [class*="popup" i], [class*="tooltip" i], [class*="option-list" i], [class*="options-list" i]';
const PAGE_ELEMENT_SELECTOR = 'a, button, input, textarea, select, option, label, fieldset, legend, form, h1, h2, h3, h4, h5, h6, [id], [data-testid], [aria-label], [aria-labelledby], [aria-required], [role], [contenteditable="true"]';
function fieldSet(body: Element): Set<string> {
  return new Set(
    [...body.querySelectorAll(PAGE_ELEMENT_SELECTOR)]
      .filter((e) => !e.closest?.(POPUP_SELECTOR))
      .filter((e) => ['input', 'textarea', 'select', 'label', 'fieldset', 'legend'].includes(e.tagName.toLowerCase())
        || FIELD_ROLES.has(e.getAttribute('role') || ''))
      .map((e, i) => e.id || e.getAttribute('for') || `${e.tagName}#${i}`),
  );
}
function structural(before: Element, after: Element): boolean {
  const b = fieldSet(before);
  const a = fieldSet(after);
  let d = 0;
  a.forEach((s) => { if (!b.has(s)) d += 1; });
  b.forEach((s) => { if (!a.has(s)) d += 1; });
  return d >= 1;
}

console.log('\n== 5. structural change detection ==');
{
  const base = `
    <div class="ashby-application-form-field-entry"><label for="src">How did you hear about us?</label>
      <div class="_select_1v5zz_36" role="combobox"><div class="_placeholder_1v5zz_50">Select...</div>
      <input id="src" role="combobox" value="" /></div></div>`;
  const withOther = base + `
    <div class="ashby-application-form-field-entry"><label for="src_other">Please specify</label>
      <input id="src_other" type="text" value="" /></div>`;
  const menuOpen = base + `
    <div class="_dropdownMenu_1v5zz_90" role="listbox">
      <div class="_option_1v5zz_99" role="option" id="opt-li">LinkedIn</div>
      <div class="_option_1v5zz_99" role="option" id="opt-x">Twitter / X</div>
    </div>`;
  const picked = `
    <div class="ashby-application-form-field-entry"><label for="src">How did you hear about us?</label>
      <div class="_select_1v5zz_36" role="combobox"><div class="_value_1v5zz_58">LinkedIn</div>
      <input id="src" role="combobox" value="" /></div></div>`;

  check('picking a value (placeholder -> value chip) is NOT structural', structural(frag(base), frag(picked)), false);
  check('opening the dropdown menu is NOT structural (options in a listbox popup)', structural(frag(base), frag(menuOpen)), false);
  check('a revealed "Please specify" field IS structural', structural(frag(base), frag(withOther)), true);
}

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
