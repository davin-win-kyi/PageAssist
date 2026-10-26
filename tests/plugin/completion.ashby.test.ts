// Runs the REAL completion-detection logic against Ashby's application-form DOM patterns
// (jobs.ashbyhq.com/reducto/.../application). The live page is fully client-rendered, so the markup
// below is Ashby's stable structure: an `ashby-application-form-field-entry` wrapper per field, a
// custom `_select_`-hashed combobox with `_placeholder_` / `_value_` display divs, and a
// `[role="radiogroup"]` of `[role="radio"][aria-checked]` options for Yes/No questions.
// Sections 5 and 6 are markup taken from the live Creatify application (jobs.ashbyhq.com/creatify),
// before and after answering: Yes/No toggle buttons over a hidden checkbox, and the resume upload.
//   node tests/plugin/completion.ashby.test.ts
import { parseHTML } from 'linkedom';

const dom = parseHTML('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'] as const) {
  (globalThis as Record<string, unknown>)[k] = (dom as unknown as Record<string, unknown>)[k];
}

const { isElementComplete, isItemComplete } = await import('../../plugin/lib/completion.ts');

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
// 5. Creatify's Yes/No questions: toggle buttons (aria-pressed) over a hidden checkbox that is checked
//    for "Yes" and stays unchecked for "No". The label's `for` names the checkbox's `name`, not an id.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 5. Yes/No toggle buttons over a hidden checkbox (Creatify) ==');
{
  const yesNo = (path: string, question: string, chosen: '' | 'yes' | 'no') => `
    <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry" data-field-path="${path}">
      <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="${path}">${question}</label>
      <div class="_container_1svni_28 _yesno_1e3gg_148  ashby-application-form-input-yesno">
        <button class="_container_pjyt6_1 _option_1svni_32 ${chosen === 'yes' ? '_active_1svni_57' : ''} ashby-application-form-input-yesno-option" aria-pressed="${chosen === 'yes'}" data-option="yes" data-tw-ref="${path}-yes">Yes</button>
        <button class="_container_pjyt6_1 _option_1svni_32 ${chosen === 'no' ? '_active_1svni_57' : ''} ashby-application-form-input-yesno-option" aria-pressed="${chosen === 'no'}" data-option="no" data-tw-ref="${path}-no">No</button>
        <input type="checkbox" class="_input_1svni_78" tabindex="-1" name="${path}"${chosen === 'yes' ? ' checked' : ''}>
      </div>
    </div>`;
  const form = (authorized: '' | 'yes' | 'no', sponsorship: '' | 'yes' | 'no') => frag(`<div class="_section_1e3gg_1">
    ${yesNo('8b35931a-1d48-4210-b2d9-1d1b99f490d5', 'Are you legally authorized to work in the United States?', authorized)}
    ${yesNo('b9428a01-aa56-4700-8b71-e83f262c999c', 'Do you now or in the future require sponsorship from the company?', sponsorship)}
  </div>`);
  const label = 'label[for="8b35931a-1d48-4210-b2d9-1d1b99f490d5"]';
  const judge = (body: Element, selector: string) => isElementComplete(body.querySelector(selector)!, selector);
  check('grounded on the question\'s label, nothing chosen -> incomplete', judge(form('', ''), label), false);
  check('grounded on the label, "Yes" chosen -> complete', judge(form('yes', ''), label), true);
  check('grounded on the label, "No" chosen (checkbox stays unchecked) -> complete', judge(form('no', ''), label), true);
  check('the other question\'s label stays incomplete', judge(form('no', ''), 'label[for="b9428a01-aa56-4700-8b71-e83f262c999c"]'), false);
  check('grounded on the "Yes" button, "No" chosen -> complete (its group is answered)',
    judge(form('no', ''), '[data-tw-ref="8b35931a-1d48-4210-b2d9-1d1b99f490d5-yes"]'), true);
  check('grounded on the "No" button, nothing chosen -> incomplete',
    judge(form('', ''), '[data-tw-ref="8b35931a-1d48-4210-b2d9-1d1b99f490d5-no"]'), false);
  check('grounded on the hidden checkbox, "No" chosen -> complete',
    judge(form('no', ''), 'input[name="8b35931a-1d48-4210-b2d9-1d1b99f490d5"]'), true);
  check('grounded on the field entry, "No" chosen -> complete',
    judge(form('no', ''), '[data-field-path="8b35931a-1d48-4210-b2d9-1d1b99f490d5"]'), true);
  const bundle = [label, '[data-tw-ref="8b35931a-1d48-4210-b2d9-1d1b99f490d5-yes"]', '[data-tw-ref="8b35931a-1d48-4210-b2d9-1d1b99f490d5-no"]'];
  const answered = form('no', '');
  check('an item bundling the label and both buttons, "No" chosen -> complete',
    isItemComplete(bundle, (selector) => answered.querySelector(selector)), true);
  const unanswered = form('', '');
  check('the same item, nothing chosen -> incomplete',
    isItemComplete(bundle, (selector) => unanswered.querySelector(selector)), false);
}

