import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { BrewSummary } from '@/api';
import { summary } from '@/ported/listPage/testing';
import { BrewItem, type BrewItemProps } from './BrewItem';

const NOW = Date.parse('2026-03-10T12:00:00Z');

function renderItem(brew: BrewSummary, props: Partial<BrewItemProps> = {}) {
  return render(
    <MemoryRouter>
      <BrewItem brew={brew} now={NOW} {...props} />
    </MemoryRouter>,
  );
}

const rich = summary('share12345', {
  title: 'The Sunless Citadel',
  description: 'A dungeon crawl\nfor level 1',
  tags: ['type:Adventure', 'dungeon', 'system:D&D 5e', 'custom:thing'],
  authors: ['alice', 'bob'],
  views: 1234,
  pageCount: 1,
  createdAt: '2026-01-05T10:00:00Z',
  updatedAt: '2026-03-10T10:00:00Z',
  lastViewedAt: '2026-03-09T10:00:00Z',
});

describe('BrewItem', () => {
  it('shows the title as a link to the share page, the description and the facts', () => {
    renderItem(rich);
    const item = screen.getByRole('article', { name: 'The Sunless Citadel' });
    expect(within(item).getByRole('heading', { level: 3, name: 'The Sunless Citadel' })).toBeInTheDocument();
    expect(within(item).getByRole('link', { name: 'The Sunless Citadel' })).toHaveAttribute('href', '/share/share12345');
    expect(within(item).getByText(/A dungeon crawl/)).toBeInTheDocument();
    const details = within(item).getByRole('list', { name: 'Details' });
    expect(within(details).getByRole('link', { name: 'alice' })).toHaveAttribute('href', '/user/alice');
    expect(within(details).getByRole('link', { name: 'bob' })).toHaveAttribute('href', '/user/bob');
    expect(within(item).getByTestId('brew-views')).toHaveTextContent('1,234 views');
    expect(within(item).getByTestId('brew-views')).toHaveAttribute('title', expect.stringMatching(/^Last viewed /));
    expect(within(item).getByTestId('brew-pages')).toHaveTextContent('1 page');
    expect(within(item).getByTestId('brew-updated')).toHaveTextContent('Updated 2 hours ago');
    expect(within(item).getByTestId('brew-updated').querySelector('time')).toHaveAttribute('dateTime', '2026-03-10T10:00:00Z');
    expect(within(item).getByTestId('brew-created').querySelector('time')).toHaveAttribute('dateTime', '2026-01-05T10:00:00Z');
  });

  it('names untitled brews and uses the heading level asked for', () => {
    renderItem(summary('blank12345', { title: '  ' }), { headingLevel: 2 });
    expect(screen.getByRole('heading', { level: 2, name: 'Untitled brew' })).toBeInTheDocument();
  });

  it("orders tags as upstream and shows a known prefix as a colour with the prefix for screen readers", () => {
    renderItem(rich);
    const tags = screen.getByRole('list', { name: 'Tags' });
    const texts = within(tags)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    // Plain tags first, then by the colon's position, then alphabetically.
    expect(texts).toEqual(['dungeon', 'type: Adventure', 'custom:thing', 'system: D&D 5e']);
    const typeTag = within(tags).getByText('Adventure');
    expect(typeTag).toHaveAttribute('data-tone', 'type');
    expect(typeTag).toHaveAttribute('title', 'type:Adventure');
    // Without onTagClick the tags are labels, not buttons.
    expect(within(tags).queryByRole('button')).toBeNull();
  });

  it('turns tags into filter toggles when the page filters by tag', async () => {
    const onTagClick = vi.fn();
    renderItem(rich, { onTagClick, selectedTags: ['DUNGEON'] });
    const tags = screen.getByRole('list', { name: 'Tags (select to filter)' });
    const dungeon = within(tags).getByRole('button', { name: 'dungeon' });
    expect(dungeon).toHaveAttribute('aria-pressed', 'true');
    const adventure = within(tags).getByRole('button', { name: 'type: Adventure' });
    expect(adventure).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(adventure);
    expect(onTagClick).toHaveBeenCalledWith('type:Adventure');
  });

  it("gives other people's brews Copy link and (signed in) Clone only", async () => {
    const onCopyLink = vi.fn();
    const onClone = vi.fn();
    renderItem(rich, { actions: { onCopyLink, onClone, onDownload: vi.fn(), onRemove: vi.fn() } });
    expect(screen.queryByTestId('brew-edit')).toBeNull();
    expect(screen.queryByTestId('brew-download')).toBeNull();
    expect(screen.queryByTestId('brew-remove')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Copy link to The Sunless Citadel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clone The Sunless Citadel' }));
    expect(onCopyLink).toHaveBeenCalledOnce();
    expect(onClone).toHaveBeenCalledOnce();
  });

  it('gives own brews Edit, Download (PDF) and Delete, worded by role', async () => {
    const onRemove = vi.fn();
    const onDownload = vi.fn();
    const own = { ...rich, editId: 'edit123456', role: 'owner' as const, authors: ['alice'] };
    const { unmount } = renderItem(own, { actions: { onCopyLink: vi.fn(), onDownload, onRemove } });
    expect(screen.getByRole('link', { name: 'Edit The Sunless Citadel' })).toHaveAttribute('href', '/edit/edit123456');
    await userEvent.click(screen.getByRole('button', { name: 'Download The Sunless Citadel as PDF' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete The Sunless Citadel' }));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledOnce();
    unmount();

    renderItem({ ...own, authors: ['alice', 'bob'] }, { actions: { onRemove } });
    expect(screen.getByRole('button', { name: 'Remove The Sunless Citadel' })).toBeInTheDocument();
  });

  it('offers Decline for an invitation and no Clone for a locked brew', () => {
    renderItem({ ...rich, editId: 'edit123456', role: 'invited', locked: true }, { actions: { onClone: vi.fn(), onRemove: vi.fn() } });
    expect(screen.getByRole('button', { name: 'Decline The Sunless Citadel' })).toBeInTheDocument();
    expect(screen.queryByTestId('brew-clone')).toBeNull();
    expect(screen.getByTestId('brew-locked')).toHaveTextContent('Locked');
  });

  it('marks a busy action and ignores clicks on it', async () => {
    const onClone = vi.fn();
    renderItem(rich, { actions: { onClone, cloning: true } });
    const clone = screen.getByTestId('brew-clone');
    expect(clone).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(clone);
    expect(onClone).not.toHaveBeenCalled();
  });

  it('shows the thumbnail as decoration and drops it when it fails to load', () => {
    renderItem({ ...rich, thumbnailUrl: 'https://example.test/thumb.png' });
    const item = screen.getByTestId('brew-item');
    expect(item).toHaveAttribute('data-thumbnail', 'true');
    const img = screen.getByTestId('brew-thumbnail');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(img);
    expect(screen.queryByTestId('brew-thumbnail')).toBeNull();
    expect(item).not.toHaveAttribute('data-thumbnail');
  });
});
