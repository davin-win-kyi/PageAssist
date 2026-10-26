// Runs the REAL plugin/lib/widget-items.ts — the `required` flag content.ts sets on every tracked item,
// and the splice that applies a page change to a widget already on the page (instead of regenerating
// it) — against markup taken from real application forms.
//   node tests/plugin/widget-items.test.ts
import { parseHTML } from 'linkedom';

const boot = parseHTML('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement'] as const) {
  (globalThis as Record<string, unknown>)[k] = (boot as unknown as Record<string, unknown>)[k];
}
(globalThis as Record<string, unknown>).CSS = { escape: (s: string) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };

const { isElementRequired, isItemRequired, spliceWidgetItems, isQuestionElement, nonAnswerMembers } = await import('../../plugin/lib/widget-items.ts');
type WidgetItem = Parameters<typeof spliceWidgetItems>[0][number];

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? (pass += 1) : (fail += 1);
}
const page = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
const required = (html: string, selector: string) => isElementRequired(page(html).querySelector(selector)!);

console.log('== required: Greenhouse marks every field with aria-required ==');
check('aria-required="true" (First Name*)',
  required('<label for="first_name">First Name<span aria-hidden="true">*</span></label><input id="first_name" aria-required="true" />', '#first_name'), true);
check('aria-required="false" (Gender) is a clear no',
  required('<label for="gender">Gender</label><input id="gender" role="combobox" aria-required="false" />', '#gender'), false);
check('aria-required="false" wins over an asterisk in the label',
  required('<label for="p">Phone*</label><input id="p" aria-required="false" />', '#p'), false);
check('a resume upload: the file input itself is unmarked, its role="group" wrapper is required',
  required(`<div role="group" aria-labelledby="upload-label-resume" aria-required="true" class="file-upload">
    <div id="upload-label-resume">Resume/CV<span class="required">*</span></div>
    <div class="file-upload__wrapper"><button type="button">Attach</button><label class="visually-hidden" for="resume">Attach</label>
    <input id="resume" class="visually-hidden" type="file" /></div></div>`, '#resume'), true);

console.log('\n== required: pages that only mark it in the label or with the HTML attribute ==');
check('an asterisk in a separate span of the label (Ashby)',
  required('<label for="name">Name <span class="req">*</span></label><input id="name" />', '#name'), true);
check('"(required)" in the label', required('<label for="e">Email (required)</label><input id="e" />', '#e'), true);
check('the required attribute', required('<label for="s">Country</label><select id="s" required><option></option></select>', '#s'), true);
check('no marker at all -> optional', required('<label for="n">Nickname</label><input id="n" />', '#n'), false);
check('a radio option of a group whose other option carries `required`',
  required('<input type="radio" name="auth" id="a1" required /><label for="a1">Yes</label><input type="radio" name="auth" id="a2" /><label for="a2">No</label>', '#a2'), true);
check('a radio option of a fieldset whose legend has the asterisk',
  required('<fieldset><legend>Are you 18 or older?*</legend><input type="radio" name="age" id="y" /><label for="y">Yes</label></fieldset>', '#y'), true);
check('a wrapper element tracked as the item: a required control inside it',
  required('<div id="q"><span>Pick a start date</span><input id="inner" required /></div>', '#q'), true);

console.log('\n== required: an item is required when any control it tracks is ==');
const form = page(`
  <input id="start-month--0" aria-required="false" /><input id="start-year--0" aria-required="false" />
  <input id="country" aria-required="true" /><input id="phone" aria-required="true" />`);
const resolve = (s: string) => form.querySelector(s);
check('an optional month + year date', isItemRequired(['#start-month--0', '#start-year--0'], resolve), false);
check('a required country + phone number', isItemRequired(['#country', '#phone'], resolve), true);
check('a control that isn\'t on the page reads as not required', isItemRequired(['#gone'], resolve), false);

console.log('\n== only answerable controls complete a multi-control question ==');
{
  // Greenhouse's resume question, as the task representation bundled it
  const gh = page(`<div role="group" aria-required="true"><div id="upload-label-resume">Resume/CV*</div>
    <input id="resume" type="file" /><p id="accepted-filetypes">Accepted file types: pdf, doc, docx, txt, rtf</p></div>
    <input id="first_name" /><input id="last_name" />`);
  const at = (s: string) => gh.querySelector(s);
  check('the "Accepted file types" line is not a control of the resume question',
    nonAnswerMembers(['#resume', '#accepted-filetypes'], at), ['#accepted-filetypes']);
  check('every real control of a question counts (first + last name)', nonAnswerMembers(['#first_name', '#last_name'], at), []);
  const ashby = page(`<div class="ashby-application-form-field-entry">
    <label for="8b35931a">Are you legally authorized to work in the United States?</label>
    <div class="ashby-application-form-input-yesno"><button aria-pressed="false" id="yes">Yes</button><button aria-pressed="true" id="no">No</button>
    <input type="checkbox" tabindex="-1" name="8b35931a"></div></div>
    <div class="ashby-application-form-field-entry"><label for="resume">Resume</label><div class="ashby-application-form-input-file">
    <input type="file" tabindex="-1" id="resume"><button id="upload">Upload File</button></div></div>`);
  const atAshby = (selector: string) => ashby.querySelector(selector);
  check('Yes/No toggle buttons are the answer, so a label bundled with them is left out (Creatify)',
    nonAnswerMembers(['label[for="8b35931a"]', '#yes', '#no'], atAshby), ['label[for="8b35931a"]']);
  check('an upload\'s button and label are left out, so the file input decides (Creatify)',
    nonAnswerMembers(['label[for="resume"]', '#resume', '#upload'], atAshby), ['label[for="resume"]', '#upload']);
  check('a member that isn\'t on the page isn\'t excluded (it isn\'t answered)', nonAnswerMembers(['#first_name', '#gone'], at), []);
  check('a single selector, or a question with no real control, is left alone',
    [nonAnswerMembers(['#accepted-filetypes'], at), nonAnswerMembers(['#accepted-filetypes', '#upload-label-resume'], at)], [[], []]);
}

