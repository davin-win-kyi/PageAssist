// Turns a MutationRecord into the compact JSON shape the backend / panel reason about when deciding
// whether a page change is structural and task-relevant. Pure.
import { computeSelector } from './selectors.ts';

// A short, human-ish selector for a mutation target (logging / coarse identity). Distinct from
// computeSelector — this one is lossy on purpose and never used for lookup.
export function getSelector(element: Element | null): string {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return 'document';
  if (element.id) return `#${element.id}`;
  if ((element as HTMLElement).dataset?.testid) return `[data-testid="${(element as HTMLElement).dataset.testid}"]`;
  return element.tagName.toLowerCase();
}

// Does this node, or anything in its subtree, look like a form control? A sharper "structural change
// relevant to the task" signal than a raw node count. Includes class-only custom widgets (a revealed
// react-select / div.select_container is a single node with no ARIA role). Nodes inside an open
// dropdown/popover are excluded — their appearance is an expansion, not new page structure.
export const FORM_CONTROL_SELECTOR = 'input, textarea, select, [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [contenteditable="true"], [class*="select" i], [class*="dropdown" i], [class*="combobox" i]';
const POPUP_SELECTOR = '[role="listbox"], [role="menu"], [role="tooltip"], [aria-modal="true"], [class*="menu" i], [class*="popover" i], [class*="popup" i], [class*="tooltip" i], [class*="option-list" i], [class*="options-list" i]';
export function containsFormControl(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  try {
    if (element.closest?.(POPUP_SELECTOR)) return false;
    return !!element.matches?.(FORM_CONTROL_SELECTOR) || !!element.querySelector?.(FORM_CONTROL_SELECTOR);
  } catch {
    return false;
  }
}

export function describeMutation(mutation: MutationRecord) {
  const target = mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target as Element;
  // Selectors of added element nodes (same computeSelector() used for analysis), so the backend can
  // tell whether a change touched an element the current task representation actually tracks.
  const addedSelectors = [...mutation.addedNodes]
    .filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE)
    .slice(0, 10)
    .map(computeSelector);
  return {
    type: mutation.type,
    target: getSelector(target),
    targetSelector: target ? computeSelector(target) : null,
    addedSelectors,
    attribute: mutation.attributeName || null,
    oldValue: mutation.oldValue || null,
    addedNodes: mutation.addedNodes.length,
    removedNodes: mutation.removedNodes.length,
    formControlsAdded: [...mutation.addedNodes].filter(containsFormControl).length,
    formControlsRemoved: [...mutation.removedNodes].filter(containsFormControl).length,
    text: mutation.type === 'characterData' ? mutation.target.textContent?.slice(0, 160) : null,
  };
}
