import { execSync } from 'node:child_process'

import { defineManifest } from '@crxjs/vite-plugin'

import pkg from './package.json' with { type: 'json' }

/** Where the app is served. `matches` is the ONLY thing that decides which origins this
 *  extension will talk to — both bridge ends then check against their own frame origin — so
 *  the dev server is added here and nowhere else, and only for a dev build.
 *
 *  `pnpm --filter extension build` (mode=production) therefore ships a manifest that knows
 *  about tripdesk and nothing else; the localhost entry cannot leak into a release. */
const PROD_ORIGIN = 'https://tripdesk.impo.ai/*'
/** Opt IN to the dev variant. The earlier `!== 'production'` was backwards: it made the
 *  localhost-bearing manifest the default, so any invocation that simply left NODE_ENV unset
 *  produced it — the exact leak the comment claimed was impossible. Widening the allowlist is
 *  the dangerous direction, so it now has to be asked for explicitly. */
const DEV = process.env.NODE_ENV === 'development'
const APP_ORIGINS = DEV
  ? [PROD_ORIGIN, 'http://localhost:4000/*', 'http://127.0.0.1:4000/*']
  : [PROD_ORIGIN]

// Fail the build rather than ship a manifest that talks to more than it should. Defaulting to
// production is not enough on its own: this is the assertion that makes the guarantee real.
if (!DEV && APP_ORIGINS.join() !== PROD_ORIGIN) {
  throw new Error(`production manifest must allow only ${PROD_ORIGIN}, got ${APP_ORIGINS.join()}`)
}

/** A build stamp, so "did my reload actually take?" is answerable at a glance.
 *
 *  `version` must be dot-separated numbers, which cannot say anything useful about a local
 *  rebuild. `version_name` is free text and is what chrome://extensions displays when present,
 *  so the commit and build time go there. It changes on every build even when the code did not,
 *  which is exactly the property needed: if the extensions page still shows the old stamp, the
 *  reload did not happen. */
function buildStamp(): string {
  let sha = 'nogit'
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* not a repo / git unavailable — the timestamp alone still moves */ }
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const when = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  return `${pkg.version} · ${sha} · ${when}${DEV ? ' · dev' : ''}`
}

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
  version_name: buildStamp(),
  minimum_chrome_version: '116',

  host_permissions: ['https://flights.ctrip.com/*', ...APP_ORIGINS],
  // `storage`: the service worker is recycled freely, so the pending tabId→nonce map has to
  // survive in chrome.storage.session rather than in a module-level variable.
  //
  // `debugger`: ONE use, and only as an escalation. A round trip's return fares do not exist
  // until an outbound is selected, and a plain `element.click()` carries `isTrusted: false`,
  // which Ctrip's handler sometimes ignores. Attaching the debugger lets that single click be
  // dispatched as a real mouse event. Chrome shows a prominent yellow "is debugging this
  // browser" bar for as long as it is attached — which is the honest outcome here, since an
  // extension IS driving the page; we attach for the click and detach immediately after.
  // It is never used to bypass a captcha, a login, or any check on who the operator is.
  permissions: ['storage', 'debugger'],

  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },

  content_scripts: [
    {
      // Observes the JSON the page fetches for itself. `MAIN` world because the hook has to
      // replace the PAGE's `fetch`/`XHR`, which an isolated world cannot reach, and
      // `document_start` because the search fires before `document_idle`.
      //
      // It reads what already arrived — it never issues a request or signs one. The DOM is a
      // partial projection of this JSON (4 rendered rows off a 25-flight response in an
      // unfocused window); this is the same data before it gets dropped.
      matches: ['https://flights.ctrip.com/*'],
      js: ['src/ctrip-net-probe.ts'],
      run_at: 'document_start',
      world: 'MAIN',
    },
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
      matches: APP_ORIGINS,
      js: ['src/tripdesk-content.ts'],
      all_frames: true,
      run_at: 'document_idle',
    },
  ],
})
