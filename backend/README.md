# TaskWeb backend

FastAPI service that turns pages and preferences into concrete widgets via Claude. See the
[top-level README](../README.md) for what the three representations are and how the whole system fits
together.

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
```

Without both set, every model call returns `None` and the endpoint uses its deterministic fallback,
so the service still runs end to end.

CORS is open to `http://localhost:5173` (the WXT dev origin).

## Layout

```
backend/
  main.py                     FastAPI app: mounts the routers, /health
  common/
    store.py                  task_store / interface_store + JSON persistence
    llm.py                    Anthropic client + call_structured_tool()
  task/
    representation.py         POST /task-representations/{id}/analyze, GET
    events.py                 POST /task-representations/{id}/events/process
  interface/
    representation.py         /interface-representation(s), /chat, saved database
    prompts.py                TASKWEB_GUIDE (the long /chat system prompt)
    webpage.py                POST /webpage-interfaces/{id}/generate, GET
  task_representations.json        runtime state (git-ignored, created on first write)
  interface_representations.json   runtime state (git-ignored, created on first write)
```

Grouped by **domain**, not by layer. `webpage.py` lives under `interface/` because it realizes an
interface representation on a page; `events.py` lives under `task/` because its route and job are
task-side (it imports `interface.webpage` to do the actual regeneration).

Imports: modules reference shared state as `from common import store` then `store.task_store`
(attribute access, never a `from ... import task_store` binding — `store.replace_task_store()` mutates
the dict in place so every importer stays current).

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /task-representations/{site_id}/analyze` | build this page's task representation from its real elements; replaces the single stored slot |
| `GET /task-representations/{site_id}` | read the stored task representation (404 if it's for another site) |
| `POST /task-representations/{site_id}/events/process` | classify a page change; if structural + agreed + cooled down, silently regenerate and store the widget |
| `GET /interface-representation` | the active preference tree + `agreed` flag |
| `POST /interface-representation/reset` | blank the active tree, clear `agreed` |
| `GET /interface-representations` | list saved, reusable entries |
| `POST /interface-representations` | save the active tree as a new named entry |
| `POST /interface-representations/{id}/activate` | copy a saved entry into the active tree (counts as agreement) |
| `POST /chat` | conversational turn; may update the active interface representation and/or set `agreed` |
| `POST /webpage-interfaces/{site_id}/generate` | combine the stored task representation + active interface representation into a widget; store and return it |
| `GET /webpage-interfaces/{site_id}` | read the stored widget |

`site_id` is an opaque key the client builds from `hostname + pathname + search` (with `/` → `~`) and
`encodeURIComponent`s into the path. Store the raw value; match on it exactly.

## State

Two JSON files in `backend/`, each a single object (not a history):

- **`task_representations.json`** — `{site_id, task_representation, webpage_interface}`. One page at a
  time. Analyzing a new `site_id` replaces the whole thing; re-analyzing the same site keeps its
  `webpage_interface`.
- **`interface_representations.json`** — `{active_tree, active_agreed, representations{}}`.
  `active_agreed` is a one-way latch (only `/chat` on real agreement, or activating a saved entry,
  sets it true; only reset clears it) and gates whether support may ever show on a real page.

## Model calls

`common/llm.py` — `call_structured_tool()` is the shared pattern for every structured call:

1. Force a single tool with `tool_choice` — the model structurally cannot return prose or skip a
   required field.
2. Validate the tool input against a Pydantic model (which raises on a bad enum, missing field, or
   wrong shape).
3. On a validation failure, feed the **exact error** back as an `is_error` tool_result and let the
   model correct itself (up to 2 retries) — not a generic "try again".
4. Still invalid after retries → return `None`, and the endpoint uses its deterministic fallback.

Used by `analyze` (validates against `TaskRepresentationOut`) and `/chat` (validates against
`ChatDecision`). `webpage-interfaces/generate` uses forced tool-use without the retry loop (its output
is executable code, not a closed schema).

### Task representation specifics

- **Input pruning** happens client-side: the content script sends at most 300 elements, each reduced
  to `{id, selector, tag, text, role, accessibleName, visible}`. `analyze` re-caps at 300 as a
  token-budget backstop.
- The system prompt enforces an **atomic-unit rule** (each distinct labelled input is its own leaf
  node — never merge adjacent inputs) and **grounding rules** (prefer `visible` elements; copy
  selectors verbatim; flatten rather than guess missing structure; never assert a value or
  completion state).

### Fallbacks (no/failed model call)

- `analyze` → one child per `<form>` on the page (up to 3).
- `/chat` → a fixed "can't reach the assistant" reply, no tree change.
- `generate` / `events` → a hand-written widget listing the task representation's real elements with
  live checkmarks (`FALLBACK_WIDGET_CODE`).
