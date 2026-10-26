/*
The following file tests the plugin against markup rebuilt from the three live pages used for the
pilot studies (tests/e2e/live_sites.mjs runs the whole system on the live pages themselves)
- Kargo's Greenhouse application: answering "Are you Hispanic/Latino?" adds the race question
- Creatify's Ashby application: its upload buttons are actions, and its questions are required
- TechnicalWall's Canva tutorial: its steps are read, and ads loading in never count as a page change
  node tests/plugin/live-pages.test.ts
*/
import { parseHTML } from 'linkedom';

/*************************************************************************************************
Browser shims
*************************************************************************************************/

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

// linkedom has no layout: an element is hidden when it or an ancestor is `hidden` or display:none
function computedStyle(element: Element) {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const inline = node.getAttribute('style') || '';
    if (node.hasAttribute('hidden') || /display\s*:\s*none/i.test(inline)) return { display: 'none', visibility: 'visible' };
  }
  return { display: 'block', visibility: 'visible' };
}
function loadPage(html: string, bodyClass = '') {
  const dom = parseHTML(`<!doctype html><html><body class="${bodyClass}">${html}</body></html>`);
  (dom.window as unknown as { getComputedStyle: typeof computedStyle }).getComputedStyle = computedStyle;
  (globalThis as Record<string, unknown>).document = dom.document;
  return dom.document;
}

const { scanPage, diffFieldSnapshots } = await import('../../plugin/lib/page-scan.ts');
const { mutationsIncludeFieldChange } = await import('../../plugin/lib/mutations.ts');
const { isElementComplete, isActionElement } = await import('../../plugin/lib/completion.ts');
const { isItemRequired } = await import('../../plugin/lib/widget-items.ts');

const fieldsOf = (html: string, bodyClass = '') => { loadPage(html, bodyClass); return scanPage().fields; };
const change = (before: string, after: string) => diffFieldSnapshots(fieldsOf(before), fieldsOf(after));
const isStructural = (d: ReturnType<typeof change>) => d.added.length + d.revealed.length + d.removed.length + d.hidden.length > 0;

// MutationRecord-like objects built from real nodes
type FakeMutation = { type: string; addedNodes: unknown[]; removedNodes: unknown[]; attributeName: string | null; oldValue?: string | null; target: unknown };
const mut = (o: Partial<FakeMutation>): FakeMutation =>
  ({ type: 'childList', addedNodes: [], removedNodes: [], attributeName: null, oldValue: null, target: loadPage('').body, ...o });
const gate = (...mutations: FakeMutation[]) => mutationsIncludeFieldChange(mutations as unknown as MutationRecord[]);

/*************************************************************************************************
Kargo on Greenhouse (job-boards.greenhouse.io/kargo/jobs/6100170004)
*************************************************************************************************/

/*
A Greenhouse react-select question as the page renders it: a placeholder until an option is
chosen, then the chosen value and a clear button. While open, its options sit in a menu listbox.
*/
const greenhouseSelect = (id: string, label: string, { value = '', open = false } = {}) => `
  <div class="select"><div class="select__container">
    <label id="${id}-label" for="${id}" class="label select__label">${label}</label>
    <div class="select-shell"><div>
      <div class="select__control">
        <div class="select__value-container${value ? ' select__value-container--has-value' : ''}">
          ${value ? `<div class="select__single-value">${value}</div>` : `<div class="select__placeholder" id="react-select-${id}-placeholder">Select...</div>`}
          <div class="select__input-container" data-value="">
            <input class="select__input" id="${id}" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="true"
              aria-expanded="${open}" aria-labelledby="${id}-label" aria-required="false" ${open ? `aria-controls="react-select-${id}-listbox"` : ''} value="" />
          </div>
        </div>
        <div class="select__indicators">
          ${value ? '<button type="button" class="icon-button" aria-label="Clear selections" data-testid="clear-selection"></button>' : ''}
          <button type="button" class="icon-button" aria-label="Toggle flyout" tabindex="-1"></button>
        </div>
      </div>
      ${open ? `<div class="select__menu"><div class="select__menu-list" role="listbox" id="react-select-${id}-listbox">
        <div class="select__option" role="option">Yes</div><div class="select__option" role="option">No</div>
        <div class="select__option" role="option">Decline To Self Identify</div></div></div>` : ''}
    </div></div>
  </div></div>`;

const kargo = ({ hispanic = '', open = false, race = false } = {}) => `
  <form id="application-form">
    <div class="field"><label id="first_name-label" for="first_name">First Name<span class="required">*</span></label>
      <input id="first_name" type="text" aria-required="true" aria-labelledby="first_name-label" /></div>
    <div class="field"><label id="email-label" for="email">Email<span class="required">*</span></label>
      <input id="email" type="text" aria-required="true" aria-labelledby="email-label" /></div>
    <h2>Voluntary Self-Identification</h2>
    <div class="eeoc__question__wrapper">
      ${greenhouseSelect('hispanic_ethnicity', 'Are you Hispanic/Latino?', { value: hispanic, open })}
      ${race ? greenhouseSelect('race', 'Please identify your race') : ''}
      <a class="link" href="https://job-boards.cdn.greenhouse.io/docs/2023/RaceEthnicityDefinitions.pdf">Race &amp; Ethnicity Definitions</a>
    </div>
    <button type="submit">Submit application</button>
  </form>`;

