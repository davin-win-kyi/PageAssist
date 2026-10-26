/*
The following file runs PageAssist end to end on the three live pages used for the pilot studies
- a tutorial with nothing to fill (TechnicalWall's Canva business card guide), and two job
  applications (Kargo on Greenhouse, Creatify on Ashby)
- for each page, several interfaces are shaped through the real chat, generated, and applied with
  the built extension, then checked against the page: live completion on the job applications,
  and checking items off by hand on the tutorial
- a saved interface is transferred to the other pages, and on Kargo, answering the Hispanic/Latino
  question must add the race question to the interface that's showing

Note: it does the side panel's part itself, calling the same backend routes in the same order.
It needs the extension built, a model in backend/.env, and network access. It never submits a form.
  npm --prefix plugin run build
  node tests/e2e/live_sites.mjs [--out <dir>] [--sites canva,kargo,creatify] [--interfaces checklist,next-step]
*/

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const EXTENSION = path.join(ROOT, 'plugin/.output/chrome-mv3');
const PYTHON = path.join(ROOT, 'backend/.venv/bin/python');

/*************************************************************************************************
The pages and the interfaces
*************************************************************************************************/

/*
The pages tested. A tutorial has nothing to fill, so its items are checked off by hand; a job
application's items check off by themselves as its questions are answered.
*/
const SITES = {
  canva: {
    title: 'TechnicalWall: How to make a business card in Canva',
    kind: 'tutorial',
    url: 'https://technicalwall.com/canva/how-to-make-a-business-card-in-canva/?utm_source=chatgpt.com',
    port: 8101,
    view: 'h3:has-text("Step 1")',
  },
  kargo: {
    title: 'Kargo: Network Security Engineer (Greenhouse)',
    kind: 'form',
    url: 'https://job-boards.greenhouse.io/kargo/jobs/6100170004',
    port: 8102,
    view: '#first_name',
    fills: [['#first_name', 'Test'], ['#last_name', 'User'], ['#email', 'test.user@example.com']],
  },
  creatify: {
    title: 'Creatify: AI Research Engineer (Ashby)',
    kind: 'form',
    url: 'https://jobs.ashbyhq.com/creatify/2ebe3f70-171c-4b4e-b1aa-220133dcb202/application?utm_source=zOjYWorEWl',
    port: 8103,
    view: '#_systemfield_name',
    fills: [['#_systemfield_name', 'Test User'], ['#_systemfield_email', 'test.user@example.com']],
  },
};
const TRANSFER_PORT = 8104;

/*
The interfaces each page is tested with, described to the chat the way a user would. `pick` is
how the user then chooses it from the options the chat offers.
*/
const INTERFACES = {
  'checklist': {
    title: 'Checklist',
    pick: 'the checklist',
    ask: {
      form: "I keep losing track of which questions I've already answered on this application. I'd like a checklist of every question that ticks off as I answer.",
      tutorial: "I keep losing my place in this tutorial's steps. I'd like a checklist of the steps that I can tick off as I go.",
    },
  },
  'next-step': {
    title: 'Next-step prompt',
    pick: 'the next-step prompt',
    ask: {
      form: "Seeing the whole application at once overwhelms me. I'd like a prompt that only shows me the next question to answer.",
      tutorial: "Seeing the whole tutorial at once overwhelms me. I'd like a prompt that only shows me the one next step to do.",
    },
  },
  'progress': {
    title: 'Progress tracker',
    pick: 'the progress tracker',
    ask: {
      form: "I can't tell how far along I am in this application. I'd like a progress tracker showing how much is done and what's left.",
      tutorial: "I can't tell how far along I am in this tutorial. I'd like a progress tracker showing how many steps are done and how many are left.",
    },
  },
  'sections': {
    title: 'Section overview',
    pick: 'the section overview',
    ask: {
      form: "This application is long and I lose track of its parts. I'd like an overview of its sections, showing how much of each one is done.",
      tutorial: "This tutorial is long and I lose track of its parts. I'd like an overview of its sections, showing the steps in each one.",
    },
  },
  'walkthrough': {
    title: 'Detailed walkthrough',
    pick: 'the detailed walkthrough',
    ask: {
      form: "I'm never sure what each question wants. I'd like a walkthrough that shows each question with the page's own help text for it.",
      tutorial: "The instructions are hard to follow on the page. I'd like a step-by-step walkthrough that shows each step's full instructions.",
    },
  },
};

// The panel's opening message, which the chat sees as the first turn
const INTRO = 'I can help create interface support for this webpage. Describe something that’s difficult about the current task, or describe a support you already have in mind — I may ask you to confirm how I’ve understood it.';

