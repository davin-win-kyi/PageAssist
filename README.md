# TaskWeb Studio

TaskWeb is a prototype for **authoring webpage interface support through chat**. You describe a
difficulty you have with a page; TaskWeb helps you shape a reusable support concept, then realizes it
as a small widget grounded in that page's real elements — a live checklist, a progress tracker, a
"what's left" panel, whatever you and the assistant land on.

It has two parts, each with its own README:

| Part | Stack | README |
|---|---|---|
| `plugin/` | Chrome extension — WXT + React (side panel, content script, sandboxed widget) | [plugin/README.md](plugin/README.md) |
| `backend/` | FastAPI + Claude, split into `common` / `task` / `interface` packages | [backend/README.md](backend/README.md) |

## The three representations

Everything in the system is one of three linked representations:

- **Task representation** — a semantic model of what the user is trying to do on **one specific
  webpage**, grounded strictly in that page's real, visible elements. Shape:
  `{task_id, task_name, children_tasks[], task_elements[], example_difficulties[]}`, recursive, with
  each `task_elements` entry copied verbatim from the DOM (`selector`, `tag`, `text`, `role`,
  `accessibleName`, `visible`). Rebuilt per page; never fabricated.

- **Interface representation** — a single, **webpage-agnostic** set of support preferences, shaped
  entirely through chat against a generic preview. Shape: `{component, style, content, children[]}`
  where `style` is real CSS, `content` is short intent phrases (never literal page text), and
  `children` are structural groupings generic to the *kind* of task. One is "active" at a time; any
  can be saved to a reusable database and re-activated on a different site later.

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
  in chat. Page changes regenerate the stored widget silently but never pop it onto the page.
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
