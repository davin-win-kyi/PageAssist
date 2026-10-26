// Runs the REAL client-side structural-change detection — plugin/lib/page-scan.ts's scanPage() field
// snapshot + diffFieldSnapshots() (what content.ts's handlePageChange diffs) and
// mutationsIncludeFieldChange() (the MutationObserver gate) — against reconstructed real-page markup.
// A change is structural only when a QUESTION appears, comes into view, or leaves; an existing
// control's own UI (its dropdown, filter box, suggestions, calendar, upload chip, validation message,
// tooltip, another radio option) never is.
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
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? (pass += 1) : (fail += 1);
}

// linkedom has no layout or computed style. Approximate a real browser: an element is not displayed
// when it or any ancestor is `hidden` or display:none (a real browser reports offsetWidth 0 for it).
function computedStyle(element: Element) {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const inline = node.getAttribute('style') || '';
    if (node.hasAttribute('hidden') || /display\s*:\s*none/i.test(inline)) return { display: 'none', visibility: 'visible' };
    if (/visibility\s*:\s*hidden/i.test(inline)) return { display: 'block', visibility: 'hidden' };
  }
  return { display: 'block', visibility: 'visible' };
}
function loadPage(html: string) {
  const dom = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  (dom.window as unknown as { getComputedStyle: typeof computedStyle }).getComputedStyle = computedStyle;
  (globalThis as Record<string, unknown>).document = dom.document;
  return dom.document;
}

const { scanPage, diffFieldSnapshots, carryUploadFields } = await import('../../plugin/lib/page-scan.ts');
const { mutationsIncludeFieldChange } = await import('../../plugin/lib/mutations.ts');
type Diff = ReturnType<typeof diffFieldSnapshots>;

// Fields are keyed by their real ids/names here: a fresh document per snapshot means fresh nodes, and
// a node with nothing natural to key on would get a new data-tw-ref stamp each time (in a real page
// the node persists, so its stamp does too).
const fieldsOf = (html: string) => { loadPage(html); return scanPage().fields; };
const change = (before: string, after: string): Diff => diffFieldSnapshots(fieldsOf(before), fieldsOf(after));
const isStructural = (d: Diff) => d.added.length + d.revealed.length + d.removed.length + d.hidden.length > 0;
const added = (d: Diff) => d.added.map((e) => e.selector);
const revealed = (d: Diff) => d.revealed.map((group) => group.map((e) => e.selector));

// MutationRecord-ish objects built from real linkedom nodes.
const frag = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
type FakeMutation = { type: string; addedNodes: unknown[]; removedNodes: unknown[]; attributeName: string | null; oldValue?: string | null; target: unknown };
const mut = (o: Partial<FakeMutation>): FakeMutation =>
  ({ type: 'childList', addedNodes: [], removedNodes: [], attributeName: null, oldValue: null, target: frag('').body, ...o });
const gate = (...mutations: FakeMutation[]) => mutationsIncludeFieldChange(mutations as unknown as MutationRecord[]);

// --- Greenhouse / Snorkel AI EEO section (real ids; react-select fields) -----------------------
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
const IDENTITY = `
  <label id="first_name-label" for="first_name">First Name</label><input id="first_name" type="text" value="" />
  <label id="last_name-label" for="last_name">Last Name</label><input id="last_name" type="text" value="" />
  <label id="email-label" for="email">Email</label><input id="email" type="email" value="" />`;
const EEO_BEFORE = IDENTITY + eeoField('gender', 'Gender') + eeoField('hispanic_ethnicity', 'Are you Hispanic/Latino?')
  + eeoField('veteran_status', 'Veteran Status') + eeoField('disability_status', 'Disability Status');
const EEO_PICKED = IDENTITY + eeoField('gender', 'Gender') + eeoField('hispanic_ethnicity', 'Are you Hispanic/Latino?', true)
  + eeoField('veteran_status', 'Veteran Status') + eeoField('disability_status', 'Disability Status');