/*************************************************************************************************
Checks and options
*************************************************************************************************/

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = path.resolve(option('out', path.join(os.tmpdir(), `pageassist-e2e-${Date.now()}`)));
const SITE_KEYS = option('sites', Object.keys(SITES).join(',')).split(',');
const INTERFACE_KEYS = option('interfaces', Object.keys(INTERFACES).join(',')).split(',');
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${ok || !detail ? '' : `  ${detail}`}`);
}
const log = (...parts) => console.log(...parts);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const treeHasContent = (tree) => !!tree && (!!tree.component?.trim() || !!tree.description?.trim()
  || (Array.isArray(tree.preferences) ? tree.preferences.length : Object.keys(tree.preferences || {}).length) > 0
  || (tree.children?.length ?? 0) > 0);

/*************************************************************************************************
Backend
*************************************************************************************************/

/*
Starts a backend on its own port with a throwaway data directory, so backend/data is never touched
*/
const dataDirs = {};
async function startBackend(port, name) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pageassist-e2e-${name}-`));
  dataDirs[name] = dataDir;
  const logFile = fs.openSync(path.join(OUT, `backend-${name}.log`), 'w');
  const child = spawn(PYTHON, ['-m', 'uvicorn', 'main:app', '--port', String(port)], {
    cwd: path.join(ROOT, 'backend'),
    env: { ...process.env, PAGEASSIST_DATA_DIR: dataDir },
    stdio: ['ignore', logFile, logFile],
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child;
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error(`the backend on port ${port} did not start; see backend-${name}.log`);
}

// Stops a backend, forcing it when it's stuck on a call, since a stuck one never finishes shutting down
async function stopBackend(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  if (await Promise.race([exited.then(() => true), wait(5000).then(() => false)])) return;
  child.kill('SIGKILL');
  await exited;
}

// One backend call, throwing the backend's own message when it fails
async function api(port, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(300_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || `${method} ${route} returned ${response.status}`);
  return data;
}

// The panel's site id: host, path and query, with slashes swapped for "~"
function siteIdFor(url) {
  const u = new URL(url);
  return `${u.hostname}${u.pathname}${u.search}`.replace(/\/$/, '').replace(/\//g, '~');
}

/*************************************************************************************************
Browser
*************************************************************************************************/

// The Chrome to run: CHROME_PATH, else Playwright's own, else any Chromium in Playwright's cache
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const own = chromium.executablePath();
    if (fs.existsSync(own)) return own;
  } catch { /* none installed for this version */ }
  const caches = [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')];
  const builds = caches.filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => fs.readdirSync(dir).filter((name) => /^chromium-\d+$/.test(name)).map((name) => path.join(dir, name)))
    .sort().reverse();
  for (const build of builds) {
    for (const exe of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
      if (fs.existsSync(path.join(build, exe))) return path.join(build, exe);
    }
  }
  throw new Error('no Chrome found: set CHROME_PATH, or run `npx playwright install chromium`');
}

/*
Opens a page in its own browser with the extension loaded, and keeps the page-change events the
content script posts to the page
*/
async function openSite(key) {
  const site = { key, ...SITES[key], console: [], results: { key, title: SITES[key].title, kind: SITES[key].kind, url: SITES[key].url, interfaces: [] } };
  site.context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'pageassist-e2e-browser-')), {
    executablePath: chromePath(),
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  site.worker = site.context.serviceWorkers()[0] ?? await site.context.waitForEvent('serviceworker');
  site.page = site.context.pages()[0] ?? await site.context.newPage();
  site.page.on('console', (message) => { if (message.type() === 'error') site.console.push(message.text()); });
  const started = Date.now();
  await site.page.goto(site.url, { waitUntil: 'load', timeout: 90_000 }).catch(() => {});
  await site.page.waitForFunction(() => document.documentElement.dataset.pageassistPlugin === 'connected', null, { timeout: 30_000 });
  await wait(3000);
  site.results.loadMs = Date.now() - started;
  await site.page.evaluate(() => {
    // the content script's lookup: the page first, then shadow roots and same-origin iframes
    window.__paFind = (selector, root = document) => {
      let found = null;
      try { found = root.querySelector(selector); } catch { return null; }
      if (found) return found;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && (found = window.__paFind(selector, el.shadowRoot))) return found;
        if (el.tagName === 'IFRAME' && !el.hasAttribute('data-pageassist-interface')) {
          let doc = null;
          try { doc = el.contentDocument; } catch { /* cross-origin */ }
          if (doc && (found = window.__paFind(selector, doc))) return found;
        }
      }
      return null;
    };
    window.__paEvents = [];
    window.addEventListener('message', (event) => {
      if (event.data?.source === 'pageassist-plugin' && event.data.type === 'PAGE_CHANGED') window.__paEvents.push(event.data.event);
    });
  });
  // a message from the panel to this page's content script
  site.send = (message) => site.worker.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ active: true });
    return chrome.tabs.sendMessage(tab.id, m);
  }, message);
  return site;
}

