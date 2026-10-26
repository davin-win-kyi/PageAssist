// Runs the REAL plugin/lib/page-scan.ts scanPage() — what content.ts sends to the backend for the task
// representation — against reconstructed page markup: which elements are collected, the fields each
// one carries, the context containers that keep their relationships, and selectors/ids that stay
// stable while the page changes around them.
//   node tests/plugin/page-scan.test.ts
import { parseHTML } from 'linkedom';

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

function loadPage(html: string) {
  const dom = parseHTML(`<!doctype html><html><head><meta id="csp-nonce" /><script id="boot"></script></head><body>${html}</body></html>`);
  (dom.window as unknown as { getComputedStyle: () => object }).getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  (globalThis as Record<string, unknown>).document = dom.document;
  return dom.document;
}

const { scanPage, containersReferencedBy, isElementVisible, isInTransientLayer } = await import('../../plugin/lib/page-scan.ts');
const scan = (html: string) => { const doc = loadPage(html); return { doc, ...scanPage() }; };

console.log('== what gets collected ==');
{
  const { elements } = scan(`
    <div id="root"><span id="decor">x</span>
      <h2>Create the album art frame</h2>
      <p>Draw a square frame
         and set its fill.</p>
      <ol><li>Draw a square</li><li>Round the corners</li></ol>
      <dl><dt>Frame</dt><dd>A container layer</dd></dl>
      <pre>width: 240px</pre>
      <table><caption>Shortcuts</caption><tr><th>Key</th><td>F</td></tr></table>
      <figure><img src="frame.png" alt="A square frame on the canvas" /><figcaption>The finished frame</figcaption></figure>
      <details><summary>Troubleshooting</summary></details>
      <a href="/next">Next lesson</a><a name="top">anchor without href</a>
      <button>Submit</button>
      <label for="q">Question</label><input id="q" type="text" /><input type="hidden" name="csrf" value="t" />
      <textarea id="notes"></textarea><select id="pick"><option>One</option></select>
      <div role="switch" id="toggle" aria-checked="false"></div><div contenteditable="true" id="editor"></div>
    </div>`);
  const tags = new Set(elements.map((e) => e.tag));
  check('instructional + visual content is collected (p, li, dt, dd, pre, caption, th, td, img, figcaption, summary)',
    ['p', 'li', 'dt', 'dd', 'pre', 'caption', 'th', 'td', 'img', 'figcaption', 'summary'].every((t) => tags.has(t)), true);
  check('controls, labels, links with href, buttons, role-bearing and editable regions are collected',
    ['input', 'textarea', 'select', 'label', 'a', 'button', 'h2'].every((t) => tags.has(t))
      && elements.some((e) => e.selector === '#toggle') && elements.some((e) => e.selector === '#editor'), true);
  check('hidden inputs are NOT collected', elements.some((e) => e.selector.includes('csrf')), false);
  check('a link without href is NOT collected', elements.some((e) => e.text === 'anchor without href'), false);
  check('<option>s are NOT collected (the <select> carries its choices in its text)', tags.has('option'), false);
  check('id-only elements (layout <div>, <span>, <meta>, <script>) are NOT collected',
    ['#root', '#decor', '#csp-nonce', '#boot'].some((s) => elements.some((e) => e.selector === s)), false);
  check('an image is named by its alt text', elements.find((e) => e.tag === 'img')?.accessibleName, 'A square frame on the canvas');
  check('text has whitespace collapsed', elements.find((e) => e.tag === 'p')?.text, 'Draw a square frame and set its fill.');
}

console.log('\n== the fields each element carries ==');
{
  const { elements } = scan(`
    <form id="apply">
      <label for="email">Email</label>
      <input id="email" type="email" value="ada@" aria-invalid="true" aria-describedby="email-hint" aria-errormessage="email-err" />
      <p id="email-hint">We'll send the offer here.</p><p id="email-err">Enter a valid email address.</p>
      <label for="name">Name</label><input id="name" type="text" value="Ada" />
      <label for="city">City</label><input id="city" type="text" value="" />
      <label><input type="checkbox" id="terms" /> I agree</label>
      <input id="nick" type="text" title="What friends call you" placeholder="Nickname" />
      <button id="go">Apply</button><h2 id="heading">About you</h2>
    </form>`);
  const by = (sel: string) => elements.find((e) => e.selector === sel)!;
  check('every element has the full field set', Object.keys(by('#email')),
    ['id', 'selector', 'tag', 'text', 'role', 'accessibleName', 'description', 'completion_status', 'container', 'visible']);
  check('description = aria-describedby + the error message while aria-invalid',
    by('#email').description, "We'll send the offer here. Enter a valid email address.");
  check('description falls back to a title not already used as the name', by('#nick').description, 'What friends call you');
  check('completion_status: a filled text input is complete, an empty one incomplete',
    [by('#name').completion_status, by('#city').completion_status], ['complete', 'incomplete']);
  check('completion_status: an unchecked checkbox is incomplete', by('#terms').completion_status, 'incomplete');
  check('completion_status is "" for things that aren\'t answerable', [by('#go').completion_status, by('#heading').completion_status], ['', '']);
  check('id is the element\'s own id when it has one', by('#email').id, 'email');
}