console.log('== Kargo: answering Hispanic/Latino adds the race question ==');
{
  const answered = change(kargo(), kargo({ hispanic: 'No', race: true }));
  check('answering "No" adds the race question, and only it', answered.added.map((e) => e.selector), ['#race']);
  check('  the answered question itself is not a change to the page', answered.removed.concat(answered.hidden), []);
  check('opening the Hispanic/Latino dropdown is not a page change', isStructural(change(kargo(), kargo({ open: true }))), false);

  const page = loadPage(kargo({ open: true }));
  const menu = page.querySelector('.select__menu')!;
  check('  nor do its options appearing pass the mutation gate', gate(mut({ addedNodes: [menu], target: menu.parentElement })), false);
  const after = loadPage(kargo({ hispanic: 'No', race: true }));
  const raceBlock = after.getElementById('race')!.closest('.select')!;
  check('the race question appearing passes the mutation gate', gate(mut({ addedNodes: [raceBlock], target: raceBlock.parentElement })), true);

  const hispanic = (value: string) => loadPage(kargo({ hispanic: value, race: !!value })).getElementById('hispanic_ethnicity')!;
  check('Hispanic/Latino with only "Select..." showing is unanswered', isElementComplete(hispanic(''), '#hispanic_ethnicity'), false);
  check('  with "No" chosen it is answered', isElementComplete(hispanic('No'), '#hispanic_ethnicity'), true);
  check('the race question is unanswered when it appears', isElementComplete(after.getElementById('race')!, '#race'), false);

  const doc = loadPage(kargo());
  const resolve = (selector: string) => doc.querySelector(selector);
  check('First Name is required (aria-required)', isItemRequired(['#first_name'], resolve), true);
  check('Hispanic/Latino is optional', isItemRequired(['#hispanic_ethnicity'], resolve), false);
  check('the Submit button is an action, never checked off', [isActionElement(doc.querySelector('button[type="submit"]')!), isElementComplete(doc.querySelector('button[type="submit"]')!, 'button')], [true, false]);
}

/*************************************************************************************************
Creatify on Ashby (jobs.ashbyhq.com/creatify/.../application)
*************************************************************************************************/

/*
Ashby's application: an "Autofill from resume" box with its own upload, then Name, Email and a
Resume drop zone, each required
*/
const creatify = (parsing = false) => `
  <div class="ashby-application-form-autofill-input-root" data-state="default">
    <input type="file" tabindex="-1" accept=".pdf,.doc,.docx" />
    <div class="ashby-application-form-autofill-input-base-layer">
      <h3 class="ashby-application-form-autofill-input-title">Autofill from resume</h3>
      <p class="ashby-application-form-autofill-input-description">Upload your resume here to autofill key application fields.</p>
      <button id="autofill-upload">Upload file</button>
    </div>
    <div class="ashby-application-form-autofill-input-pending-layer" data-state="${parsing ? 'visible' : 'hidden'}"${parsing ? '' : ' hidden'}>
      <span aria-label="Loading..." role="progressbar"></span><span>Parsing your resume. Autofilling key fields...</span>
    </div>
  </div>
  <div class="ashby-application-form-container">
    <div class="ashby-application-form-field-entry" data-field-path="_systemfield_name">
      <label class="ashby-application-form-question-title" for="_systemfield_name">Name</label>
      <div><input placeholder="Type here..." name="_systemfield_name" required id="_systemfield_name" type="text" value="" /></div></div>
    <div class="ashby-application-form-field-entry" data-field-path="_systemfield_email">
      <label class="ashby-application-form-question-title" for="_systemfield_email">Email</label>
      <div><input placeholder="hello@example.com..." name="_systemfield_email" required id="_systemfield_email" type="email" value="" /></div></div>
    <div class="ashby-application-form-field-entry" data-field-path="_systemfield_resume">
      <label class="ashby-application-form-question-title" for="_systemfield_resume">Resume</label>
      <div role="presentation" class="ashby-application-form-input-file">
        <input type="file" tabindex="-1" id="_systemfield_resume" required />
        <div class="ashby-application-form-input-file-dropzone"><button id="resume-upload"><span>Upload File</span></button><p>or drag and drop here</p></div>
      </div></div>
    <button id="submit" class="ashby-application-form-submit-button"><span>Submit Application</span></button>
  </div>`;