/*
Scans the page through the content script and analyzes it into a task representation
*/
async function analyze(site, port) {
  const scanStarted = Date.now();
  const scan = await site.send({ type: 'GET_PAGE_ELEMENTS' });
  const scanMs = Date.now() - scanStarted;
  const siteId = siteIdFor(scan.url);
  const started = Date.now();
  const task = await api(port, 'POST', `/task-representations/${encodeURIComponent(siteId)}/analyze`, { ...scan, page_text: scan.pageText ?? '' });
  const ms = Date.now() - started;
  // the page's questions: visible controls with a name, since an unnamed one can't be a question
  const controls = scan.elements.filter((e) => e.visible && (e.accessibleName || '').trim()
    && (['input', 'textarea', 'select'].includes(e.tag) || ['textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'spinbutton', 'switch'].includes(e.role)));
  // a control is covered when a component's element is it or holds it
  const uncovered = await site.page.evaluate(({ controls, selectors }) => {
    const find = (s) => window.__paFind(s);
    const owners = selectors.map(find).filter(Boolean);
    return controls.filter((c) => { const el = find(c.selector); return !el || !owners.some((o) => o === el || o.contains(el)); }).map((c) => `${c.accessibleName || c.text || c.tag} (${c.selector})`);
  }, { controls: controls.map((e) => ({ selector: e.selector, accessibleName: e.accessibleName, text: e.text, tag: e.tag })), selectors: task.components.flatMap((c) => [c.dom_selector, ...(c.member_selectors ?? [])]) });
  const byType = {};
  for (const c of task.components) byType[c.component_type] = (byType[c.component_type] ?? 0) + 1;
  return {
    siteId,
    task,
    metrics: {
      scanMs, ms, elements: scan.elements.length, containers: scan.containers?.length ?? 0, pageText: scan.pageText?.length ?? 0,
      visibleControls: controls.length, coveredControls: controls.length - uncovered.length, uncovered,
      tasks: task.tasks.length, components: task.components.length, byType,
      described: task.components.filter((c) => (c.description || '').trim()).length,
    },
  };
}

/*************************************************************************************************
The side panel's part
*************************************************************************************************/

/*
Shapes an interface through the chat: the user describes the difficulty and the support, confirms
the chat's understanding, then picks the support from the options, until the chat agrees
*/
async function shapeInterface(port, spec, kind, { startOver = true } = {}) {
  // starting over begins a new chat, and a new session in the records
  if (startOver) await api(port, 'POST', '/interface-representation/reset');
  const history = [{ role: 'assistant', content: INTRO }];
  const turns = [];
  let message = spec.ask[kind];
  let result = null;
  for (let turn = 1; turn <= 6; turn += 1) {
    const started = Date.now();
    result = await api(port, 'POST', '/chat', { message, history });
    turns.push({ user: message, reply: result.reply, ms: Date.now() - started, agreed: result.agreed });
    history.push({ role: 'user', content: message }, { role: 'assistant', content: result.reply });
    if (result.agreed && treeHasContent(result.interface_representation)) break;
    const offers = /\b1[.)]|\boptions?\b|\bwhich\b|\beither\b|\bor\b.*\?/i.test(result.reply) || result.reply.toLowerCase().includes(spec.pick.replace('the ', ''));
    message = turn === 1 && !offers ? "Yes, that's right." : `Let's go with ${spec.pick}.`;
  }
  const agreed = !!result?.agreed && treeHasContent(result?.interface_representation);
  return { agreed, tree: result?.interface_representation ?? null, turns };
}

// The widget's sandbox frame on the page
const sandboxFrame = (page) => page.frames().find((frame) => frame.url().startsWith('chrome-extension://') && frame.url().endsWith('sandbox.html'));

/*
Applies a widget to the page and waits until a fresh sandbox has drawn it. The states the page
pushes into the widget afterwards are kept, to read its live completion.
*/
async function applyWidget(site, widget) {
  const started = Date.now();
  await site.send({ type: 'APPLY_WEBPAGE_INTERFACE', tree: widget });
  let frame = null;
  for (let i = 0; i < 80; i += 1) {
    frame = sandboxFrame(site.page);
    const drawn = frame && await frame.evaluate(() => !window.__paSeen && document.body.innerText.trim().length > 0).catch(() => false);
    if (drawn) break;
    frame = null;
    await wait(250);
  }
  if (!frame) return { ok: false, ms: Date.now() - started, error: 'the widget never drew' };
  await frame.evaluate(() => {
    window.__paSeen = true;
    window.__paStates = [];
    window.addEventListener('message', (event) => { if (event.data?.type === 'state') window.__paStates.push(event.data.state); });
  });
  const text = await frame.evaluate(() => document.body.innerText);
  return { ok: !/^Widget error/.test(text.trim()), ms: Date.now() - started, error: /^Widget error/.test(text.trim()) ? text.trim().slice(0, 200) : '' };
}

const widgetText = async (site) => (await sandboxFrame(site.page)?.evaluate(() => document.body.innerText).catch(() => '')) ?? '';
const lastState = async (site) => (await sandboxFrame(site.page)?.evaluate(() => window.__paStates?.at(-1) ?? null).catch(() => null)) ?? null;
const itemSelectors = (item) => (Array.isArray(item.selectors) && item.selectors.length ? item.selectors : item.selector ? [item.selector] : []);

/*
What a widget's items are: grounded on the page or manual, with detail or a section, and whether
every grounded selector is on the page and none is an action like a submit button
*/
async function describeItems(site, items) {
  const grounded = items.filter((item) => itemSelectors(item).length > 0);
  const found = await site.page.evaluate((lists) => lists.map((selectors) => selectors.map((selector) => {
    const el = window.__paFind(selector);
    if (!el) return 'missing';
    const action = el.matches('a[href], button, [role="button"], input[type="submit" i], input[type="button" i]')
      && !el.matches('[aria-pressed], [aria-checked], [aria-selected], [aria-haspopup="listbox"]');
    return action ? 'action' : 'ok';
  })), grounded.map(itemSelectors));
  return {
    total: items.length,
    grounded: grounded.length,
    manual: items.filter((item) => item.manual === true).length,
    withDetail: items.filter((item) => typeof item.detail === 'string' && item.detail.trim()).length,
    withSection: items.filter((item) => typeof item.section === 'string' && item.section.trim()).length,
    missingSelectors: found.flat().filter((state) => state === 'missing').length,
    onActions: found.filter((states) => states.every((state) => state === 'action')).length,
  };
}

/*
Follows a page change the way the panel does: patch the task representation, then splice the
added and removed questions into the widget, or generate the widget again when that can't be done
*/
async function followPageChange(site, port, siteId, event, recordId) {
  const started = Date.now();
  const body = { added: event.addedFields ?? [], removed: event.removedFields ?? [], revealed: event.revealedFields ?? [], containers: event.addedContainers ?? [] };
  let patch = null;
  let error = '';
  try { patch = await api(port, 'POST', `/task-representations/${encodeURIComponent(siteId)}/patch`, body); } catch (e) { error = e.message; }
  const patchMs = Date.now() - started;
  const noRealChange = patch?.changed === false;
  const addedItems = noRealChange ? [] : (patch?.added_items ?? []);
  const spliced = addedItems.length || body.removed.length ? await site.send({ type: 'UPDATE_WIDGET_ITEMS', add: addedItems, remove: body.removed }) : undefined;
  let outcome = 'no change';
  if (spliced?.ok && spliced.added + spliced.removed > 0) outcome = 'spliced';
  else if (error) outcome = `failed: ${error}`;
  else if (!noRealChange && !spliced?.ok) {
    const widget = await api(port, 'POST', `/webpage-interfaces/${encodeURIComponent(siteId)}/generate?reason=page-change`);
    await applyWidget(site, widget);
    await fileScreenshot(site, port, widget.record_id, 'applied');
    outcome = 'regenerated';
  }
  // what the panel files in the records about the change
  const counts = { fields_added: body.added.length + body.revealed.flat().length, fields_removed: body.removed.length };
  if (outcome === 'spliced') {
    await fileScreenshot(site, port, recordId, 'updated');
    await recordEvent(port, 'page change', { outcome: 'spliced', ...counts, items_added: spliced.added, items_removed: spliced.removed });
  } else if (error) {
    await recordError(port, 'page change', error);
  } else {
    await recordEvent(port, 'page change', { outcome: outcome === 'regenerated' ? 'rebuilt the interface' : 'no change to the interface', ...counts });
  }
  return { patchMs, totalMs: Date.now() - started, changed: patch?.changed, addedItems: addedItems.length, removed: body.removed.length, spliced, outcome };
}

// The page-change events posted since the last call, with any structural one followed like the panel
async function drainPageChanges(site, port, siteId, recordId) {
  const events = await site.page.evaluate(() => window.__paEvents.splice(0));
  const followed = [];
  for (const event of events.filter((e) => e.structural)) followed.push({ event: summarizeEvent(event), ...(await followPageChange(site, port, siteId, event, recordId)) });
  return { events: events.length, structural: followed };
}
const summarizeEvent = (event) => ({
  fieldsAdded: event.fieldsAdded, fieldsRemoved: event.fieldsRemoved,
  added: (event.addedFields ?? []).map((e) => e.accessibleName || e.selector),
  revealed: (event.revealedFields ?? []).flat().map((e) => e.accessibleName || e.selector),
  removed: event.removedFields ?? [],
});

/*************************************************************************************************
Screenshots
*************************************************************************************************/

// Waits until the widget's frame has stopped resizing, so a screenshot shows it at its real size
async function settleFrame(site) {
  let last = -1;
  for (let i = 0; i < 20; i += 1) {
    const height = await site.page.evaluate(() => document.querySelector('iframe[data-pageassist-interface]')?.getBoundingClientRect().height ?? 0);
    if (height > 0 && height === last) return;
    last = height;
    await wait(150);
  }
}

async function shoot(site, name, { widgetOnly = false } = {}) {
  const file = `shots/${site.key}-${name}.jpg`;
  await settleFrame(site);
  try {
    if (widgetOnly) await site.page.locator('iframe[data-pageassist-interface]').screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 85 });
    else await site.page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 72 });
    return file;
  } catch {
    return null;
  }
}

