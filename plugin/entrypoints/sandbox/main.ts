// Runs inside a sandboxed iframe: sandbox="allow-scripts" with no allow-same-origin, given by the host
// page (content.ts) — that combination gives this document an OPAQUE origin, which is what actually
// isolates it: it structurally cannot reach window.parent.document, the host page's cookies/storage, or
// navigate the top frame. This page is loaded via a real navigation to an extension-origin URL (not
// srcdoc), so it gets its own CSP rather than silently inheriting whatever the host page's CSP happens to
// block. The model's generated widget code runs only here, never on the real page.
//
// Everything below is belt-and-suspenders on top of the opaque origin, not the actual security boundary —
// the browser enforces that one structurally. This is deliberately small and framework-free: less trusted
// surface for arbitrary generated code to run alongside.

// Disabled before any generated code can run, in case the opaque-origin restriction alone isn't trusted
// to be enough on some browser/version. Each throws instead of silently no-op'ing, so a widget that tries
// to use one fails loudly (visible in its own error state) rather than mysteriously doing nothing.
function denied(name: string): () => never {
  return () => {
    throw new Error(`${name} is not available inside the TaskWeb widget sandbox.`);
  };
}
Object.assign(window, {
  fetch: denied('fetch'),
  XMLHttpRequest: denied('XMLHttpRequest'),
  WebSocket: denied('WebSocket'),
  open: denied('window.open'),
});
if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
  Object.assign(navigator, { sendBeacon: denied('navigator.sendBeacon') });
}

type InitMessage = { type: 'init'; code: string; state: unknown };
type StateMessage = { type: 'state'; state: unknown };
type HostMessage = InitMessage | StateMessage;

let render: ((state: unknown) => void) | null = null;

// The only capabilities the host grants generated code over its own frame. There is no host-drawn
// chrome — a widget that wants a drag handle, a close button, or a fixed height draws that control
// itself and calls these. Each is a thin message to the host (see the 'move' / 'close' / 'setHeight' /
// 'resetHeight' handlers in entrypoints/content.ts); nothing here can touch the real page.
function postToHost(message: Record<string, unknown>) {
  window.parent.postMessage({ source: 'taskweb-sandbox', ...message }, '*');
}
Object.assign(window, {
  taskweb: {
    move: (dx: number, dy: number) => postToHost({ type: 'move', dx: Number(dx) || 0, dy: Number(dy) || 0 }),
    close: () => postToHost({ type: 'close' }),
    setHeight: (px: number) => postToHost({ type: 'setHeight', height: Math.max(0, Number(px) || 0) }),
    resetHeight: () => postToHost({ type: 'resetHeight' }),
  },
});

// The host has no access into this document (opaque origin), so it can't measure the widget's own
// content height directly the way it could when content lived in the host's own DOM — this reports it
// instead, both right after each render and whenever it changes afterward (e.g. the code's own async
// updates, CSS transitions settling), so the host can size the iframe to fit.
function reportSize() {
  const height = document.body.scrollHeight;
  window.parent.postMessage({ source: 'taskweb-sandbox', type: 'resize', height }, '*');
}
new ResizeObserver(() => reportSize()).observe(document.body);

function showError(message: string) {
  document.body.replaceChildren();
  const el = document.createElement('div');
  el.style.cssText = 'color:#b91c1c;padding:12px;white-space:pre-wrap;';
  el.textContent = `Widget error: ${message}`;
  document.body.appendChild(el);
  window.parent.postMessage({ source: 'taskweb-sandbox', type: 'error', message }, '*');
}

window.addEventListener('message', (event) => {
  // An opaque origin has no origin string worth checking (it reports as "null") — event.source (the
  // exact Window object that sent it) is the only reliable way to confirm a message actually came from
  // the host page that embedded this frame, not some unrelated frame that happened to postMessage in.
  if (event.source !== window.parent) return;
  const data = event.data as HostMessage;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'init') {
    try {
      // The one deliberate eval in this system — safe specifically because this execution context is
      // opaque-origin (no access to the real page, its cookies, or its storage) with the network APIs
      // above already stripped. Convention: the generated code must assign window.render = function(state).
      // eslint-disable-next-line no-new-func
      new Function(data.code)();
      const win = window as unknown as { render?: (state: unknown) => void };
      if (typeof win.render !== 'function') {
        showError('generated code did not define window.render(state)');
        return;
      }
      render = win.render;
      render(data.state);
      reportSize();
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  } else if (data.type === 'state') {
    if (!render) return;
    try {
      render(data.state);
      reportSize();
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  }
});

// Sent the moment the listener above is live. A real navigation (as opposed to srcdoc) means any message
// the host sends before this fires is simply dropped, not queued — the host must wait for this before
// posting 'init'.
window.parent.postMessage({ source: 'taskweb-sandbox', type: 'sandbox-ready' }, '*');