console.log('\n== Creatify: upload buttons are actions, and its questions are required ==');
{
  const doc = loadPage(creatify());
  const el = (selector: string) => doc.querySelector(selector)!;
  const resolve = (selector: string) => doc.querySelector(selector);
  check('"Upload file" for autofill is an action, never checked off', [isActionElement(el('#autofill-upload')), isElementComplete(el('#autofill-upload'), '#autofill-upload')], [true, false]);
  check('the resume drop zone\'s "Upload File" button is an action', isActionElement(el('#resume-upload')), true);
  check('Submit Application is an action', isActionElement(el('#submit')), true);
  check('Name, Email and Resume are required', ['#_systemfield_name', '#_systemfield_email', '#_systemfield_resume'].map((s) => isItemRequired([s], resolve)), [true, true, true]);
  check('the Resume question is unanswered until a file is chosen', isElementComplete(el('#_systemfield_resume'), '#_systemfield_resume'), false);
  (el('#_systemfield_name') as HTMLInputElement).value = 'Test User';
  check('a typed name answers Name', isElementComplete(el('#_systemfield_name'), '#_systemfield_name'), true);

  const fields = [...scanPage().fields.values()].flatMap((entry) => entry.elements.map((e) => e.selector));
  check('the scan sees Name, Email and Resume as questions', ['#_systemfield_name', '#_systemfield_email', '#_systemfield_resume'].every((s) => fields.includes(s)), true);
  // one page that persists, as in a browser: the pending layer shows while the resume is parsed
  const before = scanPage().fields;
  const pending = doc.querySelector('.ashby-application-form-autofill-input-pending-layer')!;
  pending.removeAttribute('hidden');
  pending.setAttribute('data-state', 'visible');
  check('autofill parsing the resume is not a change to the questions', isStructural(diffFieldSnapshots(before, scanPage().fields)), false);
  check('  nor does its progress layer showing pass the mutation gate', gate(mut({ type: 'attributes', attributeName: 'hidden', target: pending, oldValue: '' })), false);
}

/*************************************************************************************************
TechnicalWall's Canva tutorial (technicalwall.com/canva/how-to-make-a-business-card-in-canva/)
*************************************************************************************************/

/*
The tutorial's steps as its page builder renders them, with a lazy-loaded image and an ad slot that
fills in after load. The body carries the theme's menu classes.
*/
const BODY_CLASS = 'wp-singular single single-post wp-theme-generatepress sticky-menu-fade both-sticky-menu dropdown-hover';
const step = (n: number, title: string, text: string) => `
  <div class="thrv_wrapper thrv_text_element"><h3 id="t-step-${n}">Step ${n}: ${title}</h3></div>
  <div class="thrv_wrapper thrv_text_element"><p id="p-step-${n}">${text}</p></div>
  <div class="thrv_wrapper tve_image_caption"><span class="tve_image_frame"><img id="img-step-${n}" class="tve_image" alt="Step ${n} screenshot" src="data:image/svg+xml;base64,PHN2Zy8+" /></span></div>`;
const canva = (adFilled = false) => `
  <article><div class="entry-content">
    <h1>How to Make a Business Card in Canva</h1>
    <div class="thrv_wrapper"><h2 id="t-steps">How to Make a Business Card in Canva?</h2></div>
    ${step(1, 'Search for Business Card templates in Canva', 'Go to Canva.com and open your Canva account.')}
    <div class="mv-ad-box"><div class="mv-rail-frame-250"><div id="content_4_btf_wrapper" class="adunitwrapper content_btf_wrapper">
      <div id="content_4_btf" class="content_btf adunit">${adFilled ? '<iframe id="ad-frame" title="Advertisement" src="about:blank"></iframe>' : ''}</div>
    </div><mv-ad-reporter></mv-ad-reporter></div></div>
    ${step(2, 'Choose a Template', 'Pick a template you like from the results.')}
  </div></article>`;

console.log('\n== TechnicalWall: the tutorial is read, and ads loading in are not page changes ==');
{
  loadPage(canva(), BODY_CLASS);
  const { elements, fields } = scanPage();
  const selectors = elements.map((e) => e.selector);
  check('the steps and their instructions are scanned, despite the body\'s menu classes',
    ['#t-step-1', '#p-step-1', '#t-step-2', '#p-step-2'].every((s) => selectors.includes(s)), true);
  check('the tutorial has no questions', fields.size, 0);
  check('an ad slot filling in is not a page change', isStructural(change(canva(), canva(true))), false);

  const doc = loadPage(canva(true), BODY_CLASS);
  const ad = doc.getElementById('ad-frame')!;
  check('  nor does it pass the mutation gate', gate(mut({ addedNodes: [ad], target: ad.parentElement })), false);
  const img = doc.getElementById('img-step-1')!;
  img.setAttribute('src', 'https://technicalwall.com/wp-content/uploads/canva-homepage.png');
  check('a lazy image loading its real source does not pass the gate', gate(mut({ type: 'attributes', attributeName: 'src', target: img, oldValue: 'data:image/svg+xml;base64,PHN2Zy8+' })), false);
  check('a step heading is content, never checked off by the page', isElementComplete(doc.getElementById('t-step-1')!, '#t-step-1'), false);
}

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
