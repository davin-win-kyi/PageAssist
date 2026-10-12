import { computeSelector, stableSelector } from './selectors.ts';
import { FIELD_NODE_SELECTOR, isInTransientLayer } from './page-scan.ts';

// this is to get the selector of an element
export function getSelector(element: Element | null): string {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return 'document';
  if (element.id) return `#${element.id}`;
  if ((element as HTMLElement).dataset?.testid) return `[data-testid="${(element as HTMLElement).dataset.testid}"]`;
  return element.tagName.toLowerCase();
}

/*
Return the correct element for the mutation that occured
*/
function targetElement(node: Node): Element | null {
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return (node as ShadowRoot).host ?? null;
  return node.parentElement;
}

/*
Removes anything that is not a form controls in that element
- it gets all of the changes from the mutation 
- and then it tries to look at the input element of the mutation, and 
  it will return that to the user
*/
function controlsIn(node: Element): Element[] {
  try {
    return [node, ...node.querySelectorAll(FIELD_NODE_SELECTOR)]
      .filter((control) => control.matches(FIELD_NODE_SELECTOR) && !isInTransientLayer(control));
  } catch {
    return [];
  }
}

// Get the ID of the removed element, this is also considered a mutation
function removedIdentity(element: Element): string | null {
  const selector = computeSelector(element);
  return selector === element.tagName.toLowerCase() ? null : selector;
}

const elementsOf = (nodes: NodeList): Element[] =>
  [...nodes].filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE);
const distinct = (selectors: (string | null)[]): string[] =>
  [...new Set(selectors.filter((s): s is string => !!s))].slice(0, 20);

/*
The following is used in order to determine how a mutation should be reported back to the user 
- and this is used to determine whether or not the interface should be updated or not 
*/
export function describeMutation(mutation: MutationRecord) {
  const target = targetElement(mutation.target);
  const added = elementsOf(mutation.addedNodes);
  const removed = elementsOf(mutation.removedNodes);
  const addedControls = added.flatMap(controlsIn);
  const removedControls = removed.flatMap(controlsIn);
  return {
    type: mutation.type,
    target: getSelector(target),
    // stable identities, matchable against the task representation's selectors: the controls inside an
    // added/removed subtree, then the subtree roots themselves
    targetSelector: target ? stableSelector(target) : null,
    addedSelectors: distinct([...addedControls, ...added].map(stableSelector)),
    removedSelectors: distinct([...removedControls, ...removed].map(removedIdentity)),
    attribute: mutation.attributeName || null,
    oldValue: mutation.oldValue || null,
    addedNodes: mutation.addedNodes.length,
    removedNodes: mutation.removedNodes.length,
    formControlsAdded: addedControls.length,
    formControlsRemoved: removedControls.length,
    text: mutation.type === 'characterData' ? mutation.target.textContent?.slice(0, 160) : null,
  };
}
