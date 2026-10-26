/*
The following file has the helpers for screenshots of the widget, kept in the study records
- where the widget sits in a screenshot of the tab
- cutting the widget out of that screenshot, so nothing else on the page is kept
*/

// The widget frame's box on the page, and the size of the page's visible area, in CSS pixels
export type FrameRect = { left: number; top: number; width: number; height: number; viewportWidth: number; viewportHeight: number };
export type CropBox = { x: number; y: number; width: number; height: number };

/*
The widget's box within a screenshot of the tab. The screenshot is the visible area at the screen's
pixel density, so the box is scaled by how much wider the image is than the visible area.
*/
export function cropBox(rect: FrameRect, imageWidth: number, imageHeight: number): CropBox | null {
  if (!rect.viewportWidth || !imageWidth) return null;
  const scale = imageWidth / rect.viewportWidth;
  const x = Math.max(0, Math.round(rect.left * scale));
  const y = Math.max(0, Math.round(rect.top * scale));
  const right = Math.min(imageWidth, Math.round((rect.left + rect.width) * scale));
  const bottom = Math.min(imageHeight, Math.round((rect.top + rect.height) * scale));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/*
Cuts the widget out of a screenshot of the tab, as a PNG data URL. Null when the widget is off the
visible area.
*/
export async function cropScreenshot(screenshot: string, rect: FrameRect): Promise<string | null> {
  const image = await createImageBitmap(await (await fetch(screenshot)).blob());
  const box = cropBox(rect, image.width, image.height);
  if (!box) return null;
  const canvas = new OffscreenCanvas(box.width, box.height);
  canvas.getContext('2d')?.drawImage(image, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}
