import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'TaskWeb Studio',
    description: 'Author and patch webpage interfaces through linked representations.',
    permissions: ['activeTab', 'storage', 'scripting'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Open TaskWeb Studio',
    },
  },
});
