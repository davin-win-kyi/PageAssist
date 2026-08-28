type InterfaceNode = {
  component?: string;
  component_preferences?: Record<string, unknown>;
  children?: InterfaceNode[];
};

// Positioning and sizing are read verbatim from whatever the user/model authored — no fixed set of
// presets to fall back to. Each key is applied only if present; a single unobtrusive default covers
// the case where none were specified at all.
const POSITION_KEYS = ['top', 'right', 'bottom', 'left'] as const;
const KNOWN_PREFERENCE_KEYS = new Set<string>(['label', 'text', 'width', 'height', ...POSITION_KEYS]);

function titleCase(value: string): string {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderInterfaceNode(doc: Document, node: InterfaceNode, depth: number): HTMLElement {
  const preferences = node.component_preferences || {};
  const row = doc.createElement('div');
  row.className = 'taskweb-node';
  row.style.cssText = `margin:${depth === 0 ? '0' : '8px 0 0'};padding-left:${depth * 12}px;`;

  const label = doc.createElement('div');
  const labelText = preferences.label ?? preferences.text ?? (node.component ? titleCase(node.component) : 'Support');
  label.textContent = String(labelText);
  label.style.cssText = 'font-weight:600;font-size:13px;line-height:1.4;';
  row.appendChild(label);

  const extraEntries = Object.entries(preferences).filter(([key]) => !KNOWN_PREFERENCE_KEYS.has(key));
  if (extraEntries.length > 0) {
    const meta = doc.createElement('div');
    meta.style.cssText = 'font-size:11px;color:#8a8f98;margin-top:2px;';
    meta.textContent = extraEntries.map(([key, value]) => `${key}: ${value}`).join(' · ');
    row.appendChild(meta);
  }

  (node.children || []).forEach((child) => row.appendChild(renderInterfaceNode(doc, child, depth + 1)));
  return row;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const root = document.documentElement;
    let applyingInterface = false;
    let contextInvalidated = false;

    function teardownOnInvalidatedContext() {
      if (contextInvalidated) return;
      contextInvalidated = true;
      window.clearTimeout(mutationTimer);
      observer.disconnect();
      document.removeEventListener('input', handlePageChangeEvent, true);
      document.removeEventListener('change', handlePageChangeEvent, true);
      document.removeEventListener('click', handlePageChangeEvent, true);
    }

    function getPageElements() {
      return [...document.querySelectorAll('[id], [data-testid], button, input, textarea, form')].slice(0, 250).map((element, index) => ({
        id: element.id || `element-${index + 1}`,
        selector: element.id ? `#${element.id}` : element.tagName.toLowerCase(),
        tag: element.tagName.toLowerCase(),
        text: (element.textContent || '').trim().slice(0, 120),
      }));
    }

    window.addEventListener('taskweb:inspect', () => {
      window.postMessage({ source: 'taskweb-plugin', type: 'PAGE_ELEMENTS', elements: getPageElements() }, '*');
    });

    window.addEventListener('taskweb:apply-interface', (event) => {
      const tree = (event as CustomEvent).detail;
      if (tree) applyWebpageInterface(tree); else removeWebpageInterface();
      window.postMessage({ source: 'taskweb-plugin', type: 'INTERFACE_APPLIED', tree }, '*');
    });

    function removeWebpageInterface() {
      document.querySelector('iframe[data-taskweb-interface]')?.remove();
    }

    // The widget lives inside its own iframe document — a separate browsing context, so the host
    // page's stylesheets can never bleed into it (and vice versa). This is a genuine overlay, not
    // DOM embedded in the page.
    function ensureInterfaceFrame(): HTMLIFrameElement {
      const existing = document.querySelector('iframe[data-taskweb-interface]') as HTMLIFrameElement | null;
      if (existing) return existing;

      const frame = document.createElement('iframe');
      frame.setAttribute('data-taskweb-interface', 'true');
      frame.setAttribute('title', 'TaskWeb interface support');
      Object.assign(frame.style, {
        position: 'fixed', zIndex: '2147483647', border: '0', background: 'transparent',
        colorScheme: 'light',
      });
      document.body.appendChild(frame);

      const frameDocument = frame.contentDocument;
      if (frameDocument) {
        try {
          frameDocument.open();
          frameDocument.write(
            '<!doctype html><html><head><meta charset="utf-8"><style>' +
            'html,body{margin:0;height:100%;}' +
            'body{box-sizing:border-box;padding:16px;}' +
            '#taskweb-card{box-sizing:border-box;max-height:100%;overflow:auto;padding:14px 16px;' +
            'background:#fffdfa;color:#20211f;border:1px solid #dfddd5;border-radius:10px;' +
            'box-shadow:0 12px 32px rgba(0,0,0,.16);font:13px -apple-system,BlinkMacSystemFont,sans-serif;}' +
            '</style></head><body><div id="taskweb-card"></div></body></html>'
          );
          frameDocument.close();
        } catch (error) {
          console.error('TaskWeb: unable to write the interface overlay\'s document (page may restrict it)', error);
        }
      } else {
        console.error('TaskWeb: the overlay iframe has no accessible contentDocument on this page');
      }
      return frame;
    }

    function applyWebpageInterface(tree: InterfaceNode | null | undefined) {
      if (!tree) { removeWebpageInterface(); return; }
      applyingInterface = true;

      const frame = ensureInterfaceFrame();
      const frameDocument = frame.contentDocument;
      const card = frameDocument?.getElementById('taskweb-card');
      const preferences = tree.component_preferences || {};

      if (frameDocument && card) {
        card.replaceChildren(renderInterfaceNode(frameDocument, tree, 0));
      } else {
        console.error('TaskWeb: could not render into the overlay — missing contentDocument or #taskweb-card', { hasFrameDocument: !!frameDocument, hasCard: !!card });
      }

      const hasAnyPosition = POSITION_KEYS.some((key) => preferences[key] !== undefined);
      frame.style.top = '';
      frame.style.right = hasAnyPosition ? '' : '20px';
      frame.style.bottom = hasAnyPosition ? '' : '20px';
      frame.style.left = '';
      for (const key of POSITION_KEYS) {
        if (preferences[key] !== undefined) frame.style[key] = String(preferences[key]);
      }

      frame.style.width = preferences.width !== undefined ? String(preferences.width) : '300px';
      if (preferences.height !== undefined) {
        frame.style.height = String(preferences.height);
      } else if (card) {
        // Auto-size to content when the author didn't specify a height, capped so it can never
        // overwhelm the viewport; the card's own overflow:auto covers anything past that cap.
        frame.style.height = `${Math.min(card.scrollHeight + 32, window.innerHeight * 0.7)}px`;
      }

      applyingInterface = false;
    }

    let mutationTimer: number | undefined;
    let pendingMutations: MutationRecord[] = [];

    function getSelector(element: Element | null) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return 'document';
      if (element.id) return `#${element.id}`;
      if ((element as HTMLElement).dataset?.testid) return `[data-testid="${(element as HTMLElement).dataset.testid}"]`;
      return element.tagName.toLowerCase();
    }

    function describeMutation(mutation: MutationRecord) {
      const target = mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target as Element;
      return {
        type: mutation.type,
        target: getSelector(target),
        attribute: mutation.attributeName || null,
        oldValue: mutation.oldValue || null,
        addedNodes: mutation.addedNodes.length,
        removedNodes: mutation.removedNodes.length,
        text: mutation.type === 'characterData' ? mutation.target.textContent?.slice(0, 160) : null,
      };
    }

    function handlePageChange(mutations: MutationRecord[] = []) {
      if (applyingInterface || contextInvalidated) return;
      pendingMutations.push(...mutations);
      window.clearTimeout(mutationTimer);
      mutationTimer = window.setTimeout(() => {
        const pageElements = getPageElements();
        const activeElement = document.activeElement;
        const event = {
          type: 'page.changed',
          url: location.href,
          target: {
            title: document.title,
            forms: document.forms.length,
            selector: activeElement?.id ? `#${activeElement.id}` : activeElement?.tagName?.toLowerCase(),
          },
          payload: { elements: pageElements.length, mutations: pendingMutations.slice(0, 100).map(describeMutation) },
        };
        pendingMutations = [];
        if (globalThis.chrome?.runtime?.sendMessage) {
          try {
            globalThis.chrome.runtime.sendMessage({ source: 'taskweb-plugin', type: 'PAGE_CHANGED', event });
          } catch (_) {
            // The extension was reloaded/updated while this page was already open; stop trying.
            teardownOnInvalidatedContext();
          }
        }
        window.postMessage({ source: 'taskweb-plugin', type: 'PAGE_CHANGED', event }, '*');
      }, 400);
    }

    const handlePageChangeEvent = () => handlePageChange();

    // The widget's own content lives inside its iframe's separate document, invisible to this
    // observer by default — so unlike before, its updates can never self-trigger a "page changed"
    // loop. The one exception is the iframe *element* itself being inserted into the host page,
    // which the closest() checks below still exclude.
    const observer = new MutationObserver((mutations) => {
      const changedOutsideInterface = mutations.some((mutation) => {
        const targetElement = mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target;
        const target = targetElement instanceof Element ? targetElement : null;
        const addedOutsideInterface = [...mutation.addedNodes].some((node) => {
          return node.nodeType !== Node.ELEMENT_NODE || !(node as Element).closest('[data-taskweb-interface]');
        });
        const removedOutsideInterface = [...mutation.removedNodes].some((node) => {
          return node.nodeType !== Node.ELEMENT_NODE || !(node as Element).closest('[data-taskweb-interface]');
        });
        return !target?.closest('[data-taskweb-interface]') && (addedOutsideInterface || removedOutsideInterface || mutation.type === 'attributes');
      });
      const hasTextChange = mutations.some((mutation) => mutation.type === 'characterData');
      if (changedOutsideInterface || hasTextChange) handlePageChange(mutations);
    });

    function observeRoot(rootNode: Document | ShadowRoot) {
      observer.observe(rootNode, { childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
      rootNode.querySelectorAll?.('*').forEach((element) => {
        if (element.shadowRoot) observeRoot(element.shadowRoot);
        if (element.tagName === 'IFRAME' && !element.hasAttribute('data-taskweb-interface')) {
          try {
            const frameDocument = (element as HTMLIFrameElement).contentDocument;
            if (frameDocument) observeRoot(frameDocument);
          } catch (_) {
            // Cross-origin frames cannot be observed by the content script.
          }
        }
      });
    }

    observeRoot(document);
    document.querySelectorAll('iframe').forEach((frame) => frame.addEventListener('load', () => {
      try {
        if (frame.contentDocument) observeRoot(frame.contentDocument);
      } catch (_) {
        // Cross-origin frames cannot be observed by the content script.
      }
    }));
    document.addEventListener('input', handlePageChangeEvent, true);
    document.addEventListener('change', handlePageChangeEvent, true);
    document.addEventListener('click', handlePageChangeEvent, true);

    try {
      globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
        if (message?.type === 'APPLY_WEBPAGE_INTERFACE') {
          applyWebpageInterface(message.tree);
        } else if (message?.type === 'GET_PAGE_ELEMENTS') {
          sendResponse({ url: location.href, title: document.title, elements: getPageElements() });
        }
      });
    } catch (_) {
      teardownOnInvalidatedContext();
    }

    window.postMessage({ source: 'taskweb-plugin', type: 'READY', url: location.href }, '*');
    root.dataset.taskwebPlugin = 'connected';
  },
});