const EEO_AFTER = EEO_PICKED.replace(eeoField('veteran_status', 'Veteran Status'),
  eeoField('race', 'Please identify your race/ethnicity') + eeoField('veteran_status', 'Veteran Status'));
const REACT_SELECT_MENU = `
  <div class="select__menu"><div class="select__menu-list" role="listbox">
    <div class="select__option" role="option" id="react-select-2-option-0">Decline To Self Identify</div>
    <div class="select__option" role="option" id="react-select-2-option-1">Hispanic or Latino</div>
    <div class="select__option" role="option" id="react-select-2-option-2">Not Hispanic or Latino</div>
  </div></div>`;

console.log('== Greenhouse EEO form ==');
{
  const baseline = fieldsOf(EEO_BEFORE);
  check('baseline: hispanic_ethnicity is a tracked question', baseline.has('#hispanic_ethnicity'), true);
  check('baseline: race is NOT present yet', baseline.has('#race'), false);
  const reveal = diffFieldSnapshots(baseline, fieldsOf(EEO_AFTER));
  check('answering Hispanic/Latino reveals #race — STRUCTURAL', isStructural(reveal), true);
  check('  exactly the revealed combobox is added (a bare <label> is not a field)', added(reveal), ['#race']);
  check('  no previously-tracked question reads as removed', reveal.removed, []);
  check('opening the dropdown is NOT structural (its options are a listbox popup)',
    isStructural(change(EEO_BEFORE, EEO_BEFORE + REACT_SELECT_MENU)), false);
  check('picking a value (placeholder -> value chip) is NOT structural', isStructural(change(EEO_BEFORE, EEO_PICKED)), false);
  const hide = change(EEO_AFTER, EEO_BEFORE);
  check('the race field leaving again IS structural, and reports its selector', hide.removed, ['#race']);
}

// --- Ashby application form (custom combobox with an inner search input) ----------------------
const ASHBY_SOURCE = `
  <div class="ashby-application-form-field-entry"><label for="src">How did you hear about us?</label>
    <div class="_select_1v5zz_36" id="src-select" role="combobox"><div class="_placeholder_1v5zz_50">Select...</div>
    <input id="src" role="combobox" value="" /></div></div>`;
console.log('\n== Ashby application form ==');
{
  const picked = ASHBY_SOURCE.replace('<div class="_placeholder_1v5zz_50">Select...</div>', '<div class="_value_1v5zz_58">LinkedIn</div>');
  check('picking a value is NOT structural', isStructural(change(ASHBY_SOURCE, picked)), false);
  check('opening its option list is NOT structural', isStructural(change(ASHBY_SOURCE, ASHBY_SOURCE + `
    <div class="_dropdownMenu_1v5zz_90" role="listbox">
      <div class="_option_1v5zz_99" role="option" id="opt-li">LinkedIn</div>
      <div class="_option_1v5zz_99" role="option" id="opt-x">Twitter / X</div>
    </div>`)), false);
  const specify = change(ASHBY_SOURCE, ASHBY_SOURCE + `
    <div class="ashby-application-form-field-entry"><label for="src_other">Please specify</label>
      <input id="src_other" type="text" value="" /></div>`);
  check('a revealed "Please specify" field IS structural', added(specify), ['#src_other']);
  check('the nested search input and its combobox are ONE question', [...fieldsOf(ASHBY_SOURCE).keys()], ['#src-select']);
}

// --- Rule by rule: an existing control's own UI is never a new question ------------------------
console.log('\n== 1. a dropdown showing its choices ==');
{
  const select = (options: string) => `<label for="country">Country</label><select id="country">${options}</select>`;
  check('a native <select> loading more options is NOT structural',
    isStructural(change(select('<option>Select…</option>'), select('<option>Select…</option><option>Canada</option><option>Mexico</option>'))), false);
  check('a multi-select listbox whose options carry checkboxes is NOT structural', isStructural(change(EEO_BEFORE, EEO_BEFORE + `
    <div class="select__menu" role="listbox">
      <div role="option"><input type="checkbox" id="opt-a" /> A</div><div role="option"><input type="checkbox" id="opt-b" /> B</div>
    </div>`)), false);
}