// Scrolls the widget so the item whose text matches is in view, for a screenshot of it
async function showInWidget(site, pattern) {
  await sandboxFrame(site.page)?.evaluate((source) => {
    const re = new RegExp(source, 'i');
    const hit = [...document.querySelectorAll('body *')].reverse().find((el) => el.children.length === 0 && re.test(el.textContent || ''));
    hit?.scrollIntoView({ block: 'center' });
  }, pattern.source).catch(() => {});
  await wait(300);
}

// Files a PNG of just the widget with its interface in the records, as the side panel does
async function fileScreenshot(site, port, recordId, reason) {
  if (!recordId) return;
  await settleFrame(site);
  const png = await site.page.locator('iframe[data-pageassist-interface]').screenshot({ type: 'png' }).catch(() => null);
  if (png) await api(port, 'POST', '/records/screenshots', { record_id: recordId, reason, image: `data:image/png;base64,${png.toString('base64')}` }).catch(() => {});
}

// The rest of what the side panel files in the records
const recordEvent = (port, kind, details) => api(port, 'POST', '/records/events', { kind, details }).catch(() => {});
const recordError = (port, where, message) => api(port, 'POST', '/records/errors', { source: 'panel', where, message }).catch(() => {});

async function scrollTo(site, selector) {
  await site.page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await site.page.evaluate(() => window.scrollBy(0, -120));
  await wait(400);
}

