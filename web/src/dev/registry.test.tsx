import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DEV_ROUTES_ENABLED, routes } from '@/app/routes';
import { devPages } from './registry';

describe('dev route registry', () => {
  it('discovers web/src/dev/*/route.tsx pages', () => {
    const schema = devPages.find((p) => p.path === '/dev/schema');
    expect(schema?.file).toBe('./schema/route.tsx');
    for (const page of devPages) expect(page.path).toMatch(/^\/dev\/[\w-]+/);
  });

  it('mounts /dev in development builds and lists the pages', async () => {
    expect(DEV_ROUTES_ENABLED).toBe(true); // Vitest runs with import.meta.env.DEV
    const router = createMemoryRouter(routes, { initialEntries: ['/dev'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('link', { name: '/dev/schema' })).toBeInTheDocument();
  });
});
