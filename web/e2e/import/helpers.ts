// Shared by the import specs (fidelity, hbfmToDoc, toc), which drive dev harness pages
// (/dev/legacy-render, /dev/import, /dev/snippets).
import { test as base } from '@playwright/test';

/**
 * The specs' `test`: one browser context per worker, reset between tests (Playwright's
 * reuseContext: cookies, cache, storage, routes and init scripts cleared, viewport and colour
 * scheme applied again). The harness pages keep no other state, and a new context per test cost
 * Firefox 2-3 s of every test (module loading of a cold context).
 */
export const test = base.extend({ reuseContext: true });

/**
 * Navigations wait for the DOM, then for the page's own readiness signal (data-render-status). The
 * load event is no readiness signal here: Firefox holds it until the lazy route's whole module graph
 * (about 520 requests) is in, Chromium fires it after the entry's (about 130), so a goto waiting for
 * it did all of Firefox's loading inside the navigation timeout.
 */
export const DOM_READY = { waitUntil: 'domcontentloaded' } as const;