/*************************************************************************************************
Testing one page
*************************************************************************************************/

/*
After the user fills some questions, a grounded item should be complete exactly when every
question it tracks was filled. Returns how many items the widget got right.
*/
async function completionAccuracy(site, items, filled) {
  const expected = await site.page.evaluate(({ lists, filledSelectors }) => {
    const ANSWERABLE = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea, [role="combobox"], [role="checkbox"], [role="radio"], [role="textbox"], [contenteditable="true"]';
    const filledEls = filledSelectors.map((s) => window.__paFind(s)).filter(Boolean);
    return lists.map((selectors) => {
      const els = selectors.map((s) => window.__paFind(s)).filter(Boolean);
      const questions = els.filter((el) => el.matches(ANSWERABLE) || el.querySelector(ANSWERABLE));
      if (questions.length === 0) return null;
      return questions.every((el) => filledEls.some((f) => f === el || el.contains(f)));
    });
  }, { lists: items.map(itemSelectors), filledSelectors: filled });
  let right = 0;
  let judged = 0;
  const wrong = [];
  items.forEach((item, i) => {
    if (expected[i] === null || itemSelectors(item).length === 0) return;
    judged += 1;
    if ((item.complete === true) === expected[i]) right += 1;
    else wrong.push(`${item.label} (expected ${expected[i] ? 'complete' : 'incomplete'})`);
  });
  return { right, judged, wrong };
}

/*
Checks an item off by hand inside the widget, the way a tutorial's checklist is used. A real
checkbox or button is tried first; else the item itself is clicked. `accessible` says whether the
control works with a keyboard and a screen reader.
*/
async function checkOffByHand(site, firstLabel) {
  const frame = sandboxFrame(site.page);
  if (!frame) return { ok: false, accessible: false, how: 'no widget' };
  const before = await frame.evaluate(() => document.body.innerHTML);
  const box = frame.locator('input[type="checkbox"], [role="checkbox"], [role="switch"]').first();
  const button = frame.locator('button, [role="button"]').filter({ hasText: /done|complete|mark|next|check/i }).first();
  let how = '';
  let accessible = false;
  if (await box.count()) {
    accessible = await box.evaluate((el) => el.matches('input') || (el.tabIndex >= 0 && el.hasAttribute('aria-checked')));
    await box.click({ timeout: 3000 }).catch(() => {});
    how = 'clicked its checkbox';
  } else if (await button.count()) {
    accessible = await button.evaluate((el) => el.matches('button') || el.tabIndex >= 0);
    await button.click({ timeout: 3000 }).catch(() => {});
    how = `clicked "${(await button.innerText()).trim().slice(0, 30)}"`;
  } else if (firstLabel) {
    const item = frame.getByText(firstLabel, { exact: false }).first();
    if (await item.count()) {
      await item.click({ timeout: 3000 }).catch(() => {});
      how = 'clicked the item itself; it has no checkbox or button';
    }
  }
  await wait(400);
  const after = await frame.evaluate(() => document.body.innerHTML);
  return { ok: !!how && before !== after, accessible, how: how || 'found nothing to check off' };
}