console.log('\n== 2. a search box inside an open dropdown ==');
{
  const closed = '<label id="loc-label">Location</label><div id="location" role="combobox" aria-labelledby="loc-label" aria-expanded="false"><span>Select…</span></div>';
  const filterInPopover = closed.replace('aria-expanded="false"', 'aria-expanded="true"') + `
    <div class="dropdown__popover"><input id="loc-filter" type="search" placeholder="Search…" />
      <ul role="listbox"><li role="option">Seattle</li><li role="option">Portland</li></ul></div>`;
  check('a filter box rendered in the dropdown\'s popover is NOT structural', isStructural(change(closed, filterInPopover)), false);
  const filterInside = '<label id="loc-label">Location</label><div id="location" role="combobox" aria-labelledby="loc-label" aria-expanded="true">'
    + '<input id="loc-search" type="text" aria-label="Filter locations" /><span>Select…</span></div>';
  check('a filter box rendered INSIDE the combobox itself is NOT structural', isStructural(change(closed, filterInside)), false);
}

console.log('\n== 3. autocomplete suggestions for a text field ==');
{
  const city = '<label for="city">City</label><input id="city" type="text" role="combobox" aria-autocomplete="list" aria-controls="city-list" value="Sea" />';
  check('a suggestion listbox is NOT structural', isStructural(change(city, city + `
    <ul id="city-list" role="listbox"><li role="option" id="s1">Seattle, WA</li><li role="option" id="s2">Seaside, OR</li></ul>`)), false);
  check('a Google Places-style suggestion container is NOT structural', isStructural(change(city, city + `
    <div class="pac-container"><div class="pac-item"><span>Seattle</span></div><div class="pac-item"><span>Seaside</span></div></div>`)), false);
}

console.log('\n== 4. a date field\'s calendar picker ==');
{
  const dateField = `<label for="start_date">Start date</label>
    <div class="react-datepicker-wrapper"><div class="react-datepicker__input-container"><input id="start_date" type="text" value="" /></div></div>`;
  check('the date input itself is a tracked question (its "datepicker" wrapper is not a calendar)', fieldsOf(dateField).has('#start_date'), true);
  check('react-datepicker popup (popper, month/year <select>s, day options) is NOT structural', isStructural(change(dateField, dateField + `
    <div class="react-datepicker-popper"><div class="react-datepicker" role="dialog" aria-modal="true" aria-label="Choose Date">
      <button aria-label="Previous Month">‹</button><button aria-label="Next Month">›</button>
      <select class="react-datepicker__month-select" id="dp-month"><option>October</option></select>
      <select class="react-datepicker__year-select" id="dp-year"><option>2026</option></select>
      <div class="react-datepicker__month" role="listbox"><div role="option">1</div><div role="option">2</div></div>
    </div></div>`)), false);
  check('an ARIA date-picker dialog (grid of days + year <select>) is NOT structural', isStructural(change(dateField, dateField + `
    <div role="dialog" aria-modal="true" aria-label="Choose date"><button>Previous month</button><h2>October 2026</h2>
      <select id="year-picker"><option>2026</option></select>
      <table role="grid"><tr><td><button>1</button></td><td><button>2</button></td></tr></table></div>`)), false);
  check('a flatpickr calendar (month <select> + year number input) is NOT structural', isStructural(change(dateField, dateField + `
    <div class="flatpickr-calendar open"><div class="flatpickr-months">
      <select class="flatpickr-monthDropdown-months" id="fp-month"><option>October</option></select>
      <input class="numInput cur-year" id="fp-year" type="number" aria-label="Year" /></div>
      <div class="dayContainer"><span class="flatpickr-day">1</span></div></div>`)), false);
}

