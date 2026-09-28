// The normal Vite config without file watching or HMR, for the end-to-end flows (and
// scripts/welcome-doc.ts) while other agents edit the working tree (their saves would otherwise
// reload the page mid-test):
//   pnpm exec vite --config e2e/flows/vite.isolated.config.mjs --port 5329 --strictPort
//   E2E_PORT=5329 E2E_BASE_URL=http://localhost:5329 pnpm exec playwright test e2e/flows
// e2e/flows/run-flows.mjs starts it (and a private API) for you. Its own cacheDir: a different
// config hash would otherwise re-optimize the shared node_modules/.vite and reload every other dev
// server. Plain JS so that no TypeScript project includes vite.config.ts through it.
import base from '../../vite.config.ts';

export default {
  ...base,
  cacheDir: 'node_modules/.vite-isolated-flows',
  server: { ...base.server, hmr: false, watch: null },
};