console.log('\n== context containers ==');
{
  const { elements, containers } = scan(`
    <section id="eeo" aria-labelledby="eeo-h"><h2 id="eeo-h">Voluntary self-identification</h2>
      <form id="apply">
        <fieldset id="vet"><legend>Are you a protected veteran?</legend>
          <label><input type="radio" id="vet-yes" name="veteran" /> Yes</label>
          <label><input type="radio" id="vet-no" name="veteran" /> No</label></fieldset>
        <table id="skills"><caption>Rate your skills</caption>
          <tr id="row-py"><th>Python</th><td><input type="radio" id="py-1" name="python" /></td></tr></table>
        <div role="radiogroup" id="auth" aria-labelledby="auth-l"><span id="auth-l">Authorized to work?</span>
          <div role="radio" id="auth-yes">Yes</div></div>
        <details id="more"><summary>Optional questions</summary><label for="pron">Pronouns</label><input id="pron" /></details>
        <div role="dialog" id="ref" aria-label="Add a reference"><input id="ref_name" /></div>
      </form>
    </section>`);
  const container = (sel: string) => elements.find((e) => e.selector === sel)?.container;
  const box = (sel: string) => containers.find((c) => c.selector === sel);
  check('a radio sits in its fieldset', container('#vet-yes'), '#vet');
  check('  which is labelled by its legend', box('#vet')?.label, 'Are you a protected veteran?');
  check('  and sits in the form, which sits in the section', [box('#vet')?.parent, box('#apply')?.parent, box('#eeo')?.parent], ['#apply', '#eeo', '']);
  check('a section is labelled by its ARIA name', box('#eeo')?.label, 'Voluntary self-identification');
  check('a table-cell control sits in its row, labelled by the row header', [container('#py-1'), box('#row-py')?.label], ['#row-py', 'Python']);
  check('  and the row sits in the table, labelled by its caption', [box('#row-py')?.parent, box('#skills')?.label], ['#skills', 'Rate your skills']);
  check('an ARIA radiogroup is a container with its role and name', [container('#auth-yes'), box('#auth')?.role, box('#auth')?.label],
    ['#auth', 'radiogroup', 'Authorized to work?']);
  check('a <details> is labelled by its summary', [container('#pron'), box('#more')?.label], ['#more', 'Optional questions']);
  check('a dialog is a container', [container('#ref_name'), box('#ref')?.label], ['#ref', 'Add a reference']);
  const chain = containersReferencedBy(elements.filter((e) => e.selector === '#vet-yes'), containers).map((c) => c.selector);
  check('containersReferencedBy returns an element\'s container plus every ancestor', chain, ['#vet', '#apply', '#eeo']);
}
{
  // Zendesk's help-center markup: one <section> around the WHOLE article body, h2 per step group.
  const { containers } = scan(`
    <article id="art"><header><h1>Create a responsive card</h1></header>
      <section id="body"><h2>Create a play button</h2><ol id="steps-1"><li>Draw a circle</li></ol>
        <h2>Create the album art frame</h2><ol id="steps-2"><li>Draw a square</li></ol></section>
      <section id="edu"><h2>Education</h2><ul id="edu-list"><li>School</li></ul></section>
    </article>`);
  const box = (sel: string) => containers.find((c) => c.selector === sel);
  check('a section with ONE heading of its own is labelled by it', box('#edu')?.label, 'Education');
  check('a wrapper around several same-level headings gets no label (not its first subsection\'s)', box('#body')?.label, '');
  check('an article is labelled by its own h1, not the headings inside its nested sections', box('#art')?.label, 'Create a responsive card');
}