console.log('\n== only answerable questions get spliced in ==');
const q = page(`<input id="t" /><input id="h" type="hidden" /><button id="b">Add another</button><h3 id="hd">Education</h3>
  <div id="wrap"><input type="radio" name="x" /></div><div id="cb" role="combobox"></div>`);
check('text input / combobox role / wrapper around a radio -> question',
  ['#t', '#cb', '#wrap'].map((s) => isQuestionElement(q.querySelector(s)!)), [true, true, true]);
check('hidden input / button / heading -> not a question',
  ['#h', '#b', '#hd'].map((s) => isQuestionElement(q.querySelector(s)!)), [false, false, false]);

console.log('\n== splicing a page change into a live widget ==');
const doc = page(`<form>
  <label for="first_name">First Name*</label><input id="first_name" aria-required="true" />
  <label for="email">Email*</label><input id="email" aria-required="true" />
  <label for="hispanic">Are you Hispanic/Latino?</label><input id="hispanic" role="combobox" />
  <label for="race">Please identify your race</label><input id="race" role="combobox" />
  <label for="veteran">Veteran Status</label><input id="veteran" role="combobox" />
  <input id="start-month" /><input id="start-year" />
  <label for="late">Anything else?</label><textarea id="late"></textarea>
  <h3 id="eeo-heading">Voluntary Self-Identification</h3>
  <button id="add-another" type="button">Add another</button>
</form>`);
const find = (s: string) => doc.querySelector(s);
const widget: WidgetItem[] = [
  { selector: '#first_name', label: 'First Name*', section: 'Personal' },
  { selector: '#email', label: 'Email*', section: 'Personal' },
  { selector: '#hispanic', label: 'Hispanic/Latino', section: 'Self-identification' },
  { selector: '#veteran', label: 'Veteran Status', section: 'Self-identification' },
  { label: 'Read the job description', manual: true },
];
const labels = (items: WidgetItem[]) => items.map((item) => item.label);

let r = spliceWidgetItems(widget, [{ selector: '#race', label: 'Please identify your race' }], [], find);
check('a revealed question lands in page order (after Hispanic/Latino, before Veteran)',
  labels(r.items), ['First Name*', 'Email*', 'Hispanic/Latino', 'Please identify your race', 'Veteran Status', 'Read the job description']);
check('...and takes its neighbour\'s section', r.items[3]?.section, 'Self-identification');
check('...counted as one addition', [r.added, r.removed], [1, 0]);
check('the original item list is left untouched', widget.length, 5);

r = spliceWidgetItems(widget, [{ selector: '#late', label: 'Anything else?' }], [], find);
check('a question after every tracked item goes after the last tracked one, before trailing manual items',
  labels(r.items).slice(-2), ['Anything else?', 'Read the job description']);

r = spliceWidgetItems(widget, [{ selector: '#email', label: 'Email' }], [], find);
check('a question the widget already tracks is not added twice', [r.added, r.items.length], [0, 5]);
r = spliceWidgetItems(widget, [{ selector: '#eeo-heading', label: 'Voluntary Self-Identification' },
  { selector: '#add-another', label: 'Add another' }, { selector: '#not-on-page', label: 'Ghost' }], [], find);
check('a heading, a button, and a selector not on the page are all skipped', [r.added, r.items.length], [0, 5]);

r = spliceWidgetItems(widget, [], ['#hispanic'], find);
check('a question that left the page is dropped', [labels(r.items), r.removed],
  [['First Name*', 'Email*', 'Veteran Status', 'Read the job description'], 1]);
r = spliceWidgetItems([{ selectors: ['#start-month', '#start-year'], label: 'Start date' }], [], ['#start-year'], find);
check('a bundle that lost one control keeps tracking the rest', [r.items, r.removed], [[{ selectors: ['#start-month'], label: 'Start date' }], 1]);
r = spliceWidgetItems(widget, [{ selector: '#race', label: 'Please identify your race' }], ['#veteran'], find);
check('an add and a removal in the same change', [labels(r.items).slice(2, 4), r.added, r.removed],
  [['Hispanic/Latino', 'Please identify your race'], 1, 1]);
r = spliceWidgetItems([{ selector: '#first_name', label: 'First' }], [{ selector: '#email', label: 'Email' }], [], find);
check('no `section` is invented for a widget that doesn\'t group by one', 'section' in (r.items[1] ?? {}), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