console.log('\n== 5. a file upload showing its state ==');
{
  // Ashby: after upload the filename, a progress bar, a remove button, and a hidden uploaded-file id.
  const upload = (state: string) => `
    <div class="_fileUpload"><label for="_systemfield_resume">Resume</label>
      <input id="_systemfield_resume" type="file" />${state}</div>`;
  check('filename + progress bar + remove button + hidden file id is NOT structural', isStructural(change(upload('<button>Upload File</button>'), upload(`
    <span class="_filename">resume.pdf</span><div role="progressbar" aria-valuenow="100"></div>
    <button aria-label="Remove file">×</button><input type="hidden" name="resume_id" value="f_123" />`))), false);
  // Greenhouse: the "Attach / Dropbox / Google Drive / Enter manually" button row (with visually-hidden
  // caption labels) swaps for a "<filename> ×" chip; the <input type="file"> stays mounted.
  const RESUME_EMPTY = `
    <div role="group" aria-labelledby="upload-label-resume" class="file-upload">
      <div id="upload-label-resume" class="label">Resume/CV</div>
      <div class="button-container">
        <div class="secondary-button"><button type="button">Attach</button><label class="visually-hidden" for="resume">Attach</label></div>
        <div class="secondary-button"><button type="button">Dropbox</button></div>
        <div class="secondary-button"><button type="button">Google Drive</button></div>
        <div class="secondary-button"><button type="button">Enter manually</button><label class="visually-hidden" for="resume_text">Enter manually</label></div>
      </div>
      <input id="resume" class="visually-hidden" type="file" />
    </div>`;
  const RESUME_UPLOADED = `
    <div role="group" aria-labelledby="upload-label-resume" class="file-upload">
      <div id="upload-label-resume" class="label">Resume/CV</div>
      <div class="chip"><span>my_resume.pdf</span><button type="button" aria-label="Remove">×</button></div>
      <input id="resume" class="visually-hidden" type="file" />
    </div>`;
  check('Greenhouse button row -> filename chip is NOT structural', isStructural(change(RESUME_EMPTY, RESUME_UPLOADED)), false);
  check('  and the file input is tracked throughout', fieldsOf(RESUME_EMPTY).has('#resume') && fieldsOf(RESUME_UPLOADED).has('#resume'), true);
}

console.log('\n== 6. a validation message for a field ==');
{
  const email = '<label for="email">Email</label><input id="email" type="email" value="ada@" />';
  check('an error message + aria-invalid on the field is NOT structural', isStructural(change(email,
    '<label for="email">Email</label><input id="email" type="email" value="ada@" aria-invalid="true" aria-describedby="email-error" />'
    + '<p id="email-error" role="alert">Enter a valid email address</p>')), false);
}

console.log('\n== 7. a tooltip or help message for a control ==');
{
  const salary = '<label for="salary">Expected salary</label><input id="salary" type="text" aria-describedby="salary-tip" /><button aria-label="More info">?</button>';
  check('a tooltip appearing is NOT structural', isStructural(change(salary, salary
    + '<div role="tooltip" id="salary-tip">Annual base pay, before bonus.</div>')), false);
  check('an inline help paragraph appearing is NOT structural', isStructural(change(salary, salary
    + '<p class="help-text">We only use this to match you with roles in range.</p>')), false);
}

console.log('\n== 8. another option appearing in a radio question ==');
{
  const auth = (extra: string) => `<fieldset><legend>Do you need visa sponsorship?</legend>
    <label><input type="radio" id="sponsor-yes" name="sponsorship" value="yes" /> Yes</label>
    <label><input type="radio" id="sponsor-no" name="sponsorship" value="no" /> No</label>${extra}</fieldset>`;
  check('a new native radio in the same name-group is NOT structural', isStructural(change(auth(''),
    auth('<label><input type="radio" id="sponsor-later" name="sponsorship" value="later" /> In the future</label>'))), false);
  check('  the whole group is ONE question', [...fieldsOf(auth('')).keys()], ['radio:sponsorship']);
  const ashby = (extra: string) => `<label id="auth-label">Are you legally authorized to work in the US?</label>
    <div role="radiogroup" id="auth-group" aria-labelledby="auth-label">
      <div id="auth-yes" role="radio" aria-checked="false">Yes</div><div id="auth-no" role="radio" aria-checked="false">No</div>${extra}</div>`;
  check('a new [role=radio] in the same radiogroup is NOT structural', isStructural(change(ashby(''),
    ashby('<div id="auth-unsure" role="radio" aria-checked="false">Not sure</div>'))), false);
}

