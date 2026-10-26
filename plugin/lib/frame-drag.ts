/*
Frame dragging logic nessecary for the frame to move on top of the
webpage
- the file on the page does the moving 
- with the invisible layer the dragging does not become faulty to fast drags 
  and instead of having the drag go to the bottom as before, the invisible layer
  prevents that from happening, where the drag goes to the page instead of the 
  widget 
- tracks the pointer on the screen and not within the page 
  (if within the page than the widget would jitter)
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
  // not page content, so the observer skips it
  layer.setAttribute('data-pageassist-interface', 'drag-layer');
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
