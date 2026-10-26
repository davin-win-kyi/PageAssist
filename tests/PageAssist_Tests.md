# tests

All tests live here, split by the part they exercise, mirroring the top-level `backend/` / `plugin/`
split. No shared runner and no test framework (no pytest, no vitest/jest) — each file is a plain
script that runs the *real* production code (not a mock of it) against reconstructed real-page
markup, prints one `[ok]`/`[FAIL]` line per assertion, and exits non-zero on the first failure.

| Folder | Exercises | Run with |
|---|---|---|
| `backend/` | The FastAPI app in `../backend/` — every endpoint, against the real model | plain Python |
| `plugin/` | The pure `lib/*.ts` modules in `../plugin/lib/` — completion detection, structural-change detection | Node + `linkedom` (a lightweight DOM, no real browser needed) |
| `e2e/` | The whole system on the three live pilot pages: the built extension in Chrome, the real backend and model | Node + Playwright |

## backend/ — plain Python (no pytest)

```sh
PYTHONPATH=backend backend/.venv/bin/python tests/backend/full_flow_test.py
PYTHONPATH=backend backend/.venv/bin/python tests/backend/structural_update_test.py
PYTHONPATH=backend backend/.venv/bin/python tests/backend/records_test.py      # no model needed
```

- **full_flow_test.py** — every endpoint once: health, analyze, GET task rep, interface reset,
  /chat, save/activate the reusable database, generate + GET the widget, widget-not-persisted, no
  chat log, a missing model returning a 502 with its reason (and the red warning widget from
  generate), and `enforce_bundled_selectors` (the widget-generation router's
  deterministic correction of a `selectors: [...]` bundle — including the label-id false-positive
  regression, and the model-can't-be-trusted-to-pick-the-right-control case).
- **records_test.py** — the study records, without a model: a new chat starts a session folder,
  and so does recording before the first one; every chat turn, task representation and interface
  representation version is kept, with the turn the user agreed on and the refinements after it;
  each interface keeps its code, items, iterations, and the two representations it was built from;
  screenshots are filed with their interface, numbered rather than overwritten, and refused for a
  record id outside the session or anything that isn't an image; errors and events are kept; page
  addresses keep no query string and no page text is kept; a session folder removed while running
  is started again, and a record that can't be written is skipped instead of failing the chat.
- **structural_update_test.py** — a revealed field (answering "Are you Hispanic/Latino?" on the
  Greenhouse/Snorkel page reveals `#race`) must flow into the widget's `state.items`, via both the
  full re-analyze path and the fast `/task-representations/{id}/patch` path (splice + regenerate,
  `added_items` for splicing into a live widget, plus removal and the un-analyzed-site 404); a `revealed` question is added only when nothing of it
  is mapped yet (an already-mapped one, or a radio group with any option mapped, adds nothing); and
  `containers` flow through analyze and patch.

These need a model configured in `backend/.env` (they hit the real model and take a few minutes);
PageAssist has no model-free fallbacks. Each run uses a throwaway data dir, so `backend/data/` and
`user_study/` are never touched.

## plugin/ — Node scripts (Node ≥ 22, uses `linkedom`)

```sh
npm --prefix tests install      # once — installs linkedom into tests/node_modules/
node tests/plugin/completion.test.ts
node tests/plugin/completion.ashby.test.ts
node tests/plugin/selectors.test.ts
node tests/plugin/mutations.test.ts
node tests/plugin/page-scan.test.ts
node tests/plugin/structural.test.ts
node tests/plugin/widget-items.test.ts
node tests/plugin/frame-drag.test.ts
node tests/plugin/live-pages.test.ts
node tests/plugin/screenshot.test.ts
```

- **completion.test.ts / completion.ashby.test.ts** — the real `plugin/lib/completion.ts`
  `isElementComplete` against reconstructed Greenhouse (react-select) and Ashby
  (custom combobox / radiogroup) DOM: what answers a question (text, checkbox, radio group, file,
  dropdown option, custom selection states) and what never does (whitespace, a cleared pre-filled
  date, a filled control beside an empty answer field, options classed `unselected`, a checkbox
  clicked on and off, filter text typed into a react-select, a placeholder) — with "None" / "N/A"
  counted as real answers, and a real default left in a field the user visited counted too (never
  an untouched default, nor a visited placeholder). Actions never count as done: buttons, links,
  tabs, and a submit input whose value isn't an answer; a toggle button or a dropdown button showing
  its choice is not an action. Also custom sliders and spin buttons, custom textboxes, standalone
  listboxes, a mixed checkbox, and labels judged by what they name (a `<label>`, an `aria-labelledby`
  label, a legend, a matrix row's header).
- **selectors.test.ts** — the real `plugin/lib/selectors.ts` names: links, buttons and headings named
  by their own text, `aria-labelledby` before `aria-label`, and nothing truncated; and
  `stableSelector` always unique: radios sharing a name told apart by value, look-alikes scoped
  under a unique ancestor, a duplicated id never used, a text field never told apart by its `value`
  attribute (which changes as the user types), and a field with no attributes scoped by its tag.
- **mutations.test.ts** — the real `plugin/lib/mutations.ts` `describeMutation`: controls nested in an
  added wrapper are reported and each one counted, removed elements report the identities they
  carried, no identity is a bare tag, and non-element targets don't crash; and
  `changedOutsideInterface` ignoring the widget's own frame, drag layer and `data-tw-ref` stamps.
- **page-scan.test.ts** — the real `plugin/lib/page-scan.ts` `scanPage()` output: which elements are
  collected (prose, table cells, images, summary — never hidden inputs, `<option>`s, or id-only layout
  nodes), the fields each carries (`description`, `completion_status`, `container`, an `id` that is
  never positional), context containers and their labels/parent chain, selectors staying unique and
  sticky across repeated entries, a late-in-the-page form surviving the 500-element budget, and a
  page whose `<body>` class says "menu" (WordPress/GeneratePress) still being read in full. Also
  `isElementVisible` (opacity 0 on an ancestor or the element, but not on a styled radio's native
  input; `inert`; a fixed element escaping a collapsed container) and `isInTransientLayer` for a
  popup an open combobox points at through `aria-controls`, but not a disclosure button's section,
  nor a Materialize select's visible input or a question inside a Vuetify dialog.
- **structural.test.ts** — the real `scanPage()` field snapshot + `diffFieldSnapshots` (what
  content.ts's `handlePageChange` diffs) and `lib/mutations.ts`'s `mutationsIncludeFieldChange` (the
  MutationObserver gate),
  one or more cases per rule: an existing control's own UI is never a new question (dropdown choices,
  a filter box in a dropdown, autocomplete suggestions, a date picker's calendar, an upload's state, a
  validation message, a tooltip, another radio option), while a genuinely new question always is (a
  follow-up revealed by an answer, "Please specify", a repeated education entry, questions in a dialog,
  a hidden question coming into view — reported as *revealed*; a visible question going hidden —
  reported as *hidden*, since it's no longer part of the task; Greenhouse's upload swapping its input
  for a file chip, and back, neither). Includes the Greenhouse EEO and Ashby
  forms, and the gate passing visibility flips but not focus/typing class churn.
- **widget-items.test.ts** — the real `plugin/lib/widget-items.ts`: the `required` flag from
  Greenhouse's `aria-required` (including an explicit `"false"` and a resume upload's `role="group"`
  wrapper), Ashby-style asterisk labels, the `required` attribute, radio groups and fieldset legends;
  which members of a grouped question can never be filled (Greenhouse's "Accepted file types" line);
  and splicing a page change into a live widget — a revealed question landing in page order with its
  neighbour's section, duplicates/headings/buttons skipped, removals (including a bundle losing one
  control).
- **frame-drag.test.ts** — the real `plugin/lib/frame-drag.ts`: the frame follows the pointer's
  screen position from one running position (whether the page-wide layer or the widget saw the
  move), and the layer comes down on release, cancel, or a move with no button held. (Dragging across
  a real out-of-process iframe — a fast flick off the frame, a release outside it — was checked in
  Chromium with site isolation on; it needs a real browser, so it isn't in this suite.) Also
  `lib/interface-frame.ts`: docking, fitting the reported height, a pinned height, a drag moved by
  the drag layer alone, a release the sandbox saw first ending the drag, a later update keeping the
  frame where it was dragged, and a position the widget asks for replacing it.
- **live-pages.test.ts** — markup rebuilt from the three live pilot pages: Kargo's Greenhouse
  application (answering "Are you Hispanic/Latino?" adds the race question and nothing else, its
  open dropdown isn't a page change, the answered dropdown counts as done), Creatify's Ashby
  application (its upload and submit buttons are actions, its three questions are required, the
  autofill box parsing a resume isn't a page change), and TechnicalWall's Canva tutorial (its steps
  are scanned despite the theme's menu classes, and ads and lazy images loading in never count as a
  page change).
- **screenshot.test.ts** — where the widget is cut out of a screenshot of the tab for the study
  records: scaled to the screen's pixel density, cut at the edges of the visible area, and nothing
  when the widget is off it.

## e2e/ — the live pilot pages (Node + Playwright)

```sh
npm --prefix plugin run build                    # the extension under test
node tests/e2e/live_sites.mjs --out /tmp/run     # about 15 minutes; screenshots and results.json in --out
node tests/e2e/live_sites.mjs --sites kargo --interfaces checklist   # a quicker subset
```

- **live_sites.mjs** — runs PageAssist end to end on the TechnicalWall Canva tutorial and the Kargo
  (Greenhouse) and Creatify (Ashby) job applications. It does the side panel's part itself, calling
  the same backend routes in the same order, against one throwaway backend per page.
  - For each page it shapes five interfaces in the real chat (a checklist, a next-step prompt, a
    progress tracker, a section overview and a detailed walkthrough), builds each widget, and applies
    it with the built extension.
  - On the job applications it types into the first questions and checks every tracked item is in
    the right state. On the tutorial every item must be ticked by hand, and ticking one must work.
  - On Kargo it answers Hispanic/Latino "No" and checks the race question is spliced into the widget
    that's showing.
  - It saves interfaces and moves them between pages, in both directions.
  - It never submits a form. It needs network access, a model in `backend/.env`, and Chrome: set
    `CHROME_PATH`, or it uses Playwright's Chromium.
  - It also checks each page's study records, filed as the side panel files them: every chat turn,
    every interface with its code, the representations it was built from, a screenshot and the
    iterations that led to it, the task and interface representations, and every page change it
    followed.
