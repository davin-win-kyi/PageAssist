/*
Dragging the widget's frame. The widget's handle calls window.pageassist.startDrag(event) on pointerdown
(entrypoints/sandbox/main.ts), which reports where the pointer is; from then on the host follows the
pointer and moves the frame — the widget does no drag math of its own.

- An isolated (out-of-process) iframe stops receiving pointer events once the pointer leaves it, so a
  fast flick would drop the drag. For the drag's duration the host covers the page with a transparent
  layer that catches the pointer wherever it goes.
- Positions are screenX/screenY: clientX/clientY shift as the frame moves under the pointer.
- Every move is measured from one last-known position, whichever side (the layer, or the widget
  forwarding its own events) saw the pointer last, so nothing is counted twice.
*/

export type FrameDrag = {
  to(screenX: number, screenY: number): void;
  end(): void;
};

export function startFrameDrag(
  doc: Document,
  screenX: number,
  screenY: number,
  move: (dx: number, dy: number) => void,
  onEnd: () => void = () => {},
): FrameDrag {
  let last = { x: screenX, y: screenY };
  let ended = false;
  const layer = doc.createElement('div');
  layer.setAttribute('data-pageassist-interface', 'drag-layer'); // not page content: the observer skips it
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:move;background:transparent;touch-action:none;';

  const drag: FrameDrag = {
    to(x, y) {
      if (ended) return;
      const dx = x - last.x, dy = y - last.y;
      last = { x, y };
      if (dx || dy) move(dx, dy);
    },
    end() {
      if (ended) return;
      ended = true;
      layer.remove();
      onEnd();
    },
  };
  // a move with no button held means the release happened somewhere the layer couldn't see
  layer.addEventListener('pointermove', (event) => (event.buttons === 0 ? drag.end() : drag.to(event.screenX, event.screenY)));
  layer.addEventListener('pointerup', () => drag.end());
  layer.addEventListener('pointercancel', () => drag.end());
  doc.documentElement.appendChild(layer);
  return drag;
}