async function testInterface(site, port, siteId, key, startOver) {
  const spec = INTERFACES[key];
  const result = { key, title: spec.title };
  log(`\n== ${site.key}: ${spec.title} ==`);
  try {
    const shaped = await shapeInterface(port, spec, site.kind, { startOver });
    result.chat = { agreed: shaped.agreed, turns: shaped.turns.length, ms: shaped.turns.map((t) => t.ms), transcript: shaped.turns };
    result.tree = shaped.tree;
    check(`${site.key} ${key}: the chat settles on the interface within 6 turns`, shaped.agreed, `${shaped.turns.length} turns, last reply: ${shaped.turns.at(-1)?.reply}`);
    if (!shaped.agreed) return result;

    const started = Date.now();
    const widget = await api(port, 'POST', `/webpage-interfaces/${encodeURIComponent(siteId)}/generate?reason=chat`);
    result.generate = { ms: Date.now() - started, degraded: widget.degraded === true, codeChars: (widget.code || '').length };
    check(`${site.key} ${key}: the widget is generated`, !widget.degraded, widget.state?.error);
    result.items = await describeItems(site, widget.state?.items ?? []);
    check(`${site.key} ${key}: every grounded item is on the page`, result.items.missingSelectors === 0, `${result.items.missingSelectors} missing`);
    check(`${site.key} ${key}: no item is grounded on an action`, result.items.onActions === 0, `${result.items.onActions} on actions`);
    if (site.kind === 'tutorial') check(`${site.key} ${key}: a tutorial's items are checked off by hand, not by the page`, result.items.grounded === 0 && result.items.total > 0, JSON.stringify(result.items));
    else check(`${site.key} ${key}: a job application's items are tracked from the page`, result.items.grounded > 0, JSON.stringify(result.items));

    if (site.view) await scrollTo(site, site.view);
    const applied = await applyWidget(site, widget);
    result.apply = applied;
    check(`${site.key} ${key}: the widget draws on the page without errors`, applied.ok, applied.error);
    result.shots = { page: await shoot(site, key), widget: await shoot(site, `${key}-widget`, { widgetOnly: true }) };
    await fileScreenshot(site, port, widget.record_id, 'applied');

    if (site.kind === 'form') {
      const before = await widgetText(site);
      for (const [selector, value] of site.fills) {
        await site.page.fill(selector, value).catch(() => {});
        await wait(700);
      }
      await wait(800);
      const state = await lastState(site);
      const accuracy = await completionAccuracy(site, state?.items ?? widget.state?.items ?? [], site.fills.map(([selector]) => selector));
      result.completion = { ...accuracy, widgetChanged: before !== (await widgetText(site)) };
      check(`${site.key} ${key}: answering questions checks off exactly the answered items`, accuracy.judged > 0 && accuracy.right === accuracy.judged, accuracy.wrong.join('; '));
      check(`${site.key} ${key}: the widget shows the answers as they happen`, result.completion.widgetChanged);
      result.shots.after = await shoot(site, `${key}-after`, { widgetOnly: true });
      await fileScreenshot(site, port, widget.record_id, 'updated');
      // clear the answers so the next interface starts on an untouched form
      for (const [selector] of site.fills) await site.page.fill(selector, '').catch(() => {});
      await wait(600);
    } else {
      const firstManual = (widget.state?.items ?? []).find((item) => item.manual)?.label;
      result.manual = await checkOffByHand(site, firstManual);
      check(`${site.key} ${key}: an item can be checked off by hand in the widget`, result.manual.ok, result.manual.how);
      check(`${site.key} ${key}: checking an item off works with a keyboard and a screen reader`, result.manual.accessible, result.manual.how);
      result.shots.after = await shoot(site, `${key}-after`, { widgetOnly: true });
    }
    result.pageChanges = await drainPageChanges(site, port, siteId, widget.record_id);
    result.widget = widget;
  } catch (error) {
    result.error = error.message;
    check(`${site.key} ${key}: runs without errors`, false, error.message);
  }
  return result;
}

/*
Kargo: answering "Are you Hispanic/Latino?" adds the race question to the page, and the interface
that's showing has to pick it up
*/
async function testActiveChange(site, port, siteId, checklist) {
  log('\n== kargo: answering Hispanic/Latino adds the race question ==');
  const result = {};
  await applyWidget(site, checklist);
  await scrollTo(site, '#hispanic_ethnicity');
  await showInWidget(site, /hispanic|latino/i);
  result.shots = { before: await shoot(site, 'active-before'), widgetBefore: await shoot(site, 'active-before-widget', { widgetOnly: true }) };
  result.itemsBefore = (await lastState(site))?.items?.length ?? checklist.state.items.length;
  await site.page.evaluate(() => window.__paEvents.splice(0));

  const answered = Date.now();
  await site.page.locator('#hispanic_ethnicity').click();
  await site.page.locator('.select__option, [role="option"]').filter({ hasText: /^No$/ }).first().click();
  let event = null;
  for (let i = 0; i < 60 && !event; i += 1) {
    await wait(250);
    event = await site.page.evaluate(() => window.__paEvents.find((e) => e.structural) ?? null);
  }
  result.detectedMs = Date.now() - answered;
  const raceField = event && [...(event.addedFields ?? []), ...(event.revealedFields ?? []).flat()].find((e) => /race/i.test(`${e.accessibleName} ${e.selector} ${e.text}`));
  check('kargo: the race question appearing is noticed as a page change', !!raceField, event ? JSON.stringify(summarizeEvent(event)) : 'no structural change seen');
  if (!event) return result;
  await site.page.evaluate(() => window.__paEvents.splice(0));
  result.event = summarizeEvent(event);
  result.follow = await followPageChange(site, port, siteId, event, checklist.record_id);
  await wait(1200);
  result.totalMs = Date.now() - answered;

  const state = await lastState(site);
  const items = state?.items ?? [];
  result.itemsAfter = items.length;
  const raceItem = items.find((item) => (raceField && itemSelectors(item).includes(raceField.selector)) || /race/i.test(item.label || ''));
  result.raceItem = raceItem ? { label: raceItem.label, complete: raceItem.complete ?? null, required: raceItem.required ?? null } : null;
  const text = await widgetText(site);
  check('kargo: the interface now includes the race question', !!raceItem && /race/i.test(text), `follow: ${JSON.stringify(result.follow)}`);
  const hispanicItem = items.find((item) => itemSelectors(item).some((s) => s.includes('hispanic')) || /hispanic|latino/i.test(item.label || ''));
  result.hispanicComplete = hispanicItem?.complete ?? null;
  check('kargo: the answered Hispanic/Latino question shows as done', !hispanicItem || hispanicItem.complete === true, JSON.stringify(hispanicItem));
  if (raceField) await scrollTo(site, raceField.selector);
  await showInWidget(site, /race/i);
  result.shots.after = await shoot(site, 'active-after');
  result.shots.widgetAfter = await shoot(site, 'active-after-widget', { widgetOnly: true });
  return result;
}

