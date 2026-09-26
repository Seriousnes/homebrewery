// The normal Vite config without file watching or HMR, for the performance e2e (web/e2e/perf):
// other agents' saves would otherwise reload the page in the middle of a measurement. Its own
// dependency cache, so a different config hash doesn't re-optimize the shared node_modules/.vite.
// Plain JS so that no TypeScript project includes vite.config.ts through it. run-perf.mjs uses it.
import base from '../../vite.config.ts';

export default {
  ...base,
  cacheDir: 'node_modules/.vite-isolated-perf',
  server: { ...base.server, hmr: false, watch: null },
};
