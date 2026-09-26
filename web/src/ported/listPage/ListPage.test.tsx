import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { BrewItem } from '@/ported/brewItem/BrewItem';
import { type GroupId, groupUserBrews, type ListState, toggleTag } from './listModel';
import { ListPage } from './ListPage';
import { summary } from './testing';

const items = [
  summary('a', { title: 'Alpha', tags: ['type:Adventure'], views: 3, published: true, role: 'owner', editId: 'ea' }),
  summary('b', { title: 'Beta', tags: ['type:Adventure', 'dungeon'], views: 30, published: true, role: 'owner', editId: 'eb' }),
  summary('c', { title: 'Gamma', description: 'secret draft', published: false, role: 'owner', editId: 'ec' }),
];

function Harness({ initial, collapsed: initialCollapsed = [] }: { initial?: Partial<ListState>; collapsed?: GroupId[] }) {
  const [state, setState] = useState<ListState>({ filter: '', tags: [], sort: 'title', dir: 'asc', ...initial });
  const [collapsed, setCollapsed] = useState<GroupId[]>(initialCollapsed);
  const groups = groupUserBrews({ handle: 'alice', own: true, items });
  return (
    <MemoryRouter>
      <ListPage
        groups={groups}
        state={state}
        onStateChange={setState}
        collapsed={collapsed}
        onToggleGroup={(id, close) => setCollapsed((c) => (close ? [...c, id] : c.filter((g) => g !== id)))}
        renderItem={(brew) => <BrewItem brew={brew} onTagClick={(tag) => setState((s) => ({ ...s, tags: toggleTag(s.tags, tag) }))} selectedTags={state.tags} />}
      />
      <output data-testid="state">{JSON.stringify({ state, collapsed })}</output>
    </MemoryRouter>
  );
}

const titlesIn = (group: string) =>
  within(screen.getByTestId(`list-group-${group}`))
    .queryAllByRole('heading', { level: 3 })
    .map((h) => h.textContent);
const stateOf = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}') as { state: ListState; collapsed: GroupId[] };

describe('ListPage', () => {
  it('shows the groups with their counts, sorted by title', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /^Your published brews/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { level: 2, name: /^Your unpublished brews/ })).toBeInTheDocument();
    expect(titlesIn('published')).toEqual(['Alpha', 'Beta']);
    expect(titlesIn('unpublished')).toEqual(['Gamma']);
    expect(screen.getByTestId('list-count')).toHaveTextContent('3 brews');
    expect(screen.getByTestId('list-count')).toHaveAttribute('role', 'status');
  });

  it('sorts with the sort bar: a new sort starts with its default direction, the active one reverses', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const bar = screen.getByRole('group', { name: 'Sort by' });
    const title = within(bar).getByRole('button', { name: /^Title/ });
    expect(title).toHaveAttribute('aria-pressed', 'true');
    expect(title).toHaveTextContent('A to Z');
    await user.click(within(bar).getByRole('button', { name: /^Views/ }));
    expect(stateOf().state).toMatchObject({ sort: 'views', dir: 'desc' });
    expect(titlesIn('published')).toEqual(['Beta', 'Alpha']);
    expect(within(bar).getByRole('button', { name: /^Views/ })).toHaveTextContent('most first');
    await user.click(within(bar).getByRole('button', { name: /^Views/ }));
    expect(stateOf().state).toMatchObject({ sort: 'views', dir: 'asc' });
    expect(titlesIn('published')).toEqual(['Alpha', 'Beta']);
    expect(within(bar).getAllByRole('button').map((b) => b.getAttribute('data-sort'))).toEqual(['title', 'created', 'updated', 'views', 'pages']);
  });

  it('filters by text across groups and says how many match', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('searchbox', { name: 'Filter' }), 'secret');
    expect(titlesIn('published')).toEqual([]);
    expect(within(screen.getByTestId('list-group-published')).getByText('No brews match the filter.')).toBeInTheDocument();
    expect(titlesIn('unpublished')).toEqual(['Gamma']);
    expect(screen.getByTestId('list-count')).toHaveTextContent('Showing 1 of 3 brews');
    expect(screen.getByRole('button', { name: /^Your published brews/ })).toHaveTextContent('0 of 2');
    await user.click(screen.getByTestId('list-clear-filters'));
    expect(screen.getByRole('searchbox', { name: 'Filter' })).toHaveValue('');
    expect(screen.getByTestId('list-count')).toHaveTextContent('3 brews');
  });

  it('filters by tags picked on the items and removes them from the tag bar', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const beta = screen.getByRole('article', { name: 'Beta' });
    await user.click(within(beta).getByRole('button', { name: 'dungeon' }));
    expect(stateOf().state.tags).toEqual(['dungeon']);
    expect(titlesIn('published')).toEqual(['Beta']);
    const filters = screen.getByRole('group', { name: 'Tags' });
    expect(within(filters).getByRole('button', { name: 'Remove the tag filter dungeon' })).toBeInTheDocument();
    // A second tag narrows further (every selected tag must match).
    await user.click(within(screen.getByRole('article', { name: 'Beta' })).getByRole('button', { name: 'type: Adventure' }));
    expect(stateOf().state.tags).toEqual(['dungeon', 'type:Adventure']);
    expect(within(filters).getByRole('button', { name: 'Remove the tag filter type: Adventure' })).toBeInTheDocument();
    await user.click(within(filters).getByRole('button', { name: 'Remove the tag filter dungeon' }));
    expect(stateOf().state.tags).toEqual(['type:Adventure']);
    expect(titlesIn('published')).toEqual(['Alpha', 'Beta']);
  });

  it('collapses and expands a group from its heading button, with the keyboard too', async () => {
    const user = userEvent.setup();
    render(<Harness collapsed={['unpublished']} />);
    const toggle = screen.getByRole('button', { name: /^Your unpublished brews/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(panel).not.toBeVisible();
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toBeVisible();
    expect(stateOf().collapsed).toEqual([]);
    await user.keyboard(' ');
    expect(stateOf().collapsed).toEqual(['unpublished']);
  });

  it("says a group is empty in the group's own words", () => {
    render(
      <MemoryRouter>
        <ListPage
          groups={groupUserBrews({ handle: 'james', own: false, items: [] })}
          state={{ filter: '', tags: [], sort: 'title', dir: 'asc' }}
          onStateChange={() => undefined}
          collapsed={[]}
          onToggleGroup={() => undefined}
          renderItem={() => null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 2, name: /^james’ published brews/ })).toBeInTheDocument();
    expect(screen.getByText('james has no published brews.')).toBeInTheDocument();
    expect(screen.getByTestId('list-count')).toHaveTextContent('0 brews');
  });
});
