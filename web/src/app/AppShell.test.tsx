import { screen, waitFor, within } from '@testing-library/react';
import { Link, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyResponse, jsonResponse, mockApi } from '@/api/testing';
import { AppShell } from './AppShell';
import { NavbarPortal } from './NavbarPortal';
import { SitePage } from './SitePage';
import { renderRoute } from './testing';

afterEach(() => {
  vi.unstubAllGlobals();
});

function PageWithNavItems() {
  return (
    <SitePage title="Brew page">
      <NavbarPortal slot="title">My brew title</NavbarPortal>
      <NavbarPortal slot="items">
        <button type="button">Share</button>
      </NavbarPortal>
      <Link to="/other">Go elsewhere</Link>
    </SitePage>
  );
}

/** The shell with two child pages, as in the app's route table. */
function ShellWithPages() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="brew" element={<PageWithNavItems />} />
        <Route path="other" element={<SitePage title="Other page" />} />
      </Route>
    </Routes>
  );
}

function renderShell(url: string) {
  mockApi((request) => (request.path === '/api/notifications/active' ? jsonResponse([]) : emptyResponse(204)));
  return renderRoute(<ShellWithPages />, { url, path: '/*', me: null });
}

describe('AppShell', () => {
  it('renders the navbar and the page in <main>; pages fill the navbar slots', () => {
    renderShell('/brew');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(within(main).getByRole('heading', { level: 1, name: 'Brew page' })).toBeInTheDocument();
    expect(within(screen.getByTestId('navbar-title')).getByText('My brew title')).toBeInTheDocument();
    expect(within(screen.getByTestId('navbar-page-items')).getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(nav).toContainElement(screen.getByRole('button', { name: 'Share' }));
  });

  it('the skip link is the first tab stop and focuses <main> without changing the URL', async () => {
    const { user } = renderShell('/brew');
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
    expect(screen.getByTestId('location').textContent).toBe('/brew');
  });

  it('after navigating, focus goes to the new page heading; slots empty with the old page', async () => {
    const { user } = renderShell('/brew');
    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Other page' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.title).toBe('Other page - The Homebrewery');
    expect(screen.getByTestId('navbar-title')).toBeEmptyDOMElement();
    expect(screen.getByTestId('navbar-page-items')).toBeEmptyDOMElement();
  });

  it('does not move focus on the first render', () => {
    renderShell('/brew');
    expect(document.body).toHaveFocus();
  });
});
