# TaskWeb Studio

TaskWeb is a prototype for authoring webpage interfaces through three linked representations:

- **Task representation** — grounded in one specific webpage's real DOM (`task_id`/`task_name`/`children_tasks`/`task_elements`). Rebuilt per site from its actual elements; never fabricated.
- **Interface representation** — a single, webpage-agnostic set of preferences (`component`/`component_preferences`/`children`), shaped entirely through chat against a generic preview, independent of any specific site.
- **Webpage interface** — the concrete interface actually injected into a given site, produced by combining that site's task representation with the interface representation.

The side panel (built with WXT/React) chats with the user to shape the interface representation, and separately analyzes whatever page is open to build its task representation; the FastAPI service combines the two via Claude to generate each site's concrete webpage interface, which a content script renders as a floating overlay on the real page.

## Run it

### Plugin

The plugin is built with [WXT](https://wxt.dev) (Vite + React under the hood).

```sh
cd plugin
npm install
npm run dev
```

`npm run dev` launches a dedicated Chrome instance with the extension already loaded and hot-reloading across the side panel, content script, and background worker — no manual "load unpacked" step needed while iterating.

For a one-off production build, run `npm run build` inside `plugin`; it outputs to `plugin/.output/chrome-mv3/`. To load that build manually (e.g. in Edge, or a Chrome profile you're not running `dev` in), open the browser's extensions page, enable Developer mode, and choose `plugin/.output/chrome-mv3` as an unpacked extension. Click the extension's toolbar icon to open the chat as a side panel. The plugin injects a content script into webpages and exposes the `taskweb:inspect` and `taskweb:apply-interface` page events.

### Backend

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The backend exposes:
- `GET /health`
- `POST /task-representations/{site_id}/analyze`, `GET /task-representations/{site_id}` — per-site, built from real page elements
- `GET /interface-representation`, `POST /interface-representation/reset` — the currently *active* preferences object (what `/chat` edits)
- `GET /interface-representations` — lists every saved, reusable interface representation
- `POST /interface-representations` — saves the active one as a new named, reusable entry
- `POST /interface-representations/{id}/activate` — makes a previously saved one active again, e.g. to reuse it on a different site
- `POST /chat` — conversational, updates only the active interface representation
- `POST /webpage-interfaces/{site_id}/generate`, `GET /webpage-interfaces/{site_id}` — combines a site's task representation with the active interface representation into that site's concrete interface
- `POST /task-representations/{site_id}/events/process` — checks whether a detected page change is task-relevant, and if so regenerates that site's webpage interface

Task representations (and each site's generated webpage interface) are persisted to `backend/task_representations.json`; the interface representation database lives in `backend/interface_representations.json`. Both are created fresh on first run. Set `VITE_API_URL` when the API is not running at `http://localhost:8000`. Model credentials are read from `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` env vars; without them, each endpoint falls back to a deterministic non-AI response so the app still runs.