/*
The following file tests where the widget is cut out of a screenshot of the tab, for the study
records (plugin/lib/screenshot.ts)
  node tests/plugin/screenshot.test.ts
*/
const { cropBox } = await import('../../plugin/lib/screenshot.ts');

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? (pass += 1) : (fail += 1);
}

const docked = { left: 960, top: 220, width: 300, height: 560, viewportWidth: 1280, viewportHeight: 800 };

console.log('== the widget\'s box in a screenshot of the tab ==');
check('at 1x, the box is the frame itself', cropBox(docked, 1280, 800), { x: 960, y: 220, width: 300, height: 560 });
check('on a 2x screen, it is scaled to the image\'s pixels', cropBox(docked, 2560, 1600), { x: 1920, y: 440, width: 600, height: 1120 });
check('a frame dragged partly off the left edge is cut at the edge',
  cropBox({ ...docked, left: -100 }, 1280, 800), { x: 0, y: 220, width: 200, height: 560 });
check('a frame running past the bottom is cut at the bottom',
  cropBox({ ...docked, top: 600 }, 1280, 800), { x: 960, y: 600, width: 300, height: 200 });
check('a frame entirely off the visible area has no box', cropBox({ ...docked, left: 1400 }, 1280, 800), null);
check('a screenshot with no size has no box', cropBox(docked, 0, 0), null);

console.log(`\n== RESULT ==\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
