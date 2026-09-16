# TaskWeb Studio

TaskWeb is a prototype for **authoring webpage interface support through chat**. You describe a
difficulty you have with a page; TaskWeb helps you shape a reusable support concept, then realizes it
as a small widget grounded in that page's real elements — a live checklist, a progress tracker, a
"what's left" panel, whatever you and the assistant land on.

## Folders, at a glance

| Folder | Purpose | README |
|---|---|---|
| `plugin/` | The Chrome extension a user actually installs — WXT + React. Reads the page, chats with the backend, and hosts the generated widget on the page in a sandboxed iframe. | [plugin/PageAssist_plugin.md](plugin/PageAssist_plugin.md) |
| `backend/` | FastAPI + Claude service. Turns a page's real elements plus a user's chat-shaped preferences into the concrete widget the plugin displays. `api/` = `endpoints/<domain>/` (routes) + `state/` (in-process data) + `utils/` (shared infra); `definitions/<domain>/` = `prompts.py` + `schema.py` (what the model is told, no behavior). | [backend/PageAssist_backend.md](backend/PageAssist_backend.md) |
| `tests/` | All tests for both halves, run as plain scripts (no pytest/vitest) against the real production code. | [tests/PageAssist_Tests.md](tests/PageAssist_Tests.md) |

Each of those has its own README with the full file-by-file breakdown — this one stays at the
system level: what the three representations are, and how a request flows end to end.

## The three representations

Everything in the system is one of three linked representations:

- **Task representation** — a task-aware semantic model of **one specific webpage**, grounded strictly
  in its real, visible elements. Two flat tiers:
  `{page_purpose, page_type, tasks[], components[], modeling_notes}`.
  `tasks` are coarse goals (hierarchy via `parent_task_id`); `components` carry per-question
  granularity — **each individual form field is its own component**, since that's what completion
  tracking targets — with selectors copied verbatim from the DOM. Rebuilt per page; never fabricated.

- **Interface representation** — a single, **webpage-agnostic** set of support preferences, shaped
  entirely through chat against a generic preview. Shape:
  `{component, description, style, preferences, children[]}` where `style` is real CSS, `preferences`
  is short intent phrases (never literal page text), `description` is one plain sentence on what the
  support is, and `children` are structural groupings generic to the *kind* of task. One is "active"
  at a time; any can be saved to a reusable database and re-activated on a different site later.

- **Webpage interface** — the concrete widget for one site: its task representation realized through
  the active interface representation. Model-generated JavaScript that runs in a sandboxed iframe,
  plus a small host-managed `style` (frame position/size) and `state.items` (the real elements it
  tracks).

## How it fits together

```
        ┌─────────────── side panel (React) ───────────────┐
        │  chat  ──────────────►  interface representation  │   (webpage-agnostic, reusable)
        │  page open  ────────►  task representation        │   (this page, grounded)
        └───────────────────────────┬──────────────────────┘
                                    │  activate / agree
                                    ▼
                    backend combines the two via Claude
                                    │
                                    ▼
                          webpage interface (JS)
                                    │  chrome.tabs.sendMessage
                                    ▼
        content script hosts it in a sandboxed iframe on the real page;
        refreshes its live "complete" state on every keystroke, no model call
```

- The **content script** reads the page (for analysis), watches it for change, and hosts the widget
  iframe. It draws **no chrome** — the widget authors its own title bar / drag handle / close button
  and asks the host to act via a tiny `window.taskweb` API.
- The widget is only shown after the user **explicitly** activates a saved interface or agrees to one
  in chat. After that, a structural page change (a form control appears, a wizard step advances)
  regenerates the widget and updates it in place — but a widget never appears unbidden.
- Live completion state (a checklist ticking off as you fill fields) is read straight from the DOM by
  the content script — the model never computes or represents it.

## Design commitments

- **User authorship, not a fixed toolkit.** The widget is generated code, not a template. There is no
  predefined component library and no host-drawn UI furniture — anything the user sees, the model
  authored, within the sandbox.
- **Grounded, never fabricated.** Task elements and widget items are copied verbatim from the real
  DOM. The model is told to flatten or show less rather than guess missing structure.
- **Cost control.** Passive page-change events are gated by a structural-change heuristic, an
  agreement check, and a hard per-window cooldown before they can trigger a paid regeneration.
- **Isolation.** Model-generated code runs only in an `allow-scripts` (opaque-origin) iframe with
  `fetch`/`XHR`/`WebSocket`/`window.open` stripped — structurally unable to touch the real page.

## Getting started

See the per-part READMEs for full instructions. In short:

```sh
# backend
cd backend && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && uvicorn main:app --reload --port 8000

# plugin (separate terminal)
cd plugin && npm install && npm run dev
```

`npm run dev` opens a Chrome instance with the extension loaded; click its toolbar icon for the side
panel. Without `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` set in `backend/.env`, every endpoint falls
back to a deterministic non-AI response so the app still runs.