async function testSite(site) {
  log(`\n######## ${site.title} ########`);
  const port = site.port;
  // opening the side panel starts a new chat and analyzes the page, so both are in its first session
  await api(port, 'POST', '/interface-representation/reset');
  const analysis = await analyze(site, port);
  site.results.analysis = { ...analysis.metrics, tasks: analysis.task.tasks, components: analysis.task.components };
  site.results.analysisMetrics = analysis.metrics;
  log(`analyzed: ${analysis.metrics.components} components in ${(analysis.metrics.ms / 1000).toFixed(1)}s`);
  check(`${site.key}: the page is analyzed into components`, analysis.metrics.components > 0);
  if (site.kind === 'form') {
    const coverage = analysis.metrics.coveredControls / Math.max(1, analysis.metrics.visibleControls);
    check(`${site.key}: every visible question is in the task representation`, coverage === 1, `${analysis.metrics.coveredControls}/${analysis.metrics.visibleControls}; missing ${analysis.metrics.uncovered.join(', ')}`);
  }
  await site.page.evaluate(() => window.__paEvents.splice(0));
  for (const key of INTERFACE_KEYS) site.results.interfaces.push(await testInterface(site, port, analysis.siteId, key, site.results.interfaces.length > 0));
  if (site.key === 'kargo') {
    const checklist = site.results.interfaces.find((i) => i.key === 'checklist')?.widget;
    if (checklist) site.results.activeChange = await testActiveChange(site, port, analysis.siteId, checklist);
  }
  site.results.consoleErrors = site.console.filter((text) => /PageAssist/.test(text));
}

/*************************************************************************************************
Transferring a saved interface between pages
*************************************************************************************************/

/*
Shapes an interface on one page, saves it, then activates it on other pages: the same saved
preferences become a widget grounded in each page, tracked from a job application's questions and
checked off by hand on a tutorial
*/
async function testTransfer(sites, from, interfaceKey, targets) {
  log(`\n######## transfer: ${INTERFACES[interfaceKey].title} from ${from} to ${targets.join(', ')} ########`);
  const port = TRANSFER_PORT;
  const runs = [];
  const source = sites[from];
  const sourceAnalysis = await analyze(source, port);
  const shaped = await shapeInterface(port, INTERFACES[interfaceKey], source.kind);
  check(`transfer: the ${interfaceKey} is shaped on ${from}`, shaped.agreed);
  if (!shaped.agreed) return { from, interfaceKey, error: 'the chat never settled' };
  const saved = await api(port, 'POST', '/interface-representations', { name: `${INTERFACES[interfaceKey].title} from ${from}` });
  for (const key of [from, ...targets]) {
    const site = sites[key];
    const run = { site: key, kind: site.kind };
    try {
      const analysis = key === from ? sourceAnalysis : await analyze(site, port);
      if (key !== from) await api(port, 'POST', `/interface-representations/${saved.id}/activate`);
      const started = Date.now();
      const widget = await api(port, 'POST', `/webpage-interfaces/${encodeURIComponent(analysis.siteId)}/generate?reason=${key === from ? 'chat' : 'saved'}`);
      run.generateMs = Date.now() - started;
      run.degraded = widget.degraded === true;
      run.items = await describeItems(site, widget.state?.items ?? []);
      if (site.view) await scrollTo(site, site.view);
      run.apply = await applyWidget(site, widget);
      run.shot = await shoot(site, `transfer-${interfaceKey}-from-${from}`);
      run.widgetShot = await shoot(site, `transfer-${interfaceKey}-from-${from}-widget`, { widgetOnly: true });
      const tracked = site.kind === 'form' ? run.items.grounded > 0 : run.items.grounded === 0 && run.items.manual > 0;
      check(`transfer: the ${interfaceKey} from ${from} works on ${key}${key === from ? ' (where it was made)' : ''}`, !run.degraded && run.apply.ok && tracked, JSON.stringify(run.items));
    } catch (error) {
      run.error = error.message;
      check(`transfer: the ${interfaceKey} from ${from} works on ${key}`, false, error.message);
    }
    runs.push(run);
  }
  return { from, interfaceKey, tree: shaped.tree, saved: saved.name, runs };
}

