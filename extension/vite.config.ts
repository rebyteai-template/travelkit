import { crx } from '@crxjs/vite-plugin'
import { defineConfig } from 'vite'

import manifest from './manifest.config.ts'

/** Builds to `extension/dist`, which nothing else reads. The app's own build writes to
 *  `../build` and `wrangler deploy` uploads only that, so the extension can never be
 *  swept into a deploy — `pnpm build` at the root does not recurse into workspace packages. */
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
