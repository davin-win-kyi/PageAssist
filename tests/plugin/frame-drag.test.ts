// Runs the REAL plugin/lib/frame-drag.ts — the host side of dragging the widget's frame: the frame
// follows the pointer's screen position (from the page-wide layer or the widget's forwarded events, one
// running position between them), and the layer never outlives the drag.
// The behaviour across a real out-of-process iframe (a fast flick off the frame, a release outside it)
// needs a real browser; it was checked in Chromium with site isolation on, not in this suite.
//   node tests/plugin/frame-drag.test.ts
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<!doctype html><html><body></body></html>');
const { startFrameDrag } = await import('../../plugin/lib/frame-drag.ts');

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? (pass += 1) : (fail += 1);
}
const layer = () => document.querySelector('[data-pageassist-interface="drag-layer"]');
const pointer = (type: string, screenX = 0, screenY = 0, buttons = 1) =>
  Object.assign(new document.defaultView!.Event(type), { screenX, screenY, buttons });

console.log('== the frame follows the pointer\'s screen position ==');
{
  const moves: number[][] = [];
  let ended = 0;
  const drag = startFrameDrag(document, 100, 100, (dx, dy) => moves.push([dx, dy]), () => { ended += 1; });
  check('a page-wide layer goes up for the drag', !!layer(), true);
  drag.to(120, 110);                                   // the widget forwards a move while over the frame
  layer()!.dispatchEvent(pointer('pointermove', 400, 300)); // the pointer left the frame: the layer sees it
  drag.to(410, 305);                                   // back over the frame
  check('every move is measured from one running position, whichever side saw it', moves, [[20, 10], [280, 190], [10, 5]]);
  drag.to(410, 305);
  check('no move when the pointer didn\'t move', moves.length, 3);
  layer()!.dispatchEvent(pointer('pointerup', 410, 305, 0));
  check('releasing ends the drag and takes the layer down', [ended, !!layer()], [1, false]);
  drag.to(500, 500);
  drag.end();
  check('nothing moves after the drag ended, and ending twice is harmless', [moves.length, ended], [3, 1]);
}

console.log('\n== the layer never outlives the drag ==');
{
  let ended = 0;
  startFrameDrag(document, 0, 0, () => {}, () => { ended += 1; });
  layer()!.dispatchEvent(pointer('pointermove', 50, 50, 0));
  check('a move with no button held (released where nothing saw it) ends the drag', [ended, !!layer()], [1, false]);
  const drag = startFrameDrag(document, 0, 0, () => {});
  layer()!.dispatchEvent(pointer('pointercancel'));
  check('a cancelled pointer ends it too', !!layer(), false);
  drag.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
