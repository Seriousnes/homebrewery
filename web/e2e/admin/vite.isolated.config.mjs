// The normal Vite config without file watching or HMR, for the admin e2e (web/e2e/admin): other
// agents' edits in the working tree would otherwise reload pages mid-test. Its own cacheDir, so it
// never re-optimizes the shared node_modules/.vite. run-admin.mjs starts it. Plain JS so no
// TypeScript project includes vite.config.ts through it.
import base from '../../vite.config.ts';

export default {
  ...base,
  cacheDir: 'node_modules/.vite-isolated-admin',
  server: { ...base.server, hmr: false, watch: null },
};
