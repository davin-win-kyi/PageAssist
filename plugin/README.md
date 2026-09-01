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

### Side panel (`sidepanel/App.tsx`)

The orchestrator. It:

- Computes a `site_id` from the active tab's URL (`hostname + pathname + search`, `/` → `~`) and, on
  a real page change, calls `POST /task-representations/{id}/analyze`.
- Chats with the backend (`POST /chat`) to shape the **interface representation**; manages the saved
  database (list / save / activate).
- On explicit **activate** or **agree-in-chat**, calls `POST /webpage-interfaces/{id}/generate` and
  pushes the result to the content script.
- Listens for `PAGE_CHANGED` messages and forwards them to `POST /events/process`. It does **not**
  auto-apply anything that comes back — the widget only appears on explicit user action.
- Debounces navigation events (`tabs.onUpdated` / `onActivated` / `webNavigation.onHistoryStateUpdated`)
  and never runs two analyses at once — a burst of SPA `pushState` calls collapses into one analyze.

### Content script (`content.ts`)

The page-side agent. Four jobs:

1. **Read the page** — `getPageElements()` walks the DOM (into shadow roots, bounded) and returns up
   to 300 elements as `{id, selector, tag, text, role, accessibleName, visible}`. Exposed via the
   `GET_PAGE_ELEMENTS` message and the `taskweb:inspect` window event.
2. **Watch for change** — a `MutationObserver` plus capture-phase `input`/`change`/`click` listeners,
   debounced 400 ms, emit a `PAGE_CHANGED` runtime message describing the mutation.
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
`document.body` at the start of each call). For each `state.items` entry it must show the host-managed
`item.complete` flag.

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
