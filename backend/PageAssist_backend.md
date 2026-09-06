# TaskWeb backend

FastAPI service that turns pages and preferences into concrete widgets via Claude. See the
[top-level README](../README.md) for what the three representations are and how the whole system fits
together. Tests live at [`../tests/backend/`](../tests/PageAssist_Tests.md).

## Run it

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

`.env` (next to `main.py`, git-ignored):

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-...
ANTHROPIC_MODEL_FAST=claude-haiku-4-5   # optional — used by /task-representations/{id}/patch;
                                        # falls back to ANTHROPIC_MODEL when unset
```

Without a key + `ANTHROPIC_MODEL`, every model call returns `None` and the endpoint uses its
deterministic fallback, so the service still runs end to end.

CORS is open to `http://localhost:5173` (the WXT dev origin).

## Layout

```
backend/
  main.py                     FastAPI app: mounts the 4 routers, /health
  api/
    endpoints/                one package per domain (each __init__ re-exports `router`)
      task/router.py          POST /task-representations/{id}/analyze, GET
      chat/router.py          POST /chat
      interface_representation/router.py   /interface-representation(s) — working tree + saved DB CRUD
      webpage_interface/       router.py (routes + the model call + fallback), fallback_widget.js
    data/                     in-process state (mutated in place, never rebound)
      task.py                 task_store (the single current-webpage slot) + persistence
      interface_representation.py   interface_store + active-tree accessors + persistence + default tree
      webpage_interface.py    the current widget — IN MEMORY ONLY (never persisted)
    utils/                    shared infra used across domains
      json_store.py           shared JSON load/dump + points at backend/data/
      llm.py                  Anthropic client, streaming create, call_structured_tool()
      debuglog.py             append-only JSONL logs under backend/data/ (+ truncate_jsonl)
  definitions/                prompts + schemas per domain — NO behavior. one prompts.py + schema.py each
    task/        prompts.py (TASK_REPRESENTATION_GUIDE)   schema.py (models + tool input_schema)
    chat/        prompts.py (TASKWEB_GUIDE)                schema.py (Chat* models + tool)
    interface_representation/   schema.py (SaveInterfaceRepresentationRequest); prompts.py is a stub (no prompt)
    webpage_interface/  prompts.py (WEBPAGE_INTERFACE_GUIDE)   schema.py (the tool input_schema)
  data/                       runtime JSON (git-ignored) — NOT the api/data/ package
    task_representations.json        {site_id, task_representation, page_text}
    interface_representations.json   {active_tree, active_agreed, representations{}}
    chat_log.jsonl                   one line per /chat turn; truncated on a new chat
```

Three layers under `api/`: **endpoints** (one package per domain, room to grow beyond a single
`router.py`), **data** (in-process state), **utils** (shared infra). Each `api/endpoints/<domain>/`
and `definitions/<domain>/` re-exports from its `__init__.py`, so callers write
`from api.endpoints import task` and `from definitions.task import TASK_REPRESENTATION_GUIDE, …`.