/*************************************************************************************************
The study records each backend kept
*************************************************************************************************/

/*
Every chat turn, task representation, interface representation version and built interface of a
page's run must be in its backend's records, each interface with its code and screenshots
*/
function checkRecords(site) {
  const root = path.join(dataDirs[site.key], 'user_study');
  const sessions = fs.existsSync(root) ? fs.readdirSync(root).map((name) => path.join(root, name)) : [];
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const turns = sessions.reduce((n, dir) => n + read(path.join(dir, 'conversation.jsonl')).split('\n').filter(Boolean).length, 0);
  const versions = sessions.reduce((n, dir) => n + (fs.existsSync(path.join(dir, 'interface_representations')) ? fs.readdirSync(path.join(dir, 'interface_representations')).length : 0), 0);
  const tasks = sessions.reduce((n, dir) => n + (fs.existsSync(path.join(dir, 'task_representations')) ? fs.readdirSync(path.join(dir, 'task_representations')).length : 0), 0);
  const interfaces = sessions.flatMap((dir) => (fs.existsSync(path.join(dir, 'interfaces')) ? fs.readdirSync(path.join(dir, 'interfaces')).map((name) => path.join(dir, 'interfaces', name)) : []));
  const chatTurns = site.results.interfaces.reduce((n, i) => n + (i.chat?.turns ?? 0), 0);
  const built = site.results.interfaces.filter((i) => i.generate).length;
  const summaries = sessions.map((dir) => JSON.parse(read(path.join(dir, 'summary.json')) || '{}'));
  site.results.records = { folder: root, sessions: sessions.length, turns, versions, tasks, interfaces: interfaces.length };
  check(`${site.key}: every chat turn is in the records`, turns === chatTurns, `${turns} recorded, ${chatTurns} taken`);
  const builtFrom = ['code.js', 'interface_representation.json', 'task_representation.json'];
  check(`${site.key}: every interface is in the records with its code, what it was built from, and a screenshot`,
    interfaces.length >= built && interfaces.every((dir) => builtFrom.every((name) => fs.existsSync(path.join(dir, name))))
      && interfaces.filter((dir) => fs.readdirSync(dir).some((name) => name.startsWith('screenshot-'))).length >= built,
    `${interfaces.length} recorded, ${built} built`);
  check(`${site.key}: each interface records the iterations that led to it`,
    interfaces.every((dir) => typeof JSON.parse(read(path.join(dir, 'meta.json'))).iterations?.chat_turns === 'number'));
  check(`${site.key}: the task representations and interface representation versions are in the records`, tasks >= 1 && versions >= built, `${tasks} task, ${versions} interface`);
  check(`${site.key}: each session's summary counts the turns it took to agree`, summaries.some((s) => typeof s.turns_to_agreement === 'number'));
  const followed = site.results.interfaces.reduce((n, i) => n + (i.pageChanges?.structural?.length ?? 0), 0) + (site.results.activeChange?.follow ? 1 : 0);
  const pageChanges = sessions.reduce((n, dir) => n + ['events.jsonl', 'errors.jsonl']
    .reduce((m, name) => m + read(path.join(dir, name)).split('\n').filter((line) => line.includes('"page change"')).length, 0), 0);
  check(`${site.key}: every page change the interface followed is in the records`, pageChanges === followed, `${pageChanges} recorded, ${followed} followed`);
}

/*************************************************************************************************
Running everything
*************************************************************************************************/

const servers = [];
const opened = {};
const report = { startedAt: new Date().toISOString(), sites: [], transfers: [] };
try {
  if (!fs.existsSync(path.join(EXTENSION, 'manifest.json'))) throw new Error('build the extension first: npm --prefix plugin run build');
  for (const key of SITE_KEYS) servers.push(await startBackend(SITES[key].port, key));
  servers.push(await startBackend(TRANSFER_PORT, 'transfer'));
  for (const key of SITE_KEYS) opened[key] = await openSite(key);
  await Promise.all(SITE_KEYS.map((key) => testSite(opened[key]).catch((error) => {
    opened[key].results.error = error.message;
    check(`${key}: the page's tests run without errors`, false, error.message);
  })));
  for (const key of SITE_KEYS) checkRecords(opened[key]);
  report.sites = SITE_KEYS.map((key) => opened[key].results);

  if (SITE_KEYS.length === 3) {
    report.transfers.push(await testTransfer(opened, 'kargo', 'checklist', ['creatify', 'canva']));
    report.transfers.push(await testTransfer(opened, 'canva', 'next-step', ['kargo']));
  }
} catch (error) {
  check('the run completes', false, error.message);
} finally {
  report.finishedAt = new Date().toISOString();
  report.checks = checks;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2));
  for (const site of Object.values(opened)) await site.context.close().catch(() => {});
  await Promise.all(servers.map(stopBackend));
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n== RESULT ==\n  ${checks.length - failed.length} passed, ${failed.length} failed\n  results and screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