// --- Rule by rule: a genuinely new question always is ------------------------------------------
console.log('\n== 9. a choice revealing a separate question ==');
{
  const ethnicity = (race: string) => `<fieldset><legend>Are you Hispanic or Latino?</legend>
    <label><input type="radio" id="eth-yes" name="ethnicity" value="yes" /> Yes</label>
    <label><input type="radio" id="eth-no" name="ethnicity" value="no" checked /> No</label></fieldset>${race}`;
  const d = change(ethnicity(''), ethnicity('<label for="race">Please identify your race</label><select id="race"><option>Select…</option></select>'));
  check('"No" revealing a race question IS structural', added(d), ['#race']);
  check('  and the race question is its own question, not part of the ethnicity group',
    [...fieldsOf(ethnicity('<select id="race"></select>')).keys()], ['radio:ethnicity', '#race']);
}

console.log('\n== 10. "Other" revealing a "Please specify" input ==');
{
  const source = (specify: string) => `<fieldset><legend>How did you hear about us?</legend>
    <label><input type="radio" id="src-li" name="source" value="linkedin" /> LinkedIn</label>
    <label><input type="radio" id="src-other" name="source" value="other" checked /> Other</label>${specify}</fieldset>`;
  const d = change(source(''), source('<input type="text" id="source_other" placeholder="Please specify" />'));
  check('a "Please specify" input inside the radio fieldset IS structural (a separate answer)', added(d), ['#source_other']);
}

console.log('\n== 11. "Add another education entry" ==');
{
  const entry = (n: number) => `<fieldset class="education-entry"><legend>Education ${n}</legend>
    <label>School <input type="text" name="school" /></label><label>Degree <input type="text" name="degree" /></label></fieldset>`;
  // one page whose first entry persists while the second is added, as in a real page
  const live = loadPage(entry(1));
  const before = scanPage().fields;
  live.body.insertAdjacentHTML('beforeend', entry(2));
  const d = diffFieldSnapshots(before, scanPage().fields);
  const after = entry(1) + entry(2);
  check('a second entry whose names and labels repeat the first IS structural, with both its fields added', d.added.length, 2);
  check('  and the first entry\'s fields are not read as removed', d.removed, []);
  const doc = loadPage(after);
  const { elements } = scanPage();
  const schools = elements.filter((e) => e.tag === 'input' && e.accessibleName.startsWith('School'));
  const realSchools = [...doc.querySelectorAll('input[name="school"]')];
  check('  each School input gets its own selector, each resolving to itself',
    schools.map((e) => doc.querySelector(e.selector) === realSchools[schools.indexOf(e)]), [true, true]);
}

console.log('\n== 12. a dialog revealing additional questions ==');
{
  const page = '<label for="first">First name</label><input id="first" type="text" /><button>Add a reference</button>';
  const modal = `<div class="modal-popup" role="dialog" aria-modal="true"><h2>Add a reference</h2>
    <label for="ref_name">Reference name</label><input id="ref_name" type="text" />
    <label for="ref_email">Reference email</label><input id="ref_email" type="email" /></div>`;
  check('questions in a dialog (even one classed "popup") ARE structural', added(change(page, page + modal)), ['#ref_name', '#ref_email']);
  check('  and when the dialog sits in a "popup-overlay" wrapper', added(change(page, page + `<div class="popup-overlay">${modal}</div>`)), ['#ref_name', '#ref_email']);
  check('  and a native <dialog open>', added(change(page, page + '<dialog open><label for="ref_phone">Phone</label><input id="ref_phone" type="tel" /></dialog>')), ['#ref_phone']);
  check('a dropdown open INSIDE a dialog is still NOT a question', isStructural(change(page + modal, page
    + modal.replace('</div>', '<div class="select__menu" role="listbox"><input id="dlg-filter" type="search" /></div></div>'))), false);
}

