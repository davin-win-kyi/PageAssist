import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'TaskWeb Studio',
    description: 'Author and patch webpage interfaces through linked representations.',
    // webNavigation is specifically needed for onHistoryStateUpdated — chrome.tabs.onUpdated does not
    // fire for single-page apps that change the URL via history.pushState (verified live).
    permissions: ['activeTab', 'storage', 'scripting', 'webNavigation'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Open TaskWeb Studio',
    },
    // Pages listed here run with the relaxed CSP Chrome grants sandboxed extension pages (permits
    // 'unsafe-eval', which the widget sandbox's one deliberate `new Function(...)` call needs) — the
    // tradeoff, which is exactly the point, is that a sandboxed page has zero access to chrome.* APIs at
    // all, on top of the opaque origin the <iframe sandbox="allow-scripts"> attribute itself gives it.
    sandbox: {
      pages: ['sandbox.html'],
    },
    // Needed so a content script running on an arbitrary real website (not the extension's own origin)
    // is allowed to load this extension page as an iframe src at all.
    web_accessible_resources: [
      {
        resources: ['sandbox.html'],
        matches: ['<all_urls>'],
      },
    ],
  },
});
