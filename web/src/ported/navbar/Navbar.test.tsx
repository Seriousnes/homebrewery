import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyResponse, mockApi, problemResponse } from '@/api/testing';
import { clearRecentBrews, recordRecentBrew } from '@/app/recentBrews';
import { ADMIN, ALICE, renderRoute } from '@/app/testing';
import { clearToasts, toastStore } from '@/ui';
import { Navbar } from './Navbar';

afterEach(() => {
  vi.unstubAllGlobals();
  clearRecentBrews();
  clearToasts();
});

const nav = () => screen.getByRole('navigation', { name: 'Main' });
const location = () => screen.getByTestId('location').textContent;

describe('Navbar', () => {
  it('links home and to the vault; the vault link marks the current page', () => {
    renderRoute(<Navbar />, { url: '/vault', me: null });
    expect(within(nav()).getByRole('link', { name: 'The Homebrewery' })).toHaveAttribute('href', '/');
    const vault = within(nav()).getByRole('link', { name: 'Vault' });
    expect(vault).toHaveAttribute('href', '/vault');
    expect(vault).toHaveAttribute('aria-current', 'page');
  });

  it('signed out: "Sign in" returns to the current page', () => {
    renderRoute(<Navbar />, { url: '/edit/abc?x=1', me: null });
    expect(within(nav()).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnTo=%2Fedit%2Fabc%3Fx%3D1');
  });

  it('signed out on the sign-in page: no returnTo loop', () => {
    renderRoute(<Navbar />, { url: '/login?returnTo=%2Fvault', me: null });
    expect(within(nav()).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('signed in: the account disclosure lists the user pages and closes on Escape', async () => {
    const { user } = renderRoute(<Navbar />, { me: ALICE });
    const trigger = within(nav()).getByRole('button', { name: 'Account: alice' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('group', { name: 'Account' });
    expect(trigger).toHaveAttribute('aria-controls', panel.id);
    expect(within(panel).getByText(/Signed in as/)).toHaveTextContent('Signed in as alice');
    expect(within(panel).getByRole('link', { name: 'My brews' })).toHaveAttribute('href', '/user/alice');
    expect(within(panel).getByRole('link', { name: 'Account settings' })).toHaveAttribute('href', '/account');
    expect(within(panel).queryByRole('link', { name: 'Admin' })).toBeNull();
    // Opening focuses the first entry.
    expect(within(panel).getByRole('link', { name: 'My brews' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Account' })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('admins also get the admin link', async () => {
    const { user } = renderRoute(<Navbar />, { me: ADMIN });
    await user.click(within(nav()).getByRole('button', { name: 'Account: boss' }));
    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin');
  });

  it('keyboard: ArrowDown opens, arrows/Home/End move between entries', async () => {
    const { user } = renderRoute(<Navbar />, { me: ALICE });
    within(nav()).getByRole('button', { name: 'Account: alice' }).focus();
    await user.keyboard('{ArrowDown}');
    const panel = screen.getByRole('group', { name: 'Account' });
    const myBrews = within(panel).getByRole('link', { name: 'My brews' });
    const settings = within(panel).getByRole('link', { name: 'Account settings' });
    const signOut = within(panel).getByRole('button', { name: 'Sign out' });
    expect(myBrews).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(settings).toHaveFocus();
    await user.keyboard('{End}');
    expect(signOut).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(myBrews).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(signOut).toHaveFocus();
    await user.keyboard('{Home}');
    expect(myBrews).toHaveFocus();
  });

  it('following a link navigates and closes the panel', async () => {
    const { user } = renderRoute(<Navbar />, { me: ALICE });
    await user.click(within(nav()).getByRole('button', { name: 'Account: alice' }));
    await user.click(screen.getByRole('link', { name: 'Account settings' }));
    expect(location()).toBe('/account');
    expect(screen.queryByRole('group', { name: 'Account' })).toBeNull();
  });

  it('"Sign out" signs out, says so, and focuses the "Sign in" link', async () => {
    const api = mockApi((request) => (request.path === '/api/account/logout' ? emptyResponse(204) : emptyResponse(204)));
    const { user } = renderRoute(<Navbar />, { me: ALICE });
    await user.click(within(nav()).getByRole('button', { name: 'Account: alice' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const signIn = await within(nav()).findByRole('link', { name: 'Sign in' });
    await waitFor(() => expect(signIn).toHaveFocus());
    expect(api.requests.some((r) => r.method === 'POST' && r.path === '/api/account/logout')).toBe(true);
    expect(toastStore.getState().toasts.map((t) => t.title)).toContain("You're signed out.");
  });

  it('a sign-out whose session had already ended still signs out, without a prompt', async () => {
    mockApi(() => problemResponse(401, { title: 'Unauthorized' }));
    const { user } = renderRoute(<Navbar />, { me: ALICE });
    await user.click(within(nav()).getByRole('button', { name: 'Account: alice' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await within(nav()).findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull();
  });

  it.each([
    ['a sign-out', () => emptyResponse(204)],
    ['a sign-out whose session had already ended', () => problemResponse(401, { title: 'Unauthorized' })],
  ])('%s forgets the recent brews of this browser (a shared computer)', async (_name, answer) => {
    mockApi((request) => (request.path === '/api/account/logout' ? answer() : emptyResponse(204)));
    recordRecentBrew('edit', { id: 'editIdAAAA1', title: 'Alice secret draft' });
    recordRecentBrew('view', { id: 'shareIdAAA1', title: 'Seen by Alice' });
    const { user } = renderRoute(<Navbar />, { me: ALICE });
    await user.click(within(nav()).getByRole('button', { name: 'Account: alice' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await within(nav()).findByRole('link', { name: 'Sign in' });
    expect(localStorage.getItem('hb-recent-brews')).toBeNull();
    await user.click(within(nav()).getByRole('button', { name: 'Recent' }));
    expect(screen.getByRole('group', { name: 'Recent brews' })).toHaveTextContent('No recent brews yet.');
  });

  it('a failed sign-out keeps the account and shows a toast', async () => {
    mockApi(() => problemResponse(500, { title: 'Server error' }));
    const { user } = renderRoute(<Navbar />, { me: ALICE });
    await user.click(within(nav()).getByRole('button', { name: 'Account: alice' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(toastStore.getState().toasts.map((t) => t.title)).toContain("Couldn't sign out"));
    expect(within(nav()).getByRole('button', { name: 'Account: alice' })).toBeInTheDocument();
  });

  it('"New" offers a new brew and an import', async () => {
    const { user } = renderRoute(<Navbar />, { me: null });
    await user.click(within(nav()).getByRole('button', { name: 'New' }));
    const panel = screen.getByRole('group', { name: 'New brew' });
    expect(within(panel).getByRole('link', { name: /^New brew/ })).toHaveAttribute('href', '/new');
    expect(within(panel).getByRole('link', { name: /^Import a brew/ })).toHaveAttribute('href', '/import');
  });

  it('"Help" links open in a new tab without an opener', async () => {
    const { user } = renderRoute(<Navbar />, { me: null });
    await user.click(within(nav()).getByRole('button', { name: 'Help' }));
    const links = within(screen.getByRole('group', { name: 'Help' })).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual([
      expect.stringContaining('Report an issue'),
      expect.stringContaining('FAQ'),
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAccessibleName(expect.stringContaining('(opens in a new tab)'));
    }
  });

  describe('Recent', () => {
    it('says when there is nothing yet', async () => {
      const { user } = renderRoute(<Navbar />, { me: null });
      await user.click(within(nav()).getByRole('button', { name: 'Recent' }));
      expect(screen.getByRole('group', { name: 'Recent brews' })).toHaveTextContent('No recent brews yet.');
    });

    it('lists edited and viewed brews, newest first, and removes entries', async () => {
      const now = Date.now();
      recordRecentBrew('edit', { id: 'edit1', title: 'Older' }, now - 3 * 3600_000);
      recordRecentBrew('edit', { id: 'edit2', title: 'Newer' }, now - 60_000 * 5);
      recordRecentBrew('view', { id: 'share1', title: '' }, now - 86_400_000);
      const { user } = renderRoute(<Navbar />, { me: null });
      await user.click(within(nav()).getByRole('button', { name: 'Recent' }));
      const panel = screen.getByRole('group', { name: 'Recent brews' });
      const edited = within(panel).getByRole('region', { name: 'Edited' });
      const viewed = within(panel).getByRole('region', { name: 'Viewed' });
      const editedLinks = within(edited).getAllByRole('link');
      expect(editedLinks.map((a) => a.getAttribute('href'))).toEqual(['/edit/edit2', '/edit/edit1']);
      expect(editedLinks[0]).toHaveTextContent('Newer5 minutes ago');
      expect(within(viewed).getByRole('link')).toHaveAttribute('href', '/share/share1');
      expect(within(viewed).getByRole('link')).toHaveTextContent('Untitled brew');

      await user.click(within(edited).getByRole('button', { name: 'Remove Newer from recent brews' }));
      expect(within(edited).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/edit/edit1']);
      // Focus moves to the next entry's remove button.
      expect(within(edited).getByRole('button', { name: 'Remove Older from recent brews' })).toHaveFocus();
      await user.click(within(edited).getByRole('button', { name: 'Remove Older from recent brews' }));
      expect(within(panel).queryByRole('region', { name: 'Edited' })).toBeNull();
      // The panel stays open.
      expect(screen.getByRole('group', { name: 'Recent brews' })).toBeInTheDocument();
    });
  });
});
