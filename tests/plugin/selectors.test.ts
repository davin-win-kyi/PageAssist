// Runs the REAL plugin/lib/selectors.ts accessible-name / description extraction — what every scanned
// element's `accessibleName` and `description` are — against reconstructed markup.
//   node tests/plugin/selectors.test.ts
import { parseHTML } from 'linkedom';

const boot = parseHTML('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement'] as const) {
  (globalThis as Record<string, unknown>)[k] = (boot as unknown as Record<string, unknown>)[k];
}
(globalThis as Record<string, unknown>).CSS = { escape: (s: string) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };

const { computeAccessibleName, computeAccessibleDescription, stableSelector } = await import('../../plugin/lib/selectors.ts');

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? (pass += 1) : (fail += 1);
}
const el = (html: string, selector: string) =>
  parseHTML(`<!doctype html><html><body>${html}</body></html>`).document.querySelector(selector)!;
const name = (html: string, selector: string) => computeAccessibleName(el(html, selector));

console.log('== links, buttons and headings are named by their own text ==');
check('a button', name('<button id="b">Submit\n   application</button>', '#b'), 'Submit application');
check('a link', name('<a id="a" href="/jobs/1">View job details</a>', '#a'), 'View job details');
check('a heading', name('<h2 id="h">Voluntary Self-Identification</h2>', '#h'), 'Voluntary Self-Identification');
check('an ARIA button / link / heading', [name('<div id="d" role="button">Add another</div>', '#d'),
  name('<span id="s" role="link">Privacy policy</span>', '#s'), name('<div id="r" role="heading" aria-level="2">Education</div>', '#r')].join(' | '),
  'Add another | Privacy policy | Education');
check('an icon-only link, by its image\'s alt text', name('<a id="a" href="/"><img src="logo.svg" alt="Veeda AI home" /></a>', '#a'), 'Veeda AI home');
check('an <input type="submit">, by its value', name('<input id="i" type="submit" value="Apply now" />', '#i'), 'Apply now');
check('an ARIA name still overrides the text', name('<button id="b" aria-label="Close dialog">×</button>', '#b'), 'Close dialog');
check('a plain <div> is NOT named by its text', name('<div id="d">Some paragraph text</div>', '#d'), '');

console.log('\n== aria-labelledby takes precedence over aria-label ==');
check('both present -> aria-labelledby wins', name('<span id="l1">Legal first name</span><input id="fn" aria-label="First" aria-labelledby="l1" />', '#fn'), 'Legal first name');
check('aria-labelledby pointing nowhere -> falls back to aria-label', name('<input id="fn" aria-label="First name" aria-labelledby="missing" />', '#fn'), 'First name');

console.log('\n== nothing is truncated during extraction ==');
const longQuestion = 'Describe your most significant accomplishment, what made it meaningful to you, and what you would do differently if you could do it again today';
check(`a ${longQuestion.length}-character label comes back in full`, name(`<label for="q">${longQuestion}</label><textarea id="q"></textarea>`, '#q'), longQuestion);
check('a long heading comes back in full', name(`<h3 id="h">${longQuestion}</h3>`, '#h'), longQuestion);
const longHelp = `${longQuestion}. Please keep it under 500 words and focus on your own contribution rather than the team's.`;
check(`a ${longHelp.length}-character description comes back in full`,
  computeAccessibleDescription(el(`<textarea id="q" aria-describedby="help"></textarea><p id="help">${longHelp}</p>`, '#q')), longHelp);

console.log('\n== stable selectors are unique ==');
{
  const doc = parseHTML(`<!doctype html><html><body>
    <fieldset id="work"><input type="radio" name="remote" value="yes" /><input type="radio" name="remote" value="no" /></fieldset>
    <div id="a"><input name="school" /></div><div id="b"><input name="school" /></div>
    <span id="dup">One</span><span id="dup">Two</span></body></html>`).document;
  const unique = (selector: string) => doc.querySelectorAll(selector).length === 1;
  const [yes, no] = [...doc.querySelectorAll('input[name="remote"]')];
  const radios = [stableSelector(yes), stableSelector(no)];
  check('radios sharing a name are told apart by their value', radios.every(unique) && radios[0] !== radios[1], true);
  check('  without a stamp', radios.some((s) => s.startsWith('[data-tw-ref=')), false);
  const [s1, s2] = [...doc.querySelectorAll('input[name="school"]')].map(stableSelector);
  check('look-alike inputs are scoped under a uniquely identified ancestor', [s1, s2].every(unique) && s1 !== s2, true);
  const dupes = [...doc.querySelectorAll('span')].map(stableSelector);
  check('elements sharing an id are never given that id', dupes.every(unique) && !dupes.includes('#dup'), true);
}

console.log('\n== selectors that keep working ==');
{
  const doc = parseHTML(`<!doctype html><html><body>
    <div id="a"><input name="school" value="MIT" /></div><div id="b"><input name="school" value="" /></div>
    <section id="phone-field"><input /></section></body></html>`).document;
  const [typed] = [...doc.querySelectorAll('input[name="school"]')].map(stableSelector);
  check('a text field is never told apart by its value attribute, which changes as the user types', typed.includes('value='), false);
  check('  it is scoped under its uniquely identified wrapper instead', typed, '#a input[name="school"]');
  const bare = stableSelector(doc.querySelector('#phone-field input')!);
  check('a field with no attributes is scoped by its tag under a unique wrapper, not stamped', bare, '#phone-field input');
}

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