console.log('\n== selectors and ids stay stable ==');
{
  const doc = loadPage('<ul id="steps"><li>Draw a square</li><li>Round the corners</li></ul>');
  const first = scanPage().elements.find((e) => e.text === 'Round the corners')!;
  doc.querySelector('#steps')!.insertAdjacentHTML('afterbegin', '<li>Open Figma</li>');
  const second = scanPage().elements.find((e) => e.text === 'Round the corners')!;
  check('an element without an id keeps its selector and id when a sibling is inserted before it',
    [second.selector, second.id], [first.selector, first.id]);
  check('  and that id is not positional', /element-\d+|nth-child/.test(first.id), false);

  const page = loadPage(`
    <div class="entry"><label>School <input type="text" name="school" /></label></div>
    <div class="entry"><label>School <input type="text" name="school" /></label></div>`);
  const schools = () => scanPage().elements.filter((e) => e.tag === 'input').map((e) => e.selector);
  const [a, b] = schools();
  check('two inputs sharing name="school" each get a selector that matches only itself',
    [a, b].map((selector) => page.querySelectorAll(selector).length), [1, 1]);
  check('  and the two selectors differ', a !== b, true);
  page.querySelector('.entry')!.remove();
  check('the stamp sticks once the first entry is removed (no identity churn)', schools(), [b]);
}

console.log('\n== send budget ==');
{
  const article = Array.from({ length: 600 }, (_, i) => `<p>Paragraph ${i} of a long job description.</p>`).join('');
  const { elements } = scan(`${article}<form><label for="late">Why do you want this role?</label><textarea id="late"></textarea></form>`);
  check('at most 500 elements are sent', elements.length, 500);
  check('a form after 600 paragraphs still makes the cut — its label and its control',
    [elements.some((e) => e.tag === 'label'), elements.some((e) => e.selector === '#late')], [true, true]);
}

console.log('\n== transient layers ==');
{
  const { elements } = scan(`
    <label for="c">Country</label><input id="c" role="combobox" />
    <div role="listbox"><div role="option" id="opt-ca">Canada</div></div>
    <div role="tooltip" id="tip">Where you live now</div>
    <div class="popup-overlay"><div role="dialog" id="dlg"><label for="d1">Reference</label><input id="d1" /></div></div>`);
  const has = (sel: string) => elements.some((e) => e.selector === sel);
  check('an open option list and a tooltip are not collected', [has('#opt-ca'), has('#tip')], [false, false]);
  check('a dialog\'s questions ARE collected, popup-classed wrapper or not', [has('#dlg'), has('#d1')], [true, true]);
}

console.log('\n== a popup-looking class on the page itself is not a popup ==');
{
  // technicalwall.com (WordPress, GeneratePress): <body class="... sticky-menu-fade both-sticky-menu dropdown-hover ...">
  const article = `<div id="page" class="site"><main id="main"><article>
      <h2 id="s1">Step 1: Search for Business Card templates in Canva</h2>
      <p id="p1">Open Canva and type "business card" in the search bar.</p>
      <ol><li id="l1">Pick a template</li></ol>
      <label for="font">Font</label><input id="font" role="combobox" />
      <div class="select__menu" role="listbox"><div role="option" id="opt-serif">Serif</div></div>
    </article></main>
    <nav><ul class="menu"><li id="nav1"><a href="/canva">Canva</a></li></ul></nav></div>`;
  const doc = loadPage(article);
  doc.body.setAttribute('class', 'single-post sticky-menu-fade both-sticky-menu dropdown-hover');
  const { elements } = scanPage();
  const has = (sel: string) => elements.some((e) => e.selector === sel);
  check('the article under a "…-menu-…" <body> IS collected (heading, paragraph, step, question)',
    [has('#s1'), has('#p1'), has('#l1'), has('#font')], [true, true, true, true]);
  check('  an open dropdown inside it is still NOT collected, nor a site nav menu',
    [has('#opt-serif'), has('#nav1')], [false, false]);
  const wrapped = scan(`<div id="page" class="site menu-open"><main><h1 id="t">Apply</h1><input id="name" /></main></div>`).elements;
  check('a "menu-open" wrapper around the main content is not a popup either',
    [wrapped.some((e) => e.selector === '#t'), wrapped.some((e) => e.selector === '#name')], [true, true]);
}

console.log('\n== other ways an element is hidden ==');
{
  // linkedom has no computed style; read opacity and display from inline styles
  const styled = (html: string) => {
    const doc = loadPage(html);
    (doc.defaultView as unknown as { getComputedStyle: (e: Element) => object }).getComputedStyle = (e: Element) => {
      const inline = e.getAttribute('style') || '';
      return { display: 'block', visibility: 'visible', opacity: /opacity\s*:\s*0(?![.\d])/.test(inline) ? '0' : '1' };
    };
    return doc;
  };
  const doc = styled(`<div id="faded" style="opacity:0"><p id="inside">Hidden text</p></div>
    <p id="own" style="opacity:0">Own opacity</p>
    <label class="pretty-radio"><input type="radio" id="styled" name="r" style="opacity:0" /> Yes</label>
    <div inert><input id="inert-field" /></div>
    <p id="shown">Shown</p>`);
  const visible = (id: string) => isElementVisible(doc.getElementById(id)!);
  check('text inside an opacity:0 container is hidden', visible('inside'), false);
  check('an element with opacity:0 itself is hidden', visible('own'), false);
  check('a styled radio whose native input is opacity:0 still counts as shown', visible('styled'), true);
  check('a field inside an inert region is hidden', visible('inert-field'), false);
  check('an ordinary element is shown', visible('shown'), true);
}

