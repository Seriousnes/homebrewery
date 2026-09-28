// The normal Vite config without file watching or HMR, for running the panels specs while other
// agents edit the working tree (their saves otherwise reload or break the page mid-test):
//   pnpm exec vite --config e2e/panels/vite.isolated.config.mjs --port 5324 --strictPort
//   E2E_PORT=5324 E2E_BASE_URL=http://localhost:5324 pnpm exec playwright test e2e/panels
// Not needed in CI, where nothing edits files during the run. Plain JS so that no TypeScript
// project includes vite.config.ts through it. Its own cacheDir: a different config hash would
// otherwise re-optimize the shared node_modules/.vite and reload every other dev server.
import base from '../../vite.config.ts';

export default {
  ...base,
  cacheDir: 'node_modules/.vite-isolated-panels',
  server: { ...base.server, hmr: false, watch: null },
};
