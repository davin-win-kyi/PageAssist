/*
The following file handles the widget's frame on top of the webpage
- creating the frame, and giving every new widget a fresh sandbox in it
- docking the frame to the bottom right, and fitting its height to the widget's content
- moving the frame when the widget's drag handle is used (frame-drag.ts)
Note: this is done on the page since the sandbox cannot move or size its own frame
*/

import { applyStyle } from './frame-style.ts';
import { startFrameDrag, type FrameDrag } from './frame-drag.ts';

const FRAME_SELECTOR = 'iframe[data-pageassist-interface]';
const POSITION_PROPERTIES = ['top', 'right', 'bottom', 'left'] as const;

// The frame requests the sandbox sends (window.pageassist in entrypoints/sandbox/main.ts)
export type FrameMessage = { type?: string; height?: number; screenX?: number; screenY?: number };

export type InterfaceFrame = {
  current(): HTMLIFrameElement | null;
  create(): HTMLIFrameElement;
  reload(frame: HTMLIFrameElement): void;
  place(frame: HTMLIFrameElement, style: Record<string, unknown>): void;
  handleMessage(frame: HTMLIFrameElement, data: FrameMessage): boolean;
  endDrag(): void;
};

export function createInterfaceFrame(doc: Document = document): InterfaceFrame {
  let drag: FrameDrag | null = null;
  const sandboxUrl = () => globalThis.chrome?.runtime?.getURL?.('sandbox.html');

  /*************************************************************************************************
  Creating and placing
  *************************************************************************************************/

  /*
  A real navigation to the extension's sandbox page, not srcdoc, so the page's CSP can't block it.
  sandbox="allow-scripts" without allow-same-origin gives it an opaque origin, with no access to
  the page's DOM, cookies or storage.
  */
  function create(): HTMLIFrameElement {
    const frame = doc.createElement('iframe');
    frame.setAttribute('data-pageassist-interface', 'true');
    frame.setAttribute('title', 'PageAssist interface support');
    frame.setAttribute('sandbox', 'allow-scripts');
    Object.assign(frame.style, { position: 'fixed', zIndex: '2147483646', border: '0', background: 'transparent', colorScheme: 'light' });
    reload(frame);
    doc.body.appendChild(frame);
    return frame;
  }

  /*
  Loads a fresh sandbox document into the frame, so a new widget never runs next to the
  listeners and timers of the one before it. The frame keeps its place on the page.
  */
  function reload(frame: HTMLIFrameElement) {
    const url = sandboxUrl();
    if (url) frame.src = url;
    else console.error('PageAssist: could not resolve the widget sandbox page URL');
  }

  /*
  Applies the widget's style. A frame with no position yet is docked to the bottom right at a
  readable size, and a frame the user dragged stays where they put it.
  */
  function place(frame: HTMLIFrameElement, style: Record<string, unknown>) {
    // a position the widget asks for replaces the old one instead of mixing with it
    if (POSITION_PROPERTIES.some((property) => style[property])) {
      POSITION_PROPERTIES.forEach((property) => frame.style.removeProperty(property));
    }
    applyStyle(frame, style);
    frame.dataset.pageassistExplicitHeight = style.height ? 'true' : 'false';
    if (!frame.style.top && !frame.style.bottom) frame.style.bottom = '20px';
    if (!frame.style.left && !frame.style.right) frame.style.right = '20px';
    if (!frame.style.width) frame.style.width = '300px';
    // a starting height until the widget reports its own
    if (!frame.style.height) frame.style.height = '160px';
  }

  /*************************************************************************************************
  Sizing and moving
  *************************************************************************************************/

  // Fits the frame to the widget's content, unless the widget pinned a height
  function fitHeight(frame: HTMLIFrameElement, height: number) {
    if (frame.dataset.pageassistExplicitHeight === 'true') return;
    const capped = Math.min(Math.max(Math.round(height) + 8, 40), (doc.defaultView?.innerHeight ?? 800) * 0.7);
    frame.style.height = `${capped}px`;
  }

  // Moves the frame by a pointer delta. A docked frame switches to left/top the first time.
  function move(frame: HTMLIFrameElement, dx: number, dy: number) {
    const rect = frame.getBoundingClientRect();
    frame.style.removeProperty('right');
    frame.style.removeProperty('bottom');
    frame.style.left = `${rect.left + dx}px`;
    frame.style.top = `${rect.top + dy}px`;
  }

  function endDrag() {
    drag?.end();
  }

  /*
  Handles the frame requests from the sandbox, and returns false for any other message
  */
  function handleMessage(frame: HTMLIFrameElement, data: FrameMessage): boolean {
    switch (data.type) {
      case 'dragStart':
        if (typeof data.screenX !== 'number' || typeof data.screenY !== 'number') return true;
        drag?.end();
        drag = startFrameDrag(doc, data.screenX, data.screenY, (dx, dy) => move(frame, dx, dy), () => { drag = null; });
        return true;
      case 'dragEnd':
        drag?.end();
        return true;
      case 'resize':
        if (typeof data.height === 'number') fitHeight(frame, data.height);
        return true;
      case 'setHeight':
        if (typeof data.height !== 'number') return true;
        frame.dataset.pageassistExplicitHeight = 'true';
        frame.style.height = `${Math.max(0, Math.round(data.height))}px`;
        return true;
      case 'resetHeight':
        frame.dataset.pageassistExplicitHeight = 'false';
        return true;
      default:
        return false;
    }
  }

  return {
    current: () => doc.querySelector(FRAME_SELECTOR) as HTMLIFrameElement | null,
    create,
    reload,
    place,
    handleMessage,
    endDrag,
  };
}
