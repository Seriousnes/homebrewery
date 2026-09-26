// Dev-only pages for the editor lanes (harnesses, measurements, fixtures).
//
// Adding a page: create web/src/dev/<name>/route.tsx that exports
//
//   export const path = '/dev/<name>';          // must start with /dev/
//   export const element = <MyDevPage />;        // the component lives in its own file
//   export const title = 'What this page shows'; // optional, shown on /dev
//
// (Only non-component exports in route.tsx, so react-refresh/only-export-components is happy.)
// Pages are discovered at build time. web/src/app/routes.tsx mounts them under /dev/* (lazily,
// through DevRoutes.tsx) only when DEV_ROUTES_ENABLED: the Vite dev server (import.meta.env.DEV,
// which is what Playwright runs against by default) or a build with VITE_HB_DEV_ROUTES=1 (e.g.
// for E2E_PREVIEW runs). Production builds don't contain this code.
import type { ReactElement } from 'react';

/** The exports of a web/src/dev/<name>/route.tsx module. */
export interface DevRouteModule {
  path: string;
  element: ReactElement;
  title?: string;
}

export interface DevPage extends DevRouteModule {
  /** The route.tsx file, for error messages and the index. */
  file: string;
}

const modules = import.meta.glob<DevRouteModule>('./*/route.tsx', { eager: true });

const DEV_PATH = /^\/dev\/[\w-]+(?:\/[\w-]+)*$/;

function toDevPage(file: string, module: Partial<DevRouteModule>): DevPage {
  if (typeof module.path !== 'string' || !DEV_PATH.test(module.path)) {
    throw new Error(`${file}: export const path = '/dev/<name>' (got ${String(module.path)})`);
  }
  if (!module.element) throw new Error(`${file}: export const element = <Page />`);
  return { file, path: module.path, element: module.element, ...(module.title ? { title: module.title } : {}) };
}

/** Every dev page, sorted by path. */
export const devPages: DevPage[] = Object.entries(modules)
  .map(([file, module]) => toDevPage(file, module))
  .sort((a, b) => a.path.localeCompare(b.path));