Imports: state lives in `api/data/<domain>.py`, mutated in place (never rebound), so
`from api.data.task import task_store` stays valid after `replace_task_store()`. `chat` and
`webpage_interface` endpoints read the active tree from `api.data.interface_representation`;
`webpage_interface` also reads the task representation from `api.data.task`. Note `api/data/` (Python
package, state modules) is distinct from `backend/data/` (runtime JSON, resolved by `json_store.py`).

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /task-representations/{site_id}/analyze` | build this page's task representation from its real elements; replaces the single stored slot. Body may include `page_text` (the page's readable prose), stored for widget generation. |
| `POST /task-representations/{site_id}/patch` | fast path — splice just-added fields in / drop removed ones (small model + deterministic fallback) instead of re-modelling; returns the full updated representation plus `changed: bool` (false when the flagged DOM change turned out cosmetic — nothing was actually added/removed) |
| `GET /task-representations/{site_id}` | read the stored task representation (404 if it's for another site) |
| `GET /interface-representation` | the active preference tree + `agreed` flag |
| `POST /interface-representation/reset` | blank the active tree, clear `agreed`, truncate `chat_log.jsonl` |
| `GET /interface-representations` | list saved, reusable entries (`{id, name}`) |
| `POST /interface-representations` | save the active tree as a new named entry |
| `POST /interface-representations/{id}/activate` | copy a saved entry into the active tree (counts as agreement) |
| `POST /interface-representations/{id}/update` | write the current active tree back onto that saved entry |
| `DELETE /interface-representations/{id}` | remove a saved entry (the working tree is untouched — just unlinked if it came from this one) |
| `POST /chat` | conversational turn; may replace the active interface representation and/or set `agreed` |
| `POST /webpage-interfaces/{site_id}/generate` | combine the stored task representation + active tree into a widget; hold it in memory and return it |
| `GET /webpage-interfaces/{site_id}` | read the in-memory widget (404 after a restart, or for another site) |

`site_id` is an opaque key the client builds from `hostname + pathname + search` (with `/` → `~`) and
`encodeURIComponent`s into the path. Store the raw value; match on it exactly.

## State

- **`data/task_representations.json`** — `{site_id, task_representation, page_text}` (`page_text` = the
  page's readable prose, kept for widget generation). One page at a time;
  analyzing a new `site_id` replaces the whole thing.
- **`data/interface_representations.json`** — `{active_tree, active_agreed, representations{}}`. The
  tree is `{component, description, style, preferences, children}`. `active_agreed` is a one-way latch
  (only `/chat` on real agreement, or activating a saved entry, sets it true; only reset clears it)
  and gates whether support may ever show on a real page.
- **The generated widget is not persisted** — it lives in `api/data/webpage_interface.py` as a
  module global and is gone on restart. It's cheap to regenerate and only meaningful while the client
  that asked for it is still on the page.

## Model calls

All three go through `api/utils/llm.py` → `create_message()`, which uses the **streaming** API
(`messages.stream`) — mandatory once `max_tokens` is large (the SDK hard-errors on big non-streaming
requests). `max_tokens` is 32000 for all three.

`call_structured_tool()` is the shared pattern for the structured calls:

1. Force a single tool with `tool_choice` — the model structurally cannot return prose or skip a
   required field.
2. Validate the tool input against a Pydantic model (raises on a bad enum, missing field, wrong shape).
3. On a validation failure, feed the **exact error** back as an `is_error` tool_result and let the
   model correct itself (up to 2 retries).
4. Still invalid after retries → return `None`, and the endpoint uses its deterministic fallback.

Used by `analyze` (validates against `TaskRepresentationOut`) and `/chat` (`ChatDecision`).
`webpage-interfaces/generate` uses forced tool-use without the retry loop (its output is executable
code, not a closed schema); its user message is a labelled block (preferences, task representation,
and — when stored — the page's `page_text`). Widget `state.items` may be **grounded** — a single
`selector`, or `selectors: [...]` when the item tracks a question answered by more than one control
(first + last name, a split address); the host requires ALL listed selectors filled before the item
counts complete, since one selector can only ever reflect one part of a multi-control answer — and
host tracks `complete` from the DOM either way — or **manual** (`manual: true`, no selector/selectors;
a recipe step / a section — the widget owns its checked state, the host never touches it).

Because this call has no validation-retry loop, the model isn't always trusted to pick `selectors`
correctly on its own — `build_webpage_interface` runs `enforce_bundled_selectors()` over the returned
`state.items` afterward, which re-derives each component's real bundling straight from the task
representation's `member_selectors` and upgrades any item naming only ONE member of a bundle (via
`selector`, or an under-filled `selectors`) to the full member list. This makes it irrelevant which
single control the model happened to ground on — e.g. a phone number's country-code picker vs. the
number itself — since the item ends up requiring every member either way. (There's no reliable way to
tell in advance which member is a genuinely pre-filled default; a country-code picker isn't guaranteed
to start with one — Greenhouse's own phone widget ships it blank — so the safer rule is to just require
all of them.)

`member_selectors` is "the key nodes in this component" (see `definitions/task/schema.py`), NOT
"the controls that must each be filled" — it routinely also carries the component's own `<label>`
(a near-universal `aria-labelledby` pattern gives the label its own id, e.g. `#first_name-label`
beside `#first_name`) plus description/error/help text nodes. `_looks_control_like()` (used by both
`enforce_bundled_selectors` and the fallback's `components_to_items`) excludes an id containing
`label`/`legend`/`description`/`error`/`hint`/`help`/`message`/`caption` before counting what's left
as a real control — otherwise a plain single-field component's own label id reads as a second
"required" control that, being a `<label>`, can never complete, and the item locks incomplete forever
no matter what the user types. (This is exactly what happened before this exclusion existed: adding
`enforce_bundled_selectors` broke live completion for ordinary text fields site-wide.)

`/task-representations/{id}/patch` uses `get_fast_client_and_model()` (`ANTHROPIC_MODEL_FAST`, else
`ANTHROPIC_MODEL`) with a tiny prompt that returns **only the new component(s)** for a few
just-appeared elements (told to return an empty list when they aren't task-relevant); the router
splices them in (and drops components for removed selectors), re-ids to avoid collisions, and links
them to the primary task. Deterministic fallback: one `field-group` component per new control.
`_remove_components` reports how many EXISTING components it actually dropped — a UI-only DOM swap
inside an already-modelled question (a file-upload button row replaced by a "&lt;filename&gt; ×"
chip) almost never matches a real component's selector, so `changed` comes back `false` and the panel
skips regenerating the widget instead of claiming an update happened for nothing.

### Task representation specifics

- **Two tiers, flat lists, no count cap.** `tasks` are coarse goals (hierarchy via `parent_task_id`);
  `components` are semantic groupings. `task_type` and `semantic_role` are **free strings** (short
  kebab-case) — no fixed vocabulary. `importance` (primary/supporting/peripheral) and
  `required_for_task` (true/false/unknown) stay closed `Literal`s.
- **The form-question rule** (from the prompt): every individual form question is its **own**
  component — never bundled with adjacent questions — because per-field completion tracking targets
  components individually. Only genuine sub-parts of one answer combine (street + city + state + zip →
  one address). When a component's `member_selectors` do bundle more than one control this way, the
  webpage-interface guide picks `selectors: [...]` over a single `selector` for that item (see above) —
  otherwise the checklist would read the whole question done the moment just one part was filled.
- **Grounding.** Every `dom_selector` / `member_selector` is copied verbatim from an input node;
  prefer `visible` nodes; never assert a value, completion, or "required" without a visible marker.
  Completion is read live by the content script — there are no model-asserted status fields.
- **Input pruning** is client-side: content.ts collects broadly, priority-sorts (form controls, form
  structure, headings first; visible before hidden) and sends the top ≤500 as
  `{id, selector, tag, text, role, accessibleName, visible}`; `analyze` re-caps at 500. The panel does
  extra forced re-analyzes when a form-heavy page comes back with suspiciously few components (still
  hydrating).

### Fallbacks (no/failed model call)

- `analyze` → one `form-completion` task plus one `field-group` component per real form control, up
  to 40 — so a failure still yields a per-field-granular model.
- `/chat` → a fixed "can't reach the assistant" reply, no tree change.
- `generate` → a hand-written widget listing one row per component with live checkmarks
  (`components_to_items`; emits `selectors: [...]` instead of `selector` for a component whose
  `member_selectors` has more than one control-like entry, same rule as the model path). It carries
  `degraded: true` and its own "couldn't build the support" note, so the panel tells the user
  generation failed rather than showing it as a normal result.
