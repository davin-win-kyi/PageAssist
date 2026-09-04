// Applies host-owned CSS to the widget's outer <iframe> frame (position/size only). The widget's own
// look lives in its sandboxed code — this is never applied to page content.

// Blocks constructs that could load external resources or execute code through CSS — a security
// boundary, not a restriction on which properties/values are allowed.
export function isSafeStyleValue(value: string): boolean {
  const lower = value.toLowerCase();
  return !lower.includes('url(') && !lower.includes('expression(') && !lower.includes('javascript:') && !lower.includes('@import');
}

export function applyStyle(element: HTMLElement, style: Record<string, unknown> | undefined) {
  if (!style) return;
  for (const [property, value] of Object.entries(style)) {
    if (typeof value !== 'string' || !isSafeStyleValue(value)) continue;
    try {
      element.style.setProperty(property, value);
    } catch {
      // Not a valid CSS property name/value — ignore rather than fail the whole render.
    }
  }
}
