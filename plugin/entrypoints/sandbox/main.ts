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
- for the study records, it draws a picture of every step of a widget that shows one at a time
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
A request to the page for the frame, handled by lib/interface-frame.ts. None are sent while the
steps are being drawn, so the frame never resizes for a step the user isn't on.
*/
let drawingSteps = false;
function postToHost(message: Record<string, unknown>) {
  if (drawingSteps && message.type !== 'steps') return;
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

type HostMessage =
  | { type: 'init'; code: string; state: unknown }
  | { type: 'state'; state: unknown }
  | { type: 'capture-steps'; id: string };
type Steps = { count: () => number; current: () => number; show: (index: number) => void };
type WidgetWindow = { render?: (state: unknown) => void; pageassist?: { steps?: Steps } };

// The last state the widget was drawn with, to draw it again on another step
let lastState: unknown;

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
  if (data?.type === 'capture-steps') {
    void drawSteps().then((result) => postToHost({ type: 'steps', id: data.id, ...result }), () => postToHost({ type: 'steps', id: data.id }));
    return;
  }
  if (!data || (data.type !== 'init' && data.type !== 'state')) return;
  try {
    if (data.type === 'init') new Function(data.code)();
    const render = (window as WidgetWindow).render;
    if (typeof render !== 'function') {
      if (data.type === 'init') showError('generated code did not define window.render(state)');
      return;
    }
    lastState = data.state;
    render(data.state);
    drawn = true;
    reportSize();
  } catch (error) {
    showError(error);
  }
});

/*************************************************************************************************
Pictures of every step, for the study records
*************************************************************************************************/

/*
A widget that shows one part at a time (a step, card, page or slide) sets window.pageassist.steps
with count(), current() and show(index). Each part is shown and copied in the same moment, then the
user's part is shown again. The browser doesn't paint in between, so the user sees nothing change,
and the copies are drawn into pictures afterwards.
*/
const MAX_STEPS = 40;
type Copy = { markup: string; css: string; width: number; height: number };

function isSteps(steps: unknown): steps is Steps {
  const candidate = steps as Partial<Steps> | undefined;
  return !!candidate && ['count', 'current', 'show'].every((name) => typeof candidate[name as keyof Steps] === 'function');
}

async function drawSteps(): Promise<{ images: (string | null)[]; current: number } | { images: null }> {
  const widget = window as WidgetWindow;
  const steps = widget.pageassist?.steps;
  if (!isSteps(steps) || typeof widget.render !== 'function' || !drawn) return { images: null };
  const start = steps.current();
  const count = Math.min(Math.max(0, Math.floor(Number(steps.count()) || 0)), MAX_STEPS);
  const copies: Copy[] = [];
  drawingSteps = true;
  try {
    for (let index = 0; index < count; index += 1) {
      steps.show(index);
      widget.render(lastState);
      copies.push(copyWidget());
    }
  } finally {
    steps.show(start);
    widget.render(lastState);
    drawingSteps = false;
  }
  const images: (string | null)[] = [];
  for (const copy of copies) images.push(await drawCopy(copy).catch(() => null));
  return { images, current: start };
}

/*
The widget as it looks now, as markup that can be drawn on its own. What a control holds lives in
its properties, so it's written into the copy's attributes.
*/
function copyWidget(): Copy {
  const copy = document.createElement('div');
  copy.setAttribute('style', document.body.getAttribute('style') || '');
  const look = getComputedStyle(document.body);
  copy.style.backgroundColor ||= look.backgroundColor;
  copy.style.color ||= look.color;
  copy.style.fontFamily ||= look.fontFamily;
  copy.style.fontSize ||= look.fontSize;
  copy.style.lineHeight ||= look.lineHeight;
  for (const child of document.body.childNodes) copy.appendChild(child.cloneNode(true));
  const controls = [...document.body.querySelectorAll('input, textarea, select')];
  copy.querySelectorAll('input, textarea, select').forEach((control, i) => {
    const live = controls[i] as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement;
    if (control instanceof HTMLInputElement) {
      control.toggleAttribute('checked', live.checked);
      control.setAttribute('value', live.value);
    } else if (control instanceof HTMLTextAreaElement) {
      control.textContent = live.value;
    } else if (control instanceof HTMLSelectElement) {
      [...control.options].forEach((option, j) => option.toggleAttribute('selected', live.options[j]?.selected ?? false));
    }
  });
  copy.querySelectorAll('script').forEach((script) => script.remove());
  return {
    markup: new XMLSerializer().serializeToString(copy),
    css: [...document.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n'),
    width: document.documentElement.clientWidth,
    height: Math.max(document.body.scrollHeight, 1),
  };
}

/*
Draws a copy into a PNG, through an SVG image of it. Everything is local to the sandbox, so the
canvas stays readable.
*/
async function drawCopy(copy: Copy): Promise<string | null> {
  const css = copy.css.replace(/]]>/g, ']]]]><![CDATA[>');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${copy.width}" height="${copy.height}">`
    + `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">`
    + `<style><![CDATA[${css}]]></style>${copy.markup}</div></foreignObject></svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(copy.width * scale);
  canvas.height = Math.ceil(copy.height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.scale(scale, scale);
  context.drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
}

// tells the page it can send the widget
postToHost({ type: 'sandbox-ready' });
