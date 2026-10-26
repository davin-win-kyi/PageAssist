/*
Within a sandboxed iframe:
- this is to allow no allow-same-origin access
- does not interfere with the DOM of the host page
- has it's own extention-origin URL, own CSP (content security policy)
  - this allows it to not be blocked by the host page's CSP
- the widget's model-generated code runs here, and is the one that draws and handles everything
  in the widget, including keeping its scroll positions
- the only things passed to the page are what the widget cannot do itself, since its frame
  belongs to the page: moving, sizing and closing the frame
*/

/*************************************************************************************************
No network access
*************************************************************************************************/

function denied(name: string): () => never {
  return () => {
    throw new Error(`${name} is not available inside the PageAssist widget sandbox.`);
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

/*************************************************************************************************
Requests to the page (window.pageassist)
*************************************************************************************************/

/*
A request to the page for the frame, handled by lib/interface-frame.ts
*/
function postToHost(message: Record<string, unknown>) {
  window.parent.postMessage({ source: 'pageassist-sandbox', ...message }, '*');
}

/*
startDrag(event) is called from the widget's drag handle. The page then moves the frame with the
pointer, since this frame stops getting pointer events once the pointer leaves it.
*/
Object.assign(window, {
  pageassist: {
    startDrag: (event: PointerEvent | MouseEvent) => {
      if (!event || typeof event.screenX !== 'number' || typeof event.screenY !== 'number') return;
      event.preventDefault?.();
      postToHost({ type: 'dragStart', screenX: event.screenX, screenY: event.screenY });
      // a release before the page's drag layer covers the frame still ends the drag
      window.addEventListener('pointerup', () => postToHost({ type: 'dragEnd' }), { once: true });
    },
    close: () => postToHost({ type: 'close' }),
    setHeight: (px: number) => postToHost({ type: 'setHeight', height: Math.max(0, Number(px) || 0) }),
    resetHeight: () => postToHost({ type: 'resetHeight' }),
  },
});

/*
Reports the content height so the page fits the frame to it, unless the widget pinned a height.
Nothing is reported before the widget first draws, so the frame never shrinks to an empty body.
*/
let drawn = false;
function reportSize() {
  if (drawn) postToHost({ type: 'resize', height: document.body.scrollHeight });
}
new ResizeObserver(() => reportSize()).observe(document.body);

/*************************************************************************************************
Running the widget
*************************************************************************************************/

type HostMessage = { type: 'init'; code: string; state: unknown } | { type: 'state'; state: unknown };
type WidgetWindow = { render?: (state: unknown) => void };

/*
Shows a widget error in the frame and reports it to the page
*/
function showError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.replaceChildren();
  const el = document.createElement('div');
  el.style.cssText = 'color:#b91c1c;padding:12px;white-space:pre-wrap;';
  el.textContent = `Widget error: ${message}`;
  document.body.appendChild(el);
  drawn = true;
  reportSize();
  postToHost({ type: 'error', message });
}

/*
From the page: `init` runs the widget's code and its first render, `state` renders new state.
Each widget gets a fresh sandbox, so `init` comes once per document.
*/
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const data = event.data as HostMessage;
  if (!data || (data.type !== 'init' && data.type !== 'state')) return;
  try {
    if (data.type === 'init') new Function(data.code)();
    const render = (window as WidgetWindow).render;
    if (typeof render !== 'function') {
      if (data.type === 'init') showError('generated code did not define window.render(state)');
      return;
    }
    render(data.state);
    drawn = true;
    reportSize();
  } catch (error) {
    showError(error);
  }
});

// tells the page it can send the widget
postToHost({ type: 'sandbox-ready' });
