// The normal Vite config without file watching or HMR, for the §4.11 matrix, the full-suite runs
// (e2e/matrix/run-suite.mjs) and long runs such as scripts/fidelity-run.ts while other people or
// agents edit the working tree (their saves would otherwise reload pages mid-test):
//   pnpm exec vite --config e2e/matrix/vite.isolated.config.mjs --port 5374 --strictPort
//   E2E_PORT=5374 E2E_BASE_URL=http://localhost:5374 pnpm exec playwright test e2e/matrix
// Each port gets its own cacheDir, so two of these servers (or the normal dev server) never
// re-optimize, and so reload, each other's dependencies.
// Plain JS so that no TypeScript project includes vite.config.ts through it.
import base from '../../vite.config.ts';

const portFlag = process.argv.indexOf('--port');
const port = portFlag >= 0 ? process.argv[portFlag + 1] : 'default';

export default {
  ...base,
  cacheDir: `node_modules/.vite-isolated-${port}`,
  server: { ...base.server, hmr: false, watch: null },
};
