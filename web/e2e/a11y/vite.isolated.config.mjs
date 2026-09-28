// The normal Vite config without file watching or HMR, for the accessibility specs (web/e2e/a11y)
// while other agents edit the working tree (their saves would otherwise reload the page mid-scan):
//   pnpm exec vite --config e2e/a11y/vite.isolated.config.mjs --port 5376 --strictPort
//   E2E_PORT=5376 E2E_BASE_URL=http://localhost:5376 pnpm exec playwright test e2e/a11y
// (Firefox on a loaded machine: E2E_WORKERS=2 or 3.) Without E2E_BASE_URL, Playwright starts the
// normal dev server itself; the specs need no API server (fakeApi.ts). Its own cacheDir: a
// different config hash would otherwise re-optimize the shared node_modules/.vite and reload every
// other dev server. Plain JS so that no TypeScript project includes vite.config.ts through it.
// Restart it after editing the app (no file watching).
import base from '../../vite.config.ts';

export default {
  ...base,
  cacheDir: 'node_modules/.vite-isolated-a11y',
  server: { ...base.server, hmr: false, watch: null },
};
