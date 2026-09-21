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

## How it works

A visual look at the three representations this backend produces, and the two behaviors they enable
(reuse across pages, live adaptation to page changes). The file-by-file details follow below.

![Interface representation and task representation shapes](../docs/assets/representation-shapes.png)

The task representation best represents the current task and the elements related to that task. The
interface representation is the best representation of the desired task-based interface *without*
being grounded in any given webpage — which is exactly what makes it reusable and adaptable to active
webpage changes.

![Transferring a task interface to a new page](../docs/assets/transferring-interface.png)

An interface built for a job application is saved as a reusable interface representation, then
re-activated on a recipe site — the widget it produces there is grounded in *that* page's own
elements, even though the underlying preferences never changed.

![Actively adapting a task interface to webpage changes](../docs/assets/adapting-to-changes.png)

Support is applied to a page; an active change occurs on it (here, answering "Are you
Hispanic/Latino?" reveals a follow-up race/ethnicity question); the interface adapts to account for
the change — without the user redoing anything, and without a full re-analysis of the page. See
`/task-representations/{id}/patch` under Model calls below for the mechanism behind that adaptation.

## Folders, at a glance

| Folder | Purpose |
|---|---|
| `api/endpoints/` | The FastAPI routes themselves — one package per domain (`task`, `chat`, `interface_representation`, `webpage_interface`). This is the only layer that knows about HTTP (request/response shapes, status codes). |
| `api/state/` | In-process state — plain module-level dicts that get mutated in place, plus the getters/setters around them. This is "what the backend currently believes about the world" (the current page's task representation, the working + saved interface representations, the last-generated widget). Deliberately **not** called `data/` — that name collided with `backend/data/` (the runtime JSON files below), which is a different thing. |
| `api/utils/` | Shared infrastructure with no domain knowledge: JSON file persistence, the Anthropic client + structured-tool-call helper, append-only debug logs. |
| `definitions/` | The prompt text and Pydantic/JSON-schema definitions for each domain — pure data, no behavior. This is where you go to change what the model is told or what shape it must answer in. |
| `data/` | Runtime JSON files (git-ignored) — the on-disk form of `api/state/`'s in-memory dicts, so state survives a server restart. **Not** the `api/state/` package — same word, different folder, see above. |

Three layers under `api/`: **endpoints** (HTTP surface), **state** (in-process data), **utils**
(infra with no domain knowledge). Each `api/endpoints/<domain>/` and `definitions/<domain>/`
re-exports from its `__init__.py`, so callers write `from api.endpoints import task` and
`from definitions.task import TASK_REPRESENTATION_GUIDE, ...`.

## Layout — what each file is

```
backend/
  main.py            FastAPI app: mounts the 4 routers, /health
  api/
    endpoints/        one package per domain (each __init__ re-exports `router`)
    state/             in-process state (mutated in place, never rebound — see Folders above)
    utils/             shared infra used across domains
  definitions/        prompts + schemas per domain — NO behavior. one prompts.py + schema.py each
  data/                runtime JSON (git-ignored) — NOT the api/state/ package
```

**`api/endpoints/`** — one package per domain, each `__init__.py` re-exporting `router`:

| File | Purpose |
|---|---|
| `task/router.py` | `POST /task-representations/{id}/analyze`, `/patch`, and the `GET` |
| `chat/router.py` | `POST /chat` |
| `interface_representation/router.py` | `/interface-representation(s)` — working tree + saved DB CRUD |
| `webpage_interface/router.py` | generate/GET a widget; the model call, fallback, and selector enforcement all live in this one file |
| `webpage_interface/fallback_widget.js` | hand-written widget JS, used when the model call fails |

**`api/state/`** — plain module-level dicts + the getters/setters around them:

| File | Purpose |
|---|---|
| `task.py` | `task_store` (the single current-webpage slot) + persistence |
| `interface_representation.py` | `interface_store` + active-tree accessors + persistence + default tree |
| `webpage_interface.py` | the current widget — IN MEMORY ONLY (never persisted) |

**`api/utils/`** — shared infra with no domain knowledge:

| File | Purpose |
|---|---|
| `json_store.py` | shared JSON load/dump + points at `backend/data/` |
| `llm.py` | Anthropic client, streaming create, `call_structured_tool()` |
| `debuglog.py` | append-only JSONL logs under `backend/data/` (+ `truncate_jsonl`) |

**`definitions/`** — one `prompts.py` + `schema.py` per domain, pure data:

| File | Purpose |
|---|---|
| `task/prompts.py` | `TASK_REPRESENTATION_GUIDE` — how to read a page into tasks/components |
| `task/schema.py` | the task representation's Pydantic models + tool `input_schema` |
| `chat/prompts.py` | `TASKWEB_GUIDE` — how to hold the conversation, when to set `agreed` |
| `chat/schema.py` | `Chat*` models + the `respond_and_update_interface` tool |
| `interface_representation/schema.py` | `SaveInterfaceRepresentationRequest`; `prompts.py` is a stub (no prompt) |
| `webpage_interface/prompts.py` | `WEBPAGE_INTERFACE_GUIDE` — how to turn preferences + page into a widget |
| `webpage_interface/schema.py` | the `build_webpage_interface` tool's `input_schema` |

**`data/`** — runtime JSON (git-ignored), the on-disk form of `api/state/`'s dicts:

| File | Purpose |
|---|---|
| `task_representations.json` | `{site_id, task_representation, page_text}` |
| `interface_representations.json` | `{active_tree, active_agreed, representations{}}` |
| `chat_log.jsonl` | one line per `/chat` turn; truncated on a new chat |

Imports: state lives in `api/state/<domain>.py`, mutated in place (never rebound), so
`from api.state.task import task_store` stays valid after `replace_task_store()`. `chat` and
`webpage_interface` endpoints read the active tree from `api.state.interface_representation`;
`webpage_interface` also reads the task representation from `api.state.task`. Note `api/state/`
(Python package, in-process state modules) is distinct from `backend/data/` (runtime JSON files,
resolved by `json_store.py`) — same word "data" doesn't appear in the package name precisely to avoid
that confusion.

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /task-representations/{site_id}/analyze` | Build this page's **task representation** from its real elements; replaces the single stored slot. Body may include `page_text` (the page's readable prose), stored for widget generation. This is the expensive, full-model call — used on first load of a page and whenever the page has changed enough that a partial patch wouldn't be trustworthy. |
| `POST /task-representations/{site_id}/patch` | Fast path — splice just-added fields in / drop removed ones (small/fast model + deterministic fallback) instead of re-modelling the whole page. Returns the full updated representation plus `changed: bool` (false when the flagged DOM change turned out cosmetic — nothing was actually added/removed, so the caller shouldn't bother regenerating the widget). |
| `GET /task-representations/{site_id}` | Read the stored task representation (404 if it's for another site). |
| `GET /interface-representation` | The active **interface representation** (the working preference tree) + its `agreed` flag. |
| `POST /interface-representation/reset` | Blank the active tree, clear `agreed`, truncate `chat_log.jsonl` — this is what "new chat" / "end chat and start over" calls. |
| `GET /interface-representations` | List saved, reusable interface-representation entries (`{id, name}`) — the "Saved" tab's data. |
| `POST /interface-representations` | Save the active tree as a new named entry in that reusable database. |
| `POST /interface-representations/{id}/activate` | Copy a saved entry into the active tree (this counts as agreement — the widget can be generated from it immediately). |
| `POST /interface-representations/{id}/update` | Write the current active tree back onto that saved entry (overwrite it with whatever chat has since refined). |
| `DELETE /interface-representations/{id}` | Remove a saved entry. The working tree is untouched — if it came from this entry, it's just unlinked (no more "update the one I came from" offer). |
| `POST /chat` | One conversational turn. May reply with text only, or also replace the active interface representation and/or flip `agreed` to true (the model's "this concept is concrete enough to show" signal). |
| `POST /webpage-interfaces/{site_id}/generate` | Combine the stored task representation + the active interface representation into a **webpage interface** (a concrete, model-generated widget); hold it in memory and return it. This is the call that actually produces the thing that shows up on the page. |
| `GET /webpage-interfaces/{site_id}` | Read the in-memory widget (404 after a restart, or for another site — nothing is regenerated automatically). |

`site_id` is an opaque key the client builds from `hostname + pathname + search` (with `/` → `~`) and
`encodeURIComponent`s into the path. Store the raw value; match on it exactly.

## The three representations — what each one is for

TaskWeb's whole pipeline is three progressively more concrete objects, each built from the one before
it (see the [top-level README](../README.md) for the end-to-end picture; this section is what each one
*is* and why it exists as its own thing rather than being folded into another; see How it works above
for the shapes of the first two side by side).

- **Task representation** (`definitions/task/`, `api/state/task.py`) — a structured model of what a
  *specific page* is asking the user to do, grounded in its real DOM elements. Two tiers: `tasks` are
  coarse goals ("fill out this application"), `components` are individual, per-question groupings (one
  form field, or a genuine multi-part answer like a split address) each carrying real CSS selectors
  (`dom_selector` / `member_selectors`) copied verbatim from the page. It exists so that everything
  downstream — the chat, the widget — can talk about "this page's fields" without re-parsing the DOM
  itself, and so the model never has to assert whether a field is filled (the client reads that live).
  One page's worth lives in the store at a time; a new `site_id` replaces it.
- **Interface representation** (`definitions/chat/`, `api/state/interface_representation.py`) — the
  user's *page-agnostic* preferences for what kind of support they want and how it should behave (a
  short tree: `component` slug, human-readable `description`, `style`, `preferences` phrases,
  `children` for structural grouping). This is deliberately **not** grounded in any one page's
  elements — it's the reusable "shape" of the support (e.g. "a checklist, docked bottom-right, one
  item per required field") that the same user might want realized on many different sites. `/chat`
  builds and refines it; the "Saved" tab lets a finished one be reused without re-explaining it. It has
  a working copy (the one chat is currently shaping) and a saved database of named ones.
- **Webpage interface** (`definitions/webpage_interface/`, `api/state/webpage_interface.py`) — the
  concrete result of realizing one interface representation against one page's task representation:
  actual generated JavaScript (`code`) plus its initial `state`, meant to run in the sandboxed widget
  iframe on that specific page. This is the only one of the three that's actually shown to the user,
  and the only one never persisted to disk — it's cheap to regenerate from the other two and only
  meaningful while the client that asked for it is still on that page.

Because the interface representation is never grounded in any one page, the same one can be built for
one site and reused on a completely different one (see the transfer example under How it works above).

## State

- **`data/task_representations.json`** — `{site_id, task_representation, page_text}` (`page_text` = the
  page's readable prose, kept for widget generation). One page at a time;
  analyzing a new `site_id` replaces the whole thing.
- **`data/interface_representations.json`** — `{active_tree, active_agreed, representations{}}`. The
  tree is `{component, description, style, preferences, children}`. `active_agreed` is a one-way latch
  (only `/chat` on real agreement, or activating a saved entry, sets it true; only reset clears it)
  and gates whether support may ever show on a real page.
- **The generated widget is not persisted** — it lives in `api/state/webpage_interface.py` as a
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

This is the mechanism behind the adapting-to-changes example under How it works above:

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
