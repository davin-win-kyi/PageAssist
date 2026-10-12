// Runs the REAL plugin/lib/mutations.ts describeMutation — the per-mutation summary content.ts sends
// with every PAGE_CHANGED event (the side panel's hydration check counts its formControlsAdded) —
// against MutationRecord-shaped objects built from real linkedom nodes.
//   node tests/plugin/mutations.test.ts
import { parseHTML } from 'linkedom';

const boot = parseHTML('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'ShadowRoot'] as const) {
  (globalThis as Record<string, unknown>)[k] = (boot as unknown as Record<string, unknown>)[k];
}
(globalThis as Record<string, unknown>).CSS = { escape: (s: string) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };

const { describeMutation } = await import('../../plugin/lib/mutations.ts');

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? (pass += 1) : (fail += 1);
}
const page = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
type Fake = { type: string; target: unknown; addedNodes: unknown[]; removedNodes: unknown[]; attributeName: string | null; oldValue: string | null };
const describe = (o: Partial<Fake>) => describeMutation({
  type: 'childList', target: page('').body, addedNodes: [], removedNodes: [], attributeName: null, oldValue: null, ...o,
} as unknown as MutationRecord);
const isBareTag = (s: string) => /^[a-z][a-z0-9-]*$/.test(s);

console.log('== an added <div> reports the controls nested inside it ==');
{
  const doc = page(`<div class="entry"><label>School <input name="school" /></label><label>Degree <input id="degree" /></label></div>`);
  const d = describe({ target: doc.body, addedNodes: [doc.querySelector('.entry')] });
  check('both nested inputs are counted (not "1 subtree")', d.formControlsAdded, 2);
  check('their identities are reported, not just the wrapper\'s',
    ['input[name="school"]', '#degree'].every((s) => d.addedSelectors.includes(s)), true);
  check('no identity is an ambiguous bare tag like "div"', d.addedSelectors.some(isBareTag), false);
  check('the wrapper itself gets a stable (stamped) identity', d.addedSelectors.some((s) => s.startsWith('[data-tw-ref=')), true);
}
{
  // One react-select = several "select"-classed wrappers around ONE combobox input.
  const doc = page(`<div class="field"><div class="select__container"><div class="select__control"><div class="select__value-container">
    <div class="select__placeholder">Select...</div><div class="select__input-container"><input id="race" role="combobox" /></div>
    </div></div></div></div>`);
  check('a react-select counts as ONE control, not one per "select"-classed wrapper',
    describe({ addedNodes: [doc.querySelector('.field')] }).formControlsAdded, 1);
  const menu = page(`<div class="select__menu" role="listbox"><div role="option"><input type="checkbox" id="o1" /></div><div role="option"><input type="checkbox" id="o2" /></div></div>`);
  check('controls inside an opened dropdown menu are not counted', describe({ addedNodes: [menu.querySelector('.select__menu')] }).formControlsAdded, 0);
  const many = page('<div id="a"><input id="x1" /></div>');
  const second = page('<div id="b"><input id="x2" /><input id="x3" /></div>');
  check('counts add up across several added subtrees', describe({ addedNodes: [many.querySelector('#a'), second.querySelector('#b')] }).formControlsAdded, 3);
}

console.log('\n== removed elements report the identities they carried ==');
{
  const doc = page('<div class="field"><label for="race">Race</label><select id="race"></select><input data-tw-ref="tw-7" /></div>');
  const removed = doc.querySelector('.field')!;
  removed.remove();
  const d = describe({ removedNodes: [removed] });
  check('removed controls are counted', d.formControlsRemoved, 2);
  check('their identities are reported (id, and the stamp the scan gave the other)',
    ['#race', '[data-tw-ref="tw-7"]'].every((s) => d.removedSelectors.includes(s)), true);
  check('a removed wrapper with no identity is left out rather than reported as "div"', d.removedSelectors.some(isBareTag), false);
}

console.log('\n== mutation targets that are not elements ==');
{
  const doc = page('<p id="p">Hello <!-- note --></p>');
  const comment = [...doc.querySelector('#p')!.childNodes].find((n) => n.nodeType === 8);
  const onComment = describe({ type: 'characterData', target: comment });
  check('a comment node -> its parent element', [onComment.target, onComment.targetSelector], ['#p', '#p']);
  const text = doc.querySelector('#p')!.firstChild;
  check('a text node -> its parent element', describe({ type: 'characterData', target: text }).targetSelector, '#p');
  const onDocument = describe({ target: doc });
  check('the document itself -> no target, no crash', [onDocument.target, onDocument.targetSelector], ['document', null]);
  const host = page('<div id="host"></div>').querySelector('#host');
  check('a shadow root -> its host element', describe({ target: { nodeType: 11, host } }).targetSelector, '#host');
  const bare = page('<section><span>x</span></section>').querySelector('section');
  check('an element with nothing unique gets a stamp, never a bare tag', isBareTag(describe({ target: bare }).targetSelector!), false);
}

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