// ---------------------------------------------------------------------------------------------------
// 6. Creatify's resume upload: a visually hidden file input (tabindex -1) inside the upload area,
//    which shows the file's name and a "Delete file" button once one is chosen. The input can be
//    emptied once the page has taken the file, so the area is what shows the answer.
// ---------------------------------------------------------------------------------------------------
console.log('\n== 6. resume upload (Creatify) ==');
{
  const resume = (chosen: boolean, hint = '') => frag(`<div class="_section_1e3gg_1">
    <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry" data-field-path="_systemfield_resume">
      <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="_systemfield_resume">Resume</label>
      <div role="presentation" class="_container_10xk4_70  ashby-application-form-input-file" data-tw-ref="tw-19">
        <input accept="application/pdf,.pdf,.doc,.docx" type="file" tabindex="-1" id="_systemfield_resume" required="" style="position: absolute; width: 1px; height: 1px; overflow: hidden;">
        ${chosen ? `<div class="_file_10xk4_76 ashby-application-form-input-file-item">
          <p class="_name_10xk4_41 ashby-application-form-input-file-item-name"><svg></svg><span>Jane Doe Resume (2).pdf</span></p>
          <button title="Delete file" class="_button_zyh3g_28 _quaternary_zyh3g_92 _negative_zyh3g_172 _removeButton_10xk4_83 ashby-application-form-input-file-item-delete"><svg></svg></button>
        </div>` : ''}
        <div class="_instructions_10xk4_33 ashby-application-form-input-file-dropzone">
          <button class="_button_zyh3g_28 _secondary_zyh3g_115 _button_10xk4_106 ashby-application-form-input-file-dropzone-upload" data-tw-ref="tw-20"><span>${chosen ? 'Replace' : 'Upload File'}</span></button>
          <p class="_dragInstructions_10xk4_28 ashby-application-form-input-file-dropzone-instructions">or drag and drop here</p>
          ${hint}
        </div>
      </div>
    </div>
    <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
      <label for="_systemfield_email">Email</label><input id="_systemfield_email" type="email" value="">
    </div>
  </div>`);
  const judge = (body: Element, selector: string) => isElementComplete(body.querySelector(selector)!, selector);
  check('grounded on the upload area, nothing chosen -> incomplete', judge(resume(false), '[data-tw-ref="tw-19"]'), false);
  check('grounded on the upload area, a file shown -> complete', judge(resume(true), '[data-tw-ref="tw-19"]'), true);
  check('grounded on the hidden input, emptied after the upload -> complete (the area shows the file)',
    judge(resume(true), '#_systemfield_resume'), true);
  check('grounded on the label, a file shown -> complete', judge(resume(true), 'label[for="_systemfield_resume"]'), true);
  check('grounded on the field entry, a file shown -> complete', judge(resume(true), '[data-field-path="_systemfield_resume"]'), true);
  check('grounded on the hidden input, nothing chosen -> incomplete', judge(resume(false), '#_systemfield_resume'), false);
  check('a list of accepted file types isn\'t a chosen file',
    judge(resume(false, '<p>Accepted: .pdf, .docx, .txt (max 5.0 MB)</p>'), '#_systemfield_resume'), false);
  check('nor is help text that mentions a file name',
    judge(resume(false, '<p>e.g. JaneDoe_Resume.pdf</p><p>Please upload resume.pdf or resume.docx</p>'), '#_systemfield_resume'), false);
  check('the next question isn\'t answered by the resume', judge(resume(true), '#_systemfield_email'), false);
}

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
