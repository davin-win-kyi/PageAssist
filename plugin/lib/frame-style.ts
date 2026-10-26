/*
This is the logic nessecary to apply and check the 
safety of a given widget
*/

// filter unsafe values which could be applied
export function isSafeStyleValue(value: string): boolean {
  const lower = value.toLowerCase();
  return !lower.includes('url(') && !lower.includes('expression(') && !lower.includes('javascript:') && !lower.includes('@import');
}

// Apply the style to the HTML element and filter unsafe values as well
export function applyStyle(element: HTMLElement, style: Record<string, unknown> | undefined) {
  if (!style) return;
  for (const [property, value] of Object.entries(style)) {
    if (typeof value !== 'string' || !isSafeStyleValue(value)) continue;
    try {
      element.style.setProperty(property, value);
    } catch {
    }
  }
}
