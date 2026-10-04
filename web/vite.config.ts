/// <reference types="vitest/config" />
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { generateAssetsPlugin } from './vite/generateAssetsPlugin.ts';
import { themeSnippetShims } from './vite/themeSnippetShims.ts';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webDir, '..');
const themesDir = path.join(repoRoot, 'themes');

// ASP.NET Core API in development (src/Homebrewery.Api/Properties/launchSettings.json, "http").
const apiTarget = process.env.HB_API_URL ?? 'http://localhost:5080';
// changeOrigin stays false: the Host header remains the Vite origin, so the API's same-origin
// write check sees Origin and Host agree and cookies are set for the Vite origin.
const apiProxy = { target: apiTarget, changeOrigin: false };

// Container development (./stack up, see docker-compose.yml): Vite works on a copy of the sources inside the
// container, which `docker compose watch` keeps in sync from the host, so Vite's native watcher works there too.
// The HMR client needs no port setting: it opens its websocket on the page's own host and port, whether the
// browser came through the published port or the router (<branch>.homebrewery.dev.localhost, deploy/stack/shared.yml).

export default defineConfig({
  plugins: [
    react(),
    generateAssetsPlugin({ themesDir }),
    // Theme snippet generators that can't run here → native shims; no marked-hbfm / expr-eval in
    // the production bundle (vite/themeSnippetShims.ts, snippets lane).
    ...themeSnippetShims({ themesDir, shimsDir: path.join(webDir, 'src/editor/snippets/shims') }),
  ],

  resolve: {
    alias: {
      '@themes': themesDir,
      '@': path.join(webDir, 'src'),
    },
    // Theme snippet generators (themes/V3/*/snippets.js) live outside web/ and import these
    // bare packages. There is no node_modules above themes/, so resolve them from web/.
    dedupe: ['lodash', 'dedent', 'marked-hbfm', 'marked', '@codemirror/view', '@codemirror/state'],
  },

  // Pre-bundle the theme generators' CommonJS dependencies at dev startup instead of on first
  // import, which would re-optimize and reload the page mid-session.
  optimizeDeps: {
    include: ['lodash', 'dedent', 'marked-hbfm'],
    // Scan every source module (lazy dev routes and editor code included) at startup, so TipTap,
    // dompurify and friends are pre-bundled before the first page load instead of triggering a
    // re-optimize + full reload the first time a lazy route imports them.
    entries: ['index.html', 'src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}', '!src/test/**'],
  },

  server: {
    // Transform the app, the lazily loaded editor and the dev harness pages at startup, so the first
    // page load (and every e2e test's first navigation) doesn't wait on on-demand transforms.
    warmup: {
      clientFiles: ['./src/main.tsx', './src/editor/EditorApp/EditorApp.tsx', './src/pages/*/index.tsx', './src/dev/*/route.tsx'],
    },
    port: 5173,
    strictPort: true,
    proxy: {
      '^/api(?:/|$)': apiProxy,
      '^/share(?:/|$)': apiProxy,
      '^/openapi(?:/|$)': apiProxy,
      '^/healthz(?:/|$)': apiProxy,
    },
    fs: {
      // web/ itself plus the shared theme sources imported through @themes.
      allow: [webDir, themesDir],
    },
  },

  // `vite preview` serves the built wwwroot with the same proxy (preview.proxy defaults to
  // server.proxy).
  preview: {
    port: 4173,
    strictPort: true,
  },

  build: {
    outDir: '../src/Homebrewery.Api/wwwroot',
    emptyOutDir: true,
    // Hashed bundles go to /static; /assets and /fonts hold the theme files (see
    // vite/generateAssetsPlugin.ts), whose URLs are fixed by the theme CSS.
    assetsDir: 'static',
  },

  test: {
    // Fail fast (CLAUDE.md "Tests fail fast"). Longer per-test values must pass the timeout guard
    // (scripts/testTimeouts.test.ts).
    testTimeout: 5_000,
    hookTimeout: 10_000,
    teardownTimeout: 5_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['vite/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
    ],
  },
});
