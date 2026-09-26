// The normal Vite config without file watching or HMR, for the list page e2e specs (web/e2e/lists)
// while other agents edit the working tree (their saves would otherwise reload pages mid-test).
// Its own cacheDir, so it never re-optimizes another server's dependency cache. Plain JS so that
// no TypeScript project includes vite.config.ts through it. run-lists.mjs starts it.
import base from '../../vite.config.ts';

export default {
  ...base,
  cacheDir: 'node_modules/.vite-isolated-lists',
  server: { ...base.server, hmr: false, watch: null },
};