console.log('\n== popups found through the open control that points at them ==');
{
  const doc = loadPage(`<label for="city">City</label>
    <input id="city" role="combobox" aria-expanded="true" aria-controls="city-results" />
    <div id="city-results"><div><input type="checkbox" id="opt-a" /> Seattle</div></div>
    <button aria-expanded="true" aria-controls="more-qs">More questions</button>
    <section id="more-qs"><input id="extra" /></section>`);
  check('an option list an open combobox controls is temporary', isInTransientLayer(doc.getElementById('opt-a')!), true);
  check('a section a plain disclosure button expands is not temporary', isInTransientLayer(doc.getElementById('extra')!), false);
}

console.log('\n== popup names that a field itself also uses ==');
{
  const doc = loadPage(`<div class="select-wrapper"><input id="mz" class="select-dropdown dropdown-trigger" type="text" readonly value="Choose your option" />
    <ul class="dropdown-content select-dropdown"><li><span id="mz-opt">Option 1</span></li></ul></div>
    <div class="v-overlay v-dialog" role="dialog"><div class="v-overlay__content"><input id="in-dialog" /></div></div>`);
  check('a Materialize select\'s visible input is a field, not a popup', isInTransientLayer(doc.getElementById('mz')!), false);
  check('  while its open option list is a popup', isInTransientLayer(doc.getElementById('mz-opt')!), true);
  check('a question inside a Vuetify dialog is not in a popup', isInTransientLayer(doc.getElementById('in-dialog')!), false);
}

console.log('\n== a fixed element escapes a collapsed container ==');
{
  const doc = loadPage(`<div id="collapsed" style="overflow:hidden"><p id="clipped">Clipped</p>
    <div id="modal" style="position:fixed"><p id="inside-fixed">Shown</p></div></div>`);
  (doc.defaultView as unknown as { getComputedStyle: (e: Element) => object }).getComputedStyle = (e: Element) => {
    const inline = e.getAttribute('style') || '';
    return { display: 'block', visibility: 'visible', opacity: '1',
      overflow: /overflow\s*:\s*hidden/.test(inline) ? 'hidden' : 'visible',
      position: /position\s*:\s*fixed/.test(inline) ? 'fixed' : 'static' };
  };
  Object.defineProperty(doc.getElementById('collapsed')!, 'offsetHeight', { value: 0 });
  check('text in a zero-height container that clips is hidden', isElementVisible(doc.getElementById('clipped')!), false);
  check('  a fixed element inside it is shown, since it escapes the clipping', isElementVisible(doc.getElementById('modal')!), true);
  check('  and so is what the fixed element holds', isElementVisible(doc.getElementById('inside-fixed')!), true);
}

console.log('\n== fields no one can reach are not questions ==');
{
  const doc = loadPage(`<form><input id="trap" aria-label="Do not fill out this field" tabindex="-1" type="text" name="website" />
    <input id="email" aria-label="Your Email..." type="email" />
    <label class="pretty"><input id="radio" type="radio" name="r" /> Yes</label></form>`);
  const at = (left: number) => () => ({ left, right: left + 9, top: 10, bottom: 17, width: 9, height: 7 });
  Object.defineProperty(doc.getElementById('trap')!, 'getBoundingClientRect', { value: at(-99867) });
  Object.defineProperty(doc.getElementById('radio')!, 'getBoundingClientRect', { value: at(-9999) });
  check('a field moved far off the page and out of the tab order is hidden', isElementVisible(doc.getElementById('trap')!), false);
  check('  an ordinary field is shown', isElementVisible(doc.getElementById('email')!), true);
  check('  a visually hidden native radio still in the tab order is shown', isElementVisible(doc.getElementById('radio')!), true);
  const select = loadPage(`<div class="select__container"><input id="country" role="combobox" />
    <input id="required-helper" required tabindex="-1" aria-hidden="true" class="requiredInput" value="" /></div>`);
  check('a dropdown\'s hidden validation input is hidden too', isElementVisible(select.getElementById('required-helper')!), false);
  check('  while the dropdown itself is shown', isElementVisible(select.getElementById('country')!), true);
}

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
