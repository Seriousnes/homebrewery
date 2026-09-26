// The admin pages (P7.4) over an in-memory admin API: access (anonymous, non-admin, admin),
// totals, user and brew lookups, lock tools with confirmations, the locks and review queue, and
// notifications CRUD with the live preview. Mutations are never optimistic: every change is
// checked after the server answered and the lists were fetched again.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '@/api';
import { problemResponse } from '@/api/testing';
import { ADMIN, ALICE, renderRoute, testQueryClient } from '@/app/testing';
import { clearToasts, toastStore } from '@/ui';
import AdminPage from './index';
import { adminBrew, adminUser, createAdminServer, notification, requestsTo } from './adminTesting';

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

function renderAdmin(url: string, me: AccountInfo | null = ADMIN, seed: Parameters<typeof createAdminServer>[0] = {}) {
  const server = createAdminServer({ me, ...seed });
  const notify = vi.fn();
  const view = renderRoute(<AdminPage />, { url, path: 'admin/*', me, client: testQueryClient(notify) });
  return { ...view, server, notify };
}

const toastTitles = () => toastStore.getState().toasts.map((t) => t.title);
const location = () => screen.getByTestId('location').textContent;

describe('access', () => {
  it('asks anonymous visitors to sign in, and requests nothing from the admin API', async () => {
    const { server } = renderAdmin('/admin', null);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in required' })).toBeInTheDocument();
    expect(requestsTo(server, 'GET', '/api/admin')).toEqual([]);
  });

  it('shows other accounts a 403 page', async () => {
    const { server } = renderAdmin('/admin/locks', ALICE);
    expect(await screen.findByRole('heading', { level: 1, name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByText('This page is only for administrators.')).toBeInTheDocument();
    expect(screen.getByText(/403/)).toBeInTheDocument();
    expect(requestsTo(server, 'GET', '/api/admin')).toEqual([]);
  });

  it('shows admins the overview with the site totals and the section links', async () => {
    renderAdmin('/admin', ADMIN, {
      users: [adminUser('alice'), adminUser('bob')],
      brews: [
        adminBrew('aaaa11112222'),
        adminBrew('bbbb11112222', { published: false }),
        adminBrew('cccc11112222', {
          lock: { code: 455, editMessage: 'Fix it', shareMessage: 'Locked', applied: '2026-09-21T10:00:00Z', reviewRequested: '2026-09-22T10:00:00Z' },
        }),
      ],
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Admin' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('admin-stat-brews-value')).toHaveTextContent('3'));
    expect(screen.getByTestId('admin-stat-publishedBrews-value')).toHaveTextContent('2');
    expect(screen.getByTestId('admin-stat-users-value')).toHaveTextContent('2');
    expect(screen.getByTestId('admin-stat-lockedBrews-value')).toHaveTextContent('1');
    expect(screen.getByTestId('admin-stat-pendingReviews-value')).toHaveTextContent('1');
    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Locks, 1 awaiting review' })).toHaveAttribute('href', '/admin/locks');
    expect(screen.getByRole('link', { name: 'Open the review queue' })).toHaveAttribute('href', '/admin/locks#review-queue');
    expect(document.title).toBe('Admin - The Homebrewery');
  });

  it('shows a failed load in place, with Try again', async () => {
    const server = createAdminServer({ me: ADMIN });
    server.override.set('GET /api/admin/locks', () => problemResponse(500, { title: 'Server error' }));
    const { user } = renderRoute(<AdminPage />, { url: '/admin/locks', path: 'admin/*', me: ADMIN });
    const error = await screen.findByTestId('admin-error');
    expect(error).toHaveTextContent("Couldn't load the locked brews");
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('admin-review-queue-empty')).toBeInTheDocument();
    server.override.delete('GET /api/admin/locks');
    await user.click(within(error).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('admin-locked-brews-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('admin-error')).toBeNull();
  });

  it('refreshes the totals on demand', async () => {
    const { user, server } = renderAdmin('/admin', ADMIN, { users: [adminUser('alice')] });
    await waitFor(() => expect(screen.getByTestId('admin-stat-users-value')).toHaveTextContent('1'));
    server.users = [...server.users, adminUser('bob')];
    await user.click(screen.getByTestId('admin-stats-refresh'));
    await waitFor(() => expect(screen.getByTestId('admin-stat-users-value')).toHaveTextContent('2'));
  });

  it('shows the not-found page for an unknown admin page', async () => {
    renderAdmin('/admin/nope');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('lookups', () => {
  it('quick lookups on the overview lead to the tools', async () => {
    const { user } = renderAdmin('/admin', ADMIN, { brews: [adminBrew('aaaa11112222')] });
    await user.click(screen.getByTestId('admin-quick-brew-submit'));
    expect(screen.getByTestId('admin-quick-brew')).toHaveAccessibleDescription(expect.stringContaining('Enter something to look for.'));
    await user.type(screen.getByTestId('admin-quick-brew'), ' edit-aaaa11112222 ');
    await user.click(screen.getByTestId('admin-quick-brew-submit'));
    await waitFor(() => expect(location()).toBe('/admin/brews/edit-aaaa11112222'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Brew aaaa11112222' })).toBeInTheDocument();
    expect(screen.getByTestId('admin-brew-search')).toHaveValue('edit-aaaa11112222');
  });

  it('searches accounts and opens one with every brew it has', async () => {
    const { user, server } = renderAdmin('/admin/users', ADMIN, {
      users: [
        adminUser('alice', { brewCount: 2, roles: ['Admin'] }),
        adminUser('alina', { emailConfirmed: false, lockoutEnd: new Date(Date.now() + 3_600_000).toISOString() }),
        adminUser('bob'),
      ],
      brews: [
        adminBrew('aaaa11112222', { title: 'Public brew' }),
        adminBrew('bbbb11112222', {
          title: 'Hidden brew',
          published: false,
          lock: { code: 456, editMessage: 'x', shareMessage: 'y', applied: '2026-09-21T10:00:00Z', reviewRequested: null },
        }),
      ],
    });
    const input = screen.getByTestId('admin-user-search');
    await user.click(screen.getByTestId('admin-user-search-submit'));
    expect(input).toHaveAccessibleDescription(expect.stringContaining('Enter part of a handle or email, or a user id.'));
    expect(input).toHaveFocus();
    expect(requestsTo(server, 'GET', '/api/admin/users')).toEqual([]);

    await user.type(input, 'ALI');
    await user.click(screen.getByTestId('admin-user-search-submit'));
    await waitFor(() => expect(location()).toBe('/admin/users?q=ALI'));
    expect(await screen.findByTestId('admin-user-count')).toHaveTextContent('2 accounts match “ALI”.');
    const rows = screen.getAllByTestId('admin-user-row');
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual(['alice', 'alina']);
    expect(rows[1]).toHaveTextContent('Not confirmed');
    expect(rows[1]).toHaveTextContent('Locked out until');
    expect(rows[0]).toHaveTextContent('Admin');

    await user.click(within(rows[0]!).getByRole('link', { name: 'alice' }));
    await waitFor(() => expect(location()).toBe('/admin/users/alice'));
    expect(screen.getByRole('heading', { level: 1, name: 'User alice' })).toBeInTheDocument();
    const details = await screen.findByTestId('admin-user-details');
    expect(details).toHaveTextContent('alice@example.test (confirmed)');
    expect(within(details).getByRole('link', { name: 'public brew list' })).toHaveAttribute('href', '/user/alice');
    const brewRows = await screen.findAllByTestId('admin-user-brew-row');
    expect(brewRows).toHaveLength(2);
    expect(brewRows[1]).toHaveTextContent('Unpublished');
    expect(brewRows[1]).toHaveTextContent('Locked');
    expect(within(brewRows[1]!).getByRole('link', { name: 'Hidden brew' })).toHaveAttribute('href', '/admin/brews/bbbb11112222');
    expect(screen.getByTestId('admin-user-brew-count')).toHaveTextContent('2 brews');
  });

  it('says when nothing matches', async () => {
    renderAdmin('/admin/users?q=zed', ADMIN, { users: [adminUser('alice')] });
    expect(screen.getByTestId('admin-user-search')).toHaveValue('zed');
    await waitFor(() => expect(screen.getByTestId('admin-user-count')).toHaveTextContent('No accounts match “zed”.'));
    expect(screen.queryByTestId('admin-user-results')).toBeNull();
  });

  it('says when an account does not exist', async () => {
    renderAdmin('/admin/users/ghost', ADMIN, { users: [adminUser('alice')] });
    expect(await screen.findByTestId('admin-user-missing')).toHaveTextContent('No account has the handle “ghost”.');
  });

  it('looks up a brew by share id, edit id or internal id, and says when there is none', async () => {
    const brew = adminBrew('aaaa11112222', {
      title: 'The Dragon',
      tags: ['dragons', 'lairs'],
      authors: [
        { handle: 'alice', role: 'owner' },
        { handle: 'bob', role: 'invited' },
      ],
    });
    const { user, notify } = renderAdmin(`/admin/brews/${brew.id}`, ADMIN, { brews: [brew] });
    const details = await screen.findByTestId('admin-brew-details');
    expect(within(details).getByRole('heading', { level: 2, name: 'The Dragon' })).toBeInTheDocument();
    expect(screen.getByTestId('admin-brew-share-id')).toHaveTextContent('aaaa11112222');
    expect(screen.getByTestId('admin-brew-edit-id')).toHaveTextContent('edit-aaaa11112222');
    expect(screen.getByTestId('admin-brew-authors')).toHaveTextContent('alice (owner), bob (invited)');
    expect(within(details).getByRole('link', { name: 'share page' })).toHaveAttribute('href', '/share/aaaa11112222');
    expect(details).toHaveTextContent('dragons, lairs');
    expect(screen.getByTestId('admin-lock-none')).toHaveTextContent('This brew is not locked.');

    const search = screen.getByTestId('admin-brew-search');
    await user.clear(search);
    await user.type(search, 'missing12345');
    await user.click(screen.getByTestId('admin-brew-search-submit'));
    expect(await screen.findByTestId('admin-brew-missing')).toHaveTextContent('No brew has the id “missing12345”.');
    expect(screen.getByTestId('admin-brew-status')).toHaveTextContent('No brew has the id “missing12345”.');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('lock tools', () => {
  const locked = (reviewRequested: string | null = null) =>
    adminBrew('aaaa11112222', {
      title: 'The Dragon',
      lock: { code: 456, editMessage: 'Remove the copied text.', shareMessage: 'Locked for review.', applied: '2026-09-21T10:00:00Z', reviewRequested },
    });

  it("locks with upstream's default code after a confirmation, then shows the lock the server stored", async () => {
    const { user, server } = renderAdmin('/admin/brews/aaaa11112222', ADMIN, { brews: [adminBrew('aaaa11112222', { title: 'The Dragon' })] });
    const form = await screen.findByTestId('admin-lock-form');
    const code = within(form).getByLabelText(/^Lock code/);
    expect(code).toHaveValue('455');
    expect(within(form).getByLabelText(/^Message to readers/)).toHaveValue('This Brew has been locked.');
    const authors = within(form).getByLabelText(/^Message to the authors/);
    expect(authors).toHaveValue('');

    // Client checks first: nothing is sent and the first bad field gets focus.
    await user.clear(code);
    await user.type(code, '99');
    await user.click(screen.getByTestId('admin-lock-submit'));
    expect(code).toHaveFocus();
    expect(code).toHaveAccessibleDescription(expect.stringContaining('The lock code is a number from 100 to 999.'));
    expect(authors).toHaveAccessibleDescription(expect.stringContaining('Tell the authors what to change'));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // A suggested code fills the field.
    await user.click(screen.getByText('Suggested codes'));
    await user.click(screen.getByTestId('admin-lock-code-455'));
    expect(code).toHaveValue('455');
    expect(screen.getByTestId('admin-lock-code-455')).toHaveAttribute('aria-pressed', 'true');
    await user.type(authors, 'Remove the copied text.');

    // Cancel sends nothing.
    await user.click(screen.getByTestId('admin-lock-submit'));
    let dialog = await screen.findByRole('alertdialog', { name: 'Lock this brew?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByTestId('admin-lock-submit')).toHaveFocus();
    expect(requestsTo(server, 'PUT', '/api/admin/brews')).toEqual([]);

    await user.click(screen.getByTestId('admin-lock-submit'));
    dialog = await screen.findByRole('alertdialog', { name: 'Lock this brew?' });
    await user.click(within(dialog).getByRole('button', { name: 'Lock brew' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(server.api.requests.find((r) => r.method === 'PUT')?.json).toEqual({
      code: 455,
      editMessage: 'Remove the copied text.',
      shareMessage: 'This Brew has been locked.',
    });
    expect(await screen.findByTestId('admin-lock-code')).toHaveTextContent('455 Generic lock');
    expect(screen.getByTestId('admin-brew-locked')).toBeInTheDocument();
    expect(screen.getByTestId('admin-lock-edit-message')).toHaveTextContent('Remove the copied text.');
    expect(screen.getByRole('heading', { level: 2, name: 'Lock' })).toHaveFocus();
    expect(screen.getByRole('heading', { level: 3, name: 'Change the lock' })).toBeInTheDocument();
    expect(toastTitles()).toContain('Brew locked');
    // The brew was fetched again after the lock (no optimistic state).
    expect(requestsTo(server, 'GET', '/api/admin/brews/aaaa11112222').length).toBeGreaterThanOrEqual(2);
  });

  it('shows field messages from the API on the fields', async () => {
    const { user, server } = renderAdmin('/admin/brews/aaaa11112222', ADMIN, { brews: [adminBrew('aaaa11112222')] });
    server.override.set('PUT /api/admin/brews/aaaa11112222/lock', () =>
      problemResponse(400, { title: 'One or more validation errors occurred.', errors: { shareMessage: ['is too offensive'] } }),
    );
    await user.type(await screen.findByLabelText(/^Message to the authors/), 'Fix it.');
    await user.click(screen.getByTestId('admin-lock-submit'));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Lock brew' }));
    const share = screen.getByLabelText(/^Message to readers/);
    await waitFor(() => expect(share).toHaveAccessibleDescription(expect.stringContaining('Message to readers is too offensive.')));
    await waitFor(() => expect(share).toHaveFocus());
  });

  it('changes an existing lock (prefilled with it) and clears the review request', async () => {
    const { user, server } = renderAdmin('/admin/brews/edit-aaaa11112222', ADMIN, { brews: [locked('2026-09-22T10:00:00Z')] });
    expect(await screen.findByTestId('admin-lock-code')).toHaveTextContent('456 Copyright issues');
    expect(screen.getByTestId('admin-lock-review')).toHaveTextContent('Requested');
    const form = screen.getByTestId('admin-lock-form');
    expect(within(form).getByLabelText(/^Lock code/)).toHaveValue('456');
    expect(within(form).getByLabelText(/^Message to the authors/)).toHaveValue('Remove the copied text.');
    await user.clear(within(form).getByLabelText(/^Message to readers/));
    await user.type(within(form).getByLabelText(/^Message to readers/), 'Still locked.');
    await user.click(screen.getByTestId('admin-lock-submit'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Change the lock?' });
    await user.click(within(dialog).getByRole('button', { name: 'Update lock' }));
    await waitFor(() => expect(screen.getByTestId('admin-lock-share-message')).toHaveTextContent('Still locked.'));
    expect(screen.getByTestId('admin-lock-review')).toHaveTextContent('Not requested');
    expect(server.brews[0]!.lock?.reviewRequested).toBeNull();
  });

  it('dismisses a review request and unlocks, each after a confirmation', async () => {
    const { user, server } = renderAdmin('/admin/brews/aaaa11112222', ADMIN, { brews: [locked('2026-09-22T10:00:00Z')] });
    await user.click(await screen.findByTestId('admin-dismiss-review'));
    let dialog = await screen.findByRole('alertdialog', { name: 'Dismiss the review request?' });
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss request' }));
    await waitFor(() => expect(screen.getByTestId('admin-lock-review')).toHaveTextContent('Not requested'));
    expect(screen.queryByTestId('admin-dismiss-review')).toBeNull();
    expect(screen.getByTestId('admin-lock-code')).toBeInTheDocument();
    expect(requestsTo(server, 'DELETE', '/api/admin/brews/aaaa11112222/lock/review')).toEqual(['DELETE /api/admin/brews/aaaa11112222/lock/review 200']);

    // Escape cancels.
    await user.click(screen.getByTestId('admin-unlock'));
    await screen.findByRole('alertdialog', { name: 'Unlock this brew?' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByTestId('admin-unlock')).toHaveFocus();

    await user.click(screen.getByTestId('admin-unlock'));
    dialog = await screen.findByRole('alertdialog', { name: 'Unlock this brew?' });
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(screen.getByTestId('admin-lock-none')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 2, name: 'Lock' })).toHaveFocus();
    expect(screen.getByLabelText(/^Lock code/)).toHaveValue('455');
    expect(toastTitles()).toEqual(expect.arrayContaining(['Review request dismissed', 'Brew unlocked']));
  });

  it('refetches after a failed action (another admin got there first)', async () => {
    const { user, server } = renderAdmin('/admin/brews/aaaa11112222', ADMIN, { brews: [locked('2026-09-22T10:00:00Z')] });
    await screen.findByTestId('admin-dismiss-review');
    // Meanwhile someone else unlocked it.
    server.brews = server.brews.map((b) => ({ ...b, lock: null }));
    await user.click(screen.getByTestId('admin-dismiss-review'));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Dismiss request' }));
    await waitFor(() => expect(screen.getByTestId('admin-lock-none')).toBeInTheDocument());
    expect(toastTitles()).toContain("Couldn't dismiss the review request");
  });
});

describe('locks page', () => {
  const lockOf = (applied: string, reviewRequested: string | null = null) => ({
    code: 455,
    editMessage: 'Fix it',
    shareMessage: 'Locked',
    applied,
    reviewRequested,
  });

  it('lists the review queue (oldest request first) and every locked brew, with row actions', async () => {
    const { user, server } = renderAdmin('/admin/locks', ADMIN, {
      brews: [
        adminBrew('aaaa11112222', { title: 'Old request', lock: lockOf('2026-09-01T10:00:00Z', '2026-09-03T10:00:00Z') }),
        adminBrew('bbbb11112222', { title: 'New request', lock: lockOf('2026-09-05T10:00:00Z', '2026-09-02T10:00:00Z') }),
        adminBrew('cccc11112222', { title: 'Plain lock', lock: lockOf('2026-09-10T10:00:00Z') }),
        adminBrew('dddd11112222', { title: 'Not locked' }),
      ],
    });
    const queue = await screen.findByTestId('admin-review-queue-table');
    const queueTitles = () => within(queue).getAllByRole('rowheader').map((cell) => within(cell).getByRole('link').textContent);
    expect(queueTitles()).toEqual(['New request', 'Old request']);
    const locks = screen.getByTestId('admin-locked-brews-table');
    expect(within(locks).getAllByRole('rowheader').map((cell) => within(cell).getByRole('link').textContent)).toEqual([
      'Plain lock',
      'New request',
      'Old request',
    ]);
    expect(within(locks).getAllByRole('row')[1]).toHaveTextContent('455 Generic lock');
    expect(screen.getByRole('heading', { level: 2, name: /Review queue/ })).toHaveTextContent('Review queue (2)');

    // Dismiss from the queue: the brew leaves the queue but stays locked.
    await user.click(within(queue).getByRole('button', { name: 'Dismiss request for New request' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Dismiss request' }));
    await waitFor(() => expect(queueTitles()).toEqual(['Old request']));
    expect(screen.getByRole('heading', { level: 2, name: /Review queue/ })).toHaveFocus();
    expect(within(screen.getByTestId('admin-locked-brews-table')).getAllByRole('rowheader')).toHaveLength(3);

    // Unlock from the locked list, cancelled first.
    const lockedTable = screen.getByTestId('admin-locked-brews-table');
    await user.click(within(lockedTable).getByRole('button', { name: 'Unlock Plain lock' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(requestsTo(server, 'DELETE', '/api/admin/brews/cccc11112222/lock')).toEqual([]);
    await user.click(within(lockedTable).getByRole('button', { name: 'Unlock Plain lock' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(within(screen.getByTestId('admin-locked-brews-table')).getAllByRole('rowheader')).toHaveLength(2));
    expect(screen.getByRole('heading', { level: 2, name: /Locked brews/ })).toHaveFocus();
    // The navigation badge follows the stats, fetched again after each change.
    await waitFor(() => expect(screen.getByTestId('admin-nav-reviews')).toHaveTextContent('1'));
  });

  it('fetches the totals again whenever an admin page opens, so the review badge is current', async () => {
    const { user, server } = renderAdmin('/admin/users', ADMIN, { brews: [adminBrew('aaaa11112222', { lock: lockOf('2026-09-01T10:00:00Z') })] });
    await waitFor(() => expect(requestsTo(server, 'GET', '/api/admin/stats')).toHaveLength(1));
    expect(screen.queryByTestId('admin-nav-reviews')).toBeNull();
    // An author asks for a review meanwhile (the test client never treats data as stale by itself).
    server.brews = server.brews.map((b) => ({ ...b, lock: { ...b.lock!, reviewRequested: '2026-09-02T10:00:00Z' } }));
    const nav = () => screen.getByRole('navigation', { name: 'Admin sections' });
    await user.click(within(nav()).getByRole('link', { name: 'Brews' }));
    await waitFor(() => expect(screen.getByTestId('admin-nav-reviews')).toHaveTextContent('1'));
    expect(within(nav()).getByRole('link', { name: 'Locks, 1 awaiting review' })).toHaveAttribute('href', '/admin/locks');
    expect(screen.getByTestId('admin-nav-reviews')).toHaveAttribute('aria-hidden', 'true');
  });

  it('says when nothing is locked or awaiting review, and focuses the queue from the overview link', async () => {
    renderAdmin('/admin/locks#review-queue');
    expect(await screen.findByTestId('admin-review-queue-empty')).toHaveTextContent('No brews are awaiting review.');
    expect(await screen.findByTestId('admin-locked-brews-empty')).toHaveTextContent('No brews are locked.');
    expect(screen.getByRole('heading', { level: 2, name: /Review queue/ })).toHaveFocus();
  });
});

describe('notifications', () => {
  it('lists notifications with their state', async () => {
    const now = Date.now();
    renderAdmin('/admin/notifications', ADMIN, {
      notifications: [
        notification('n1', { title: 'Live' }),
        notification('n2', { title: 'Later', startsAt: new Date(now + 3_600_000).toISOString(), stopsAt: new Date(now + 7_200_000).toISOString() }),
        notification('n3', { title: 'Over', startsAt: new Date(now - 7_200_000).toISOString(), stopsAt: new Date(now - 3_600_000).toISOString() }),
      ],
    });
    const rows = await screen.findAllByTestId('admin-notification-row');
    const byTitle = (title: string) => rows.find((row) => within(row).getByRole('rowheader').textContent === title)!;
    expect(byTitle('Live')).toHaveTextContent('Showing now');
    expect(byTitle('Later')).toHaveTextContent('Scheduled');
    expect(byTitle('Over')).toHaveTextContent('Ended');
    expect(within(byTitle('Live')).getByRole('link', { name: 'Edit Live' })).toHaveAttribute('href', '/admin/notifications/n1');
  });

  it('creates one with a live preview, and shows a taken dismiss key on its field', async () => {
    const { user, server } = renderAdmin('/admin/notifications', ADMIN, { notifications: [notification('n1', { dismissKey: 'taken' })] });
    expect(await screen.findAllByTestId('admin-notification-row')).toHaveLength(1);
    await user.click(screen.getByTestId('admin-notification-new'));
    await waitFor(() => expect(location()).toBe('/admin/notifications/new'));
    expect(screen.getByRole('heading', { level: 1, name: 'New notification' })).toBeInTheDocument();
    expect(screen.getByTestId('admin-preview-title')).toHaveTextContent('The title goes here');
    expect(screen.getByTestId('admin-preview-when')).toHaveTextContent('Showing now.');

    // Empty form: client messages, first field focused, nothing sent.
    await user.click(screen.getByTestId('admin-notification-save'));
    expect(screen.getByTestId('admin-notification-key')).toHaveFocus();
    expect(screen.getByTestId('admin-notification-title')).toHaveAccessibleDescription(expect.stringContaining('Enter a title.'));
    expect(requestsTo(server, 'POST', '/api/admin/notifications')).toEqual([]);

    await user.type(screen.getByTestId('admin-notification-key'), 'taken');
    await user.type(screen.getByTestId('admin-notification-title'), 'Maintenance');
    await user.type(screen.getByTestId('admin-notification-body'), 'Off at 10.{Enter}Back soon.');
    expect(screen.getByTestId('admin-preview-title')).toHaveTextContent('Maintenance');
    expect(screen.getByTestId('admin-preview-body').textContent).toBe('Off at 10.\nBack soon.');

    await user.click(screen.getByTestId('admin-notification-save'));
    const key = screen.getByTestId('admin-notification-key');
    await waitFor(() => expect(key).toHaveAccessibleDescription(expect.stringContaining("Another notification uses the dismiss key 'taken'.")));
    expect(key).toHaveFocus();

    await user.clear(key);
    await user.type(key, 'maint-9');
    await user.click(screen.getByTestId('admin-notification-save'));
    await waitFor(() => expect(location()).toBe('/admin/notifications'));
    const created = server.api.requests.filter((r) => r.method === 'POST').at(-1)!.json as Record<string, unknown>;
    expect(created).toMatchObject({ dismissKey: 'maint-9', title: 'Maintenance', body: 'Off at 10.\nBack soon.' });
    expect(typeof created.startsAt).toBe('string');
    // The list was fetched again before the form navigated back: no stale list first.
    expect(screen.getAllByTestId('admin-notification-row')).toHaveLength(2);
    expect(toastTitles()).toContain('Notification created');
  });

  it('edits one and keeps untouched times as stored', async () => {
    const stored = notification('n1', { title: 'Old title', startsAt: '2026-09-20T10:00:30.500Z', stopsAt: '2099-01-01T00:00:45Z' });
    const { user, server } = renderAdmin('/admin/notifications/n1', ADMIN, { notifications: [stored] });
    const title = await screen.findByTestId('admin-notification-title');
    expect(screen.getByRole('heading', { level: 1, name: 'Edit notification' })).toBeInTheDocument();
    expect(title).toHaveValue('Old title');
    expect(screen.getByTestId('admin-preview-when')).toHaveTextContent('Showing now.');
    await user.clear(title);
    await user.type(title, 'New title');
    expect(screen.getByTestId('admin-preview-title')).toHaveTextContent('New title');
    await user.click(screen.getByTestId('admin-notification-save'));
    await waitFor(() => expect(location()).toBe('/admin/notifications'));
    expect(server.api.requests.find((r) => r.method === 'PUT')?.json).toEqual({
      dismissKey: 'key-n1',
      title: 'New title',
      body: '',
      startsAt: stored.startsAt,
      stopsAt: stored.stopsAt,
    });
    expect(await screen.findByRole('link', { name: 'New title' })).toBeInTheDocument();
  });

  it('deletes from the list and from the form, each after a confirmation', async () => {
    const { user, server } = renderAdmin('/admin/notifications', ADMIN, {
      notifications: [notification('n1', { title: 'First' }), notification('n2', { title: 'Second' })],
    });
    await user.click(await screen.findByRole('button', { name: 'Delete First' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this notification?' });
    expect(dialog).toHaveTextContent('“First” (key-n1)');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByTestId('admin-notification-row')).toHaveLength(1));
    expect(screen.getByRole('heading', { level: 2, name: 'All notifications' })).toHaveFocus();

    await user.click(screen.getByRole('link', { name: 'Edit Second' }));
    await user.click(await screen.findByTestId('admin-notification-delete'));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(location()).toBe('/admin/notifications'));
    expect(await screen.findByTestId('admin-notifications-empty')).toBeInTheDocument();
    expect(requestsTo(server, 'DELETE', '/api/admin/notifications')).toHaveLength(2);
    // The deleted notification was not asked for again.
    expect(requestsTo(server, 'GET', '/api/admin/notifications/n2').every((line) => line.endsWith('200'))).toBe(true);
  });

  it('says when a notification does not exist', async () => {
    renderAdmin('/admin/notifications/0190-missing');
    expect(await screen.findByTestId('admin-notification-missing')).toBeInTheDocument();
  });
});
