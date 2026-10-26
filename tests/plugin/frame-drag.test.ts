// Runs the REAL plugin/lib/frame-drag.ts — the host side of dragging the widget's frame: the frame
// follows the pointer's screen position (from the page-wide layer or the widget's forwarded events, one
// running position between them), and the layer never outlives the drag.
// The behaviour across a real out-of-process iframe (a fast flick off the frame, a release outside it)
// needs a real browser; it was checked in Chromium with site isolation on, not in this suite.
//   node tests/plugin/frame-drag.test.ts
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<!doctype html><html><body></body></html>');
const { startFrameDrag } = await import('../../plugin/lib/frame-drag.ts');
const { createInterfaceFrame } = await import('../../plugin/lib/interface-frame.ts');

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

console.log('\n== the frame module places, sizes and moves the frame ==');
{
  const frames = createInterfaceFrame(document);
  const frame = frames.create();
  frame.getBoundingClientRect = () => ({ left: 100, top: 50 }) as DOMRect;
  frames.place(frame, {});
  check('docked bottom-right at a readable size by default', [frame.style.bottom, frame.style.right, frame.style.width], ['20px', '20px', '300px']);
  frames.handleMessage(frame, { type: 'resize', height: 200 });
  check('fits the height the widget reports', frame.style.height, '208px');
  frames.handleMessage(frame, { type: 'setHeight', height: 90 });
  frames.handleMessage(frame, { type: 'resize', height: 400 });
  check('a pinned height ignores later resizes', frame.style.height, '90px');
  frames.handleMessage(frame, { type: 'dragStart', screenX: 10, screenY: 10 });
  check('a drag start covers the page with the drag layer', !!layer(), true);
  layer()!.dispatchEvent(pointer('pointermove', 30, 25));
  layer()!.dispatchEvent(pointer('pointerup', 30, 25, 0));
  check('a drag moves it by the pointer delta, from the layer alone', [frame.style.left, frame.style.top, frame.style.right], ['120px', '65px', '']);
  check('  and the layer comes down on release', !!layer(), false);
  frames.handleMessage(frame, { type: 'dragStart', screenX: 0, screenY: 0 });
  frames.handleMessage(frame, { type: 'dragEnd' });
  check('a release the sandbox saw first also ends the drag', !!layer(), false);
  frames.place(frame, {});
  check('  and a later update keeps it where it was dragged', [frame.style.right, frame.style.bottom], ['', '']);
  check('other messages are left to content.ts', frames.handleMessage(frame, { type: 'close' }), false);
  frames.place(frame, { top: '10px', left: '10px' });
  check('a position the widget asks for replaces the dragged one', [frame.style.top, frame.style.left, frame.style.bottom, frame.style.right], ['10px', '10px', '', '']);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
