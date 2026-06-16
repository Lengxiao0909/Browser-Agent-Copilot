import { createApp } from 'vue';
import { createPinia } from 'pinia';
import type { BrowserActionRequest } from '@bac/shared';
import App from '../src/App.vue';
import cssText from '../src/styles/main.css?inline';
import { handleBrowserActionRequest } from '../src/utils/browserActions';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const existing = document.getElementById('browser-agent-copilot-root');
    if (existing) return;

    const host = document.createElement('div');
    host.id = 'browser-agent-copilot-root';
    host.style.height = '0';
    host.style.inset = '0 auto auto 0';
    host.style.pointerEvents = 'none';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483647';
    host.style.width = '0';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = cssText;
    const mountPoint = document.createElement('div');
    mountPoint.id = 'bac-shadow-app';

    shadow.append(style, mountPoint);
    document.documentElement.appendChild(host);

    const app = createApp(App);
    app.use(createPinia());
    app.mount(mountPoint);

    browser.runtime.onMessage.addListener((rawMessage: unknown) => {
      const message = rawMessage as { type?: string; request?: BrowserActionRequest };
      if (message.type !== 'bac-execute-browser-action' || !message.request) {
        return undefined;
      }

      return handleBrowserActionRequest(message.request);
    });
  }
});
