# TaskWeb plugin

Chrome MV3 extension built with [WXT](https://wxt.dev) (Vite + React). See the
[top-level README](../README.md) for the system overview and the three representations.

## Run it

```sh
cd plugin
npm install
npm run dev
```

`npm run dev` launches a dedicated Chrome instance with the extension loaded and hot-reloading across
the side panel, content script, and background worker. Click the toolbar icon to open the side panel.

One-off production build: `npm run build` (runs `tsc --noEmit` then `wxt build`) → output in
`.output/chrome-mv3/`. Load it via the browser's extensions page → Developer mode → "Load unpacked".

Set `VITE_API_URL` if the backend is not at `http://localhost:8000`.

## Entrypoints

| File | Context | Role |
|---|---|---|
| `entrypoints/background.ts` | service worker | one line — open the side panel on toolbar click |
| `entrypoints/sidepanel/` | extension page (React) | the chat UI, saved-interfaces list, orchestration |
| `entrypoints/content.ts` | every web page | reads the page, watches it for change, hosts the widget iframe |
| `entrypoints/sandbox/` | `allow-scripts` iframe | runs the model-generated widget code in isolation |
| `lib/` | shared modules | `completion.ts` (live done/undone detection), `selectors.ts`, `page-scan.ts`, `mutations.ts`, `frame-style.ts` (content-script helpers), `api.ts` + `extension.ts` (panel helpers) |

`lib/completion.ts` has node tests at [`../tests/plugin/`](../tests/PageAssist_Tests.md) — `node tests/plugin/completion.test.ts`.

### Side panel (`sidepanel/App.tsx`)

The orchestrator. It:

- Computes a `site_id` from the active tab's URL (`hostname + pathname + search`, `/` → `~`) and, on
  a real page change, calls `POST /task-representations/{id}/analyze`. If the active tab has no content
  script (it was already open when the extension loaded), the panel force-injects it via
  `chrome.scripting.executeScript` before retrying — no page refresh needed.
- Chats with the backend (`POST /chat`) to shape the **interface representation**; manages the saved
  database (list / save / activate / delete; searchable, with a per-entry emoji + colour accent
  derived from its id).
- On explicit **activate** or **agree-in-chat**, calls `POST /webpage-interfaces/{id}/generate` and
  pushes the result to the content script.
- Listens for `PAGE_CHANGED` messages: a *structural* one (a field element entered/left the DOM) while
  a widget is showing **patches** the task representation with just the added/removed fields
  (`POST /task-representations/{id}/patch` — fast) then regenerates the widget, falling back to a full
  `analyze` if the patch fails. Value edits are ignored (the checklist updates live client-side). The
  widget only ever appears on explicit user action.
- Debounces navigation events (`tabs.onUpdated` / `onActivated` / `webNavigation.onHistoryStateUpdated`)
  and never runs two analyses at once — a burst of SPA `pushState` calls collapses into one analyze.

### Content script (`content.ts`)

The page-side agent. Four jobs:

1. **Read the page** — `getPageElements()` walks the DOM (into shadow roots, bounded) and returns up
   the priority-sorted top ≤500 as `{id, selector, tag, text, role, accessibleName, visible}` (form
   controls / form structure / headings first, visible before hidden). Exposed via the
   `GET_PAGE_ELEMENTS` message (which also returns `pageText` — the page's readable `innerText`, used
   at generation time for content items like recipe steps) and the `taskweb:inspect` window event.
2. **Watch for change** — a `MutationObserver` (debounced 400 ms) emits a `PAGE_CHANGED` runtime
   message, but ONLY when a mutation actually **added or removed a form field**
   (`mutationsIncludeFieldChange`, ignoring anything inside an open dropdown/popover). A react-select
   expanding/collapsing adds only `listbox`/`option` nodes, and a plain click/focus adds nothing — so
   neither reaches the structural pipeline at all. `structural` is then confirmed by diffing
   `currentFieldSet()` against the last snapshot. (Completion state has its own instant, un-debounced
   `input`/`change`/`click` listeners — see step 4.)
3. **Host the widget** — creates the sandboxed iframe (`sandbox.html`) and posts the widget's `code`
   and `state` into it. Draws **no chrome of its own**.
4. **Keep live state accurate** — a second, un-debounced set of listeners re-reads each tracked
   element's real filled/clicked state and pushes it into the sandbox on every keystroke, with no
   network or model call. This is what makes a checklist tick off in real time.

### Widget sandbox (`sandbox/main.ts`)

A real navigation to an extension-origin page (not `srcdoc`), embedded with `sandbox="allow-scripts"`
and no `allow-same-origin` → **opaque origin**: it cannot reach the host page's DOM, cookies, storage,
or navigate the top frame. `fetch` / `XMLHttpRequest` / `WebSocket` / `window.open` /
`navigator.sendBeacon` are replaced with throwing stubs before any generated code runs.

The generated code must assign `window.render = function(state) { ... }` and nothing else at the top
level. `render(state)` is re-called on every state change and must be idempotent (reset
`document.body` at the start of each call). `state.items` are either **grounded** (a `selector`; the
host keeps `item.complete` live from the DOM — the widget only shows it) or **manual**
(`manual: true`, no selector — a recipe step / section; the widget renders a checkbox and owns its
checked state, `liveifyState` leaves it alone).

## Messaging

| Channel | Direction | Messages |
|---|---|---|
| `chrome.tabs.sendMessage` | panel → content script | `GET_PAGE_ELEMENTS` (→ `{url, title, elements}`), `APPLY_WEBPAGE_INTERFACE {tree}` (`null` tree removes) |
| `chrome.runtime.sendMessage` | content script → panel | `PAGE_CHANGED {event}` |
| `iframe.contentWindow.postMessage` | content script ↔ sandbox | host → `{type:'init', code, state}`, `{type:'state', state}` |
| `window.parent.postMessage` | sandbox → content script | `sandbox-ready`, `resize {height}`, `error {message}`, and the `window.taskweb` calls below |

### `window.taskweb` — the only host capabilities the widget gets

There is no host-drawn title bar, drag handle, collapse, or close button. A widget that wants any of
those draws the control itself and calls:

| Call | Effect |
|---|---|
| `window.taskweb.move(dx, dy)` | nudge the frame by a pixel delta (implement drag by streaming deltas during `mousemove`) |
| `window.taskweb.close()` | remove the widget |
| `window.taskweb.setHeight(px)` | pin the frame height |
| `window.taskweb.resetHeight()` | release the pin (back to auto-fit from reported content height) |

Each is a thin `postMessage` to the content script; nothing here can touch the real page.
