import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'Browser Agent Copilot',
    description: 'A lightweight AI agent copilot that lives on every browser page.',
    version: '0.1.0',
    permissions: ['storage', 'activeTab'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Browser Agent Copilot'
    }
  },
  vite: () => ({
    resolve: {
      alias: {
        '@bac/shared': resolve(__dirname, '../../packages/shared/src/index.ts')
      }
    }
  })
});