console.log('\n== 12b. an upload swapped for its file chip, on the same page ==');
{
  // Greenhouse, as it really behaves: choosing a file REMOVES the <input> and shows "<filename> ×".
  const doc = loadPage(`<label for="email">Email</label><input id="email" />
    <div role="group" aria-labelledby="upload-label-resume" class="file-upload"><div id="upload-label-resume">Resume/CV*</div>
      <div class="file-upload__wrapper"><button type="button">Attach</button><label class="visually-hidden" for="resume">Attach</label>
        <input id="resume" class="visually-hidden" type="file" /><p id="accepted-filetypes">Accepted file types: pdf, doc</p></div></div>`);
  const step = (before: Map<string, unknown>) => {
    const after = carryUploadFields(before as never, scanPage().fields);
    return { diff: diffFieldSnapshots(before as never, after), after };
  };
  const start = scanPage().fields;
  const wrapper = doc.querySelector('.file-upload__wrapper')!;
  wrapper.innerHTML = '<div class="file-upload__filename"><p>resume.pdf</p><button type="button" aria-label="Remove file">×</button></div>';
  const uploaded = step(start);
  check('choosing a file (the input removed, a chip shown) is NOT a field leaving', [uploaded.diff.removed, isStructural(uploaded.diff)], [[], false]);
  wrapper.innerHTML = '<button type="button">Attach</button><input id="resume" class="visually-hidden" type="file" />';
  const removedFile = step(uploaded.after);
  check('removing the file (the input back) is NOT a new question', [added(removedFile.diff), isStructural(removedFile.diff)], [[], false]);
  doc.querySelector('.file-upload')!.remove();
  const gone = step(removedFile.after);
  check('the whole upload question leaving IS a field leaving', gone.diff.removed, ['#resume']);
}

console.log('\n== 13. a field coming into view, and going out of view ==');
{
  const raceField = (attrs: string) => `<label for="ethnicity">Ethnicity</label><input id="ethnicity" type="text" />
    <div class="field"${attrs}><label for="race">Race</label><input id="race" type="text" /></div>`;
  const radios = (attrs: string) => `<fieldset${attrs}><legend>Are you a veteran?</legend>
    <input type="radio" id="vet-yes" name="veteran" /><input type="radio" id="vet-no" name="veteran" /></fieldset>`;
  const shown = change(raceField(' hidden'), raceField(''));
  check('a hidden field (in the DOM all along) coming into view is reported as REVEALED', revealed(shown), [['#race']]);
  check('  not as newly added — the backend adds it only if the task representation doesn\'t map it', shown.added, []);
  check('  revealed via inline display:none too', revealed(change(raceField(' style="display: none"'), raceField(''))), [['#race']]);
  check('a field that stays hidden is NOT structural', isStructural(change(raceField(' hidden'), raceField(' hidden'))), false);
  const gone = change(raceField(''), raceField(' hidden'));
  check('a field going hidden IS structural — it\'s no longer part of the task — reported as HIDDEN', gone.hidden, ['#race']);
  check('  not as removed from the DOM, and nothing else changes', [gone.removed, gone.added, gone.revealed], [[], [], []]);
  check('  hidden via inline display:none too', change(raceField(''), raceField(' style="display: none"')).hidden, ['#race']);
  check('a hidden radio question goes as ONE question with all its options', change(radios(''), radios(' hidden')).hidden, ['#vet-yes', '#vet-no']);
  check('a revealed radio question comes back as ONE group with all its options', revealed(change(radios(' hidden'), radios(''))), [['#vet-yes', '#vet-no']]);
}

