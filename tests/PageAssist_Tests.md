# tests

All tests live here, split by the part they exercise. No shared runner — each is a plain script that
exits non-zero on the first failed assertion and prints a `[FAIL] …` line.

## backend/ — plain Python (no pytest)

```sh
PYTHONPATH=backend backend/.venv/bin/python tests/backend/full_flow_test.py
PYTHONPATH=backend backend/.venv/bin/python tests/backend/structural_update_test.py
```

- **full_flow_test.py** — every endpoint once: health, analyze, GET task rep, interface reset,
  /chat, save/activate the reusable database, generate + GET the widget, widget-not-persisted +
  chat-log-truncates-on-reset.
- **structural_update_test.py** — a revealed field (answering "Are you Hispanic/Latino?" on the
  Greenhouse/Snorkel page reveals `#race`) must flow into the widget's `state.items`, via both the
  full re-analyze path and the fast `/task-representations/{id}/patch` path (splice + regenerate,
  plus removal and the un-analyzed-site 404).

With `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` in `backend/.env` these hit the real model and take a
few minutes; without them the deterministic fallbacks run and the plumbing assertions still hold.

## plugin/ — Node scripts (Node ≥ 22, uses `linkedom`)

```sh
npm --prefix tests install      # once — installs linkedom into tests/node_modules/
node tests/plugin/completion.test.ts
node tests/plugin/completion.ashby.test.ts
node tests/plugin/structural.test.ts
```

- **completion.test.ts / completion.ashby.test.ts** — the real `plugin/lib/completion.ts`
  `isElementComplete` against reconstructed Greenhouse (react-select) and Ashby
  (custom combobox / radiogroup) DOM.
- **structural.test.ts** — the real `plugin/lib/page-scan.ts` (`currentFieldSet`, what content.ts's
  `handlePageChange` diffs; and `mutationsIncludeFieldChange`, the MutationObserver gate) against the
  Greenhouse EEO form: answering "Are you Hispanic/Latino?" reveals a `race` field and that must
  register as a structural change; merely opening/closing a react-select dropdown (menu/listbox/option
  nodes, value text) must not reach the structural pipeline at all; and a file-upload widget swapping
  its "Attach / Dropbox / …" caption labels for a "&lt;filename&gt; ×" chip (a bare `<label>` is not a
  tracked field) must not read as structural.
