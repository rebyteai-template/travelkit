import { defineManifest } from '@crxjs/vite-plugin'

import pkg from './package.json' with { type: 'json' }

/**
 * Least privilege, deliberately.
 *
 * No `"tabs"` permission: `chrome.tabs.create()` does not need one, and reading the created
 * tab's URL is already covered by the ctrip host permission. Asking for `"tabs"` would grant
 * visibility into every tab the operator has open, for nothing.
 *
 * No `<all_urls>`, and exactly two hosts. Anything wider would put this extension in a position
 * to read pages it has no business reading — on a machine we do not own.
 *
 * The tripdesk content script is a BRIDGE ONLY. It relays messages between the SPA and the
 * service worker and must never touch `sessionStorage`, which is where the app keeps the real
 * travelkit credential. Nothing in this extension ever holds a credential: it scrapes public
 * prices and hands them to the SPA, which does the authenticated write itself.
 */
export default defineManifest({
  manifest_version: 3,
  name: 'TravelKit 携程比价',
  description: '在你自己的浏览器里读取携程价格，回填到 TravelKit 推荐表，省去来回切换标签页。',
  version: pkg.version,
  minimum_chrome_version: '116',

  host_permissions: [
    'https://flights.ctrip.com/*',
    'https://tripdesk.impo.ai/*',
  ],
  // `storage` only — the service worker is recycled freely, so the pending tabId→nonce map has
  // to survive in chrome.storage.session rather than in a module-level variable.
  permissions: ['storage'],

  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },

  content_scripts: [
    {
      // Reads the fare list. `document_idle` is only the starting gun — the list is lazily
      // rendered and the script waits for it itself (see ctrip-content.ts).
      matches: ['https://flights.ctrip.com/*'],
      js: ['src/ctrip-content.ts'],
      run_at: 'document_idle',
    },
    {
      // `all_frames` because TravelKit runs as an iframe inside a customer page whose domain we
      // do not know. Content scripts match on each frame's OWN url, so this injects reliably
      // wherever the app is embedded — which is exactly why the bridge is a content script and
      // not `externally_connectable` (that would additionally require the unknown top-frame
      // origin in `matches`, so it cannot work here at all).
      matches: ['https://tripdesk.impo.ai/*'],
      js: ['src/tripdesk-content.ts'],
      all_frames: true,
      run_at: 'document_idle',
    },
  ],
})
