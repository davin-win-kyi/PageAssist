# tests

All tests live here, split by the part they exercise, mirroring the top-level `backend/` / `plugin/`
split. No shared runner and no test framework (no pytest, no vitest/jest) — each file is a plain
script that runs the *real* production code (not a mock of it) against reconstructed real-page
markup, prints one `[ok]`/`[FAIL]` line per assertion, and exits non-zero on the first failure.

| Folder | Exercises | Run with |
|---|---|---|
| `backend/` | The FastAPI app in `../backend/` — every endpoint, the model-call + fallback paths | plain Python |
| `plugin/` | The pure `lib/*.ts` modules in `../plugin/lib/` — completion detection, structural-change detection | Node + `linkedom` (a lightweight DOM, no real browser needed) |

## backend/ — plain Python (no pytest)

```sh
PYTHONPATH=backend backend/.venv/bin/python tests/backend/full_flow_test.py
PYTHONPATH=backend backend/.venv/bin/python tests/backend/structural_update_test.py
```

- **full_flow_test.py** — every endpoint once: health, analyze, GET task rep, interface reset,
  /chat, save/activate the reusable database, generate + GET the widget, widget-not-persisted +
  chat-log-truncates-on-reset, and `enforce_bundled_selectors` (the widget-generation router's
  deterministic correction of a `selectors: [...]` bundle — including the label-id false-positive
  regression, and the model-can't-be-trusted-to-pick-the-right-control case).
- **structural_update_test.py** — a revealed field (answering "Are you Hispanic/Latino?" on the
  Greenhouse/Snorkel page reveals `#race`) must flow into the widget's `state.items`, via both the
  full re-analyze path and the fast `/task-representations/{id}/patch` path (splice + regenerate,
  `added_items` for splicing into a live widget, plus removal and the un-analyzed-site 404); a `revealed` question is added only when nothing of it
  is mapped yet (an already-mapped one, or a radio group with any option mapped, adds nothing); and
  `containers` flow through analyze and patch.

With `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` in `backend/.env` these hit the real model and take a
few minutes; without them the deterministic fallbacks run and the plumbing assertions still hold.

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
```

- **completion.test.ts / completion.ashby.test.ts** — the real `plugin/lib/completion.ts`
  `isElementComplete` against reconstructed Greenhouse (react-select) and Ashby
  (custom combobox / radiogroup) DOM: what answers a question (text, checkbox, radio group, file,
  dropdown option, custom selection states) and what never does (whitespace, a cleared pre-filled
  date, a filled control beside an empty answer field, options classed `unselected`, a checkbox
  clicked on and off, filter text typed into a react-select, a placeholder) — with "None" / "N/A"
  counted as real answers, and a real default left in a field the user visited counted too (never
  an untouched default, nor a visited placeholder).
- **selectors.test.ts** — the real `plugin/lib/selectors.ts` names: links, buttons and headings named
  by their own text, `aria-labelledby` before `aria-label`, and nothing truncated.
- **mutations.test.ts** — the real `plugin/lib/mutations.ts` `describeMutation`: controls nested in an
  added wrapper are reported and each one counted, removed elements report the identities they
  carried, no identity is a bare tag, and non-element targets don't crash.
- **page-scan.test.ts** — the real `plugin/lib/page-scan.ts` `scanPage()` output: which elements are
  collected (prose, table cells, images, summary — never hidden inputs, `<option>`s, or id-only layout
  nodes), the fields each carries (`description`, `completion_status`, `container`, an `id` that is
  never positional), context containers and their labels/parent chain, selectors staying unique and
  sticky across repeated entries, a late-in-the-page form surviving the 500-element budget, and a
  page whose `<body>` class says "menu" (WordPress/GeneratePress) still being read in full.
- **structural.test.ts** — the real `scanPage()` field snapshot + `diffFieldSnapshots` (what
  content.ts's `handlePageChange` diffs) and `mutationsIncludeFieldChange` (the MutationObserver gate),
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
  Chromium with site isolation on; it needs a real browser, so it isn't in this suite.)