// --- The MutationObserver gate ------------------------------------------------------------------
console.log('\n== MutationObserver gate (spares the rescan for changes that can\'t matter) ==');
{
  const menu = frag(REACT_SELECT_MENU).querySelector('.select__menu');
  check('opening a react-select menu is NOT a field change', gate(mut({ addedNodes: [menu] })), false);
  check('closing it is NOT a field change', gate(mut({ removedNodes: [menu] })), false);
  check('a revealed field wrapper IS a field change', gate(mut({ addedNodes: [frag(eeoField('race', 'Race')).querySelector('.field')] })), true);
  check('a value text node rendering is NOT a field change', gate(mut({ addedNodes: [frag('').createTextNode('Not Hispanic or Latino')] })), false);
  check('a field appended straight into a shadow root IS a field change',
    gate(mut({ target: { nodeType: 11 }, addedNodes: [frag('<input id="shadow-q" />').querySelector('input')] })), true);

  const listbox = frag('<div role="listbox" id="lb"><div role="option"><input type="checkbox" /> A</div></div>');
  check('options filtering inside an open listbox are NOT a field change', gate(mut({
    target: listbox.querySelector('#lb'), addedNodes: [listbox.querySelector('[role="option"]')] })), false);
  const overlay = frag('<div class="popup-overlay"><div role="dialog"><input id="ref_name" /></div></div>').querySelector('.popup-overlay');
  check('a dialog of questions (in a "popup-overlay" wrapper) IS a field change', gate(mut({ addedNodes: [overlay] })), true);
  const picker = frag('<div class="react-datepicker-popper"><div class="react-datepicker" role="dialog"><select id="m"></select></div></div>').querySelector('div');
  check('a date picker popup is NOT a field change', gate(mut({ addedNodes: [picker] })), false);

  // WordPress (GeneratePress) puts "sticky-menu-fade" / "dropdown-hover" on <body> — the whole page is not a popup.
  const wp = frag('<main><div id="slot"><label for="late-q">Anything else?</label><input id="late-q" /></div></main>');
  wp.body.setAttribute('class', 'single-post sticky-menu-fade dropdown-hover');
  check('a question appearing on a page whose <body> class says "menu" IS a field change',
    gate(mut({ target: wp.querySelector('#slot'), addedNodes: [wp.querySelector('#late-q')] })), true);

  const field = frag('<input id="conditional" type="text" hidden />').querySelector('#conditional');
  check('un-hiding a field itself IS a field change', gate(mut({ type: 'attributes', attributeName: 'hidden', target: field })), true);
  const wrapper = (attrs: string) => frag(`<div class="field"${attrs}><input id="race" /></div>`).querySelector('.field');
  check('un-hiding a WRAPPER of a field (hidden attribute) IS a field change',
    gate(mut({ type: 'attributes', attributeName: 'hidden', target: wrapper('') })), true);
  check('a wrapper\'s inline display:none -> shown IS a field change',
    gate(mut({ type: 'attributes', attributeName: 'style', oldValue: 'display: none', target: wrapper(' style=""') })), true);
  check('a wrapper\'s inline style change that doesn\'t touch visibility is NOT',
    gate(mut({ type: 'attributes', attributeName: 'style', oldValue: 'color: red', target: wrapper(' style="color: blue"') })), false);
  check('a wrapper\'s "is-hidden" class being removed IS a field change',
    gate(mut({ type: 'attributes', attributeName: 'class', oldValue: 'field is-hidden', target: wrapper(' class="field"') })), true);
  check('a wrapper\'s focus class toggling is NOT (every keystroke would rescan)',
    gate(mut({ type: 'attributes', attributeName: 'class', oldValue: 'field', target: wrapper(' class="field is-focused has-value"') })), false);
  const details = frag('<details><summary>More questions</summary><input id="extra" /></details>').querySelector('details');
  check('a <details> opening over a field IS a field change', gate(mut({ type: 'attributes', attributeName: 'open', target: details })), true);
  check('a class flip on a div holding no field is NOT', gate(mut({ type: 'attributes', attributeName: 'class', oldValue: 'is-hidden', target: frag('<div></div>').querySelector('div') })), false);
}

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
