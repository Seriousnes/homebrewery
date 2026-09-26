// The user page's brew list (port of legacy client/homebrew/pages/basePages/listPage/listPage.jsx):
// the sort bar, the text filter, the selected tag filters, and the groups (published, unpublished,
// invited), each behind a disclosure heading whose state is remembered per browser. The page owns
// the state (it mirrors it in the URL); this component renders it and reports changes.
import { type ReactNode, useId, useMemo } from 'react';
import type { BrewSummary } from '@/api';
import { Button, Icon, TextField, VisuallyHidden } from '@/ui';
import {
  type BrewGroup,
  countSummary,
  defaultDirFor,
  type GroupId,
  LIST_SORT_LABELS,
  LIST_SORTS,
  type ListSort,
  type ListState,
  tagParts,
  toggleTag,
  visibleGroups,
} from './listModel';
import styles from './ListPage.module.css';
import { SortBar } from './SortBar';

const SORT_OPTIONS = LIST_SORTS.map((value) => ({ value, label: LIST_SORT_LABELS[value] }));

export interface ListPageProps {
  groups: readonly BrewGroup[];
  state: ListState;
  onStateChange: (next: ListState) => void;
  /** Closed groups. */
  collapsed: readonly GroupId[];
  onToggleGroup: (id: GroupId, collapsed: boolean) => void;
  /** One brew (a BrewItem). */
  renderItem: (brew: BrewSummary) => ReactNode;
  /** Shown above the groups (notes, empty-account hints). */
  children?: ReactNode;
}

export function ListPage({ groups, state, onStateChange, collapsed, onToggleGroup, renderItem, children }: ListPageProps) {
  const shown = useMemo(() => visibleGroups(groups, state), [groups, state]);
  const total = groups.reduce((n, g) => n + g.brews.length, 0);
  const matching = shown.reduce((n, g) => n + g.brews.length, 0);
  const filtering = state.filter.trim() !== '' || state.tags.length > 0;
  const tagFiltersId = useId();

  return (
    <div className={styles.listPage} data-testid="list-page">
      <div className={styles.controls}>
        <SortBar<ListSort>
          options={SORT_OPTIONS}
          sort={state.sort}
          dir={state.dir}
          defaultDir={defaultDirFor}
          onChange={(sort, dir) => onStateChange({ ...state, sort, dir })}
          data-testid="list-sort"
        />
        <TextField
          type="search"
          label="Filter"
          placeholder="Title, description or tag"
          className={styles.filter}
          value={state.filter}
          onChange={(event) => onStateChange({ ...state, filter: event.target.value })}
          autoComplete="off"
          spellCheck={false}
          data-testid="list-filter"
        />
      </div>

      {state.tags.length > 0 ? (
        <div className={styles.tagFilters} role="group" aria-labelledby={tagFiltersId} data-testid="list-tag-filters">
          <span id={tagFiltersId} className={styles.sortLabel}>
            Tags
          </span>
          {state.tags.map((tag) => {
            const { prefix, value } = tagParts(tag);
            const tagText = prefix ? `${prefix}: ${value}` : value;
            return (
              <button
                key={tag}
                type="button"
                className={styles.tagFilter}
                data-prefix={prefix ?? undefined}
                aria-label={`Remove the tag filter ${tagText}`}
                onClick={() => onStateChange({ ...state, tags: toggleTag(state.tags, tag) })}
                data-tag-filter={tag}
              >
                {tagText}
                <Icon name="close" size={12} />
              </button>
            );
          })}
        </div>
      ) : null}

      <div className={styles.summary}>
        <p className={styles.count} role="status" data-testid="list-count">
          {countSummary(matching, total, filtering)}
        </p>
        {filtering ? (
          <Button size="sm" variant="ghost" icon="close" onClick={() => onStateChange({ ...state, filter: '', tags: [] })} data-testid="list-clear-filters">
            Clear filters
          </Button>
        ) : null}
      </div>

      {children}

      {shown.map((group, index) => {
        const all = groups[index]!.brews.length;
        return (
          <GroupSection
            key={group.id}
            group={group}
            all={all}
            filtering={filtering}
            open={!collapsed.includes(group.id)}
            onToggle={(open) => onToggleGroup(group.id, !open)}
            renderItem={renderItem}
          />
        );
      })}
    </div>
  );
}

function GroupSection({
  group,
  all,
  filtering,
  open,
  onToggle,
  renderItem,
}: {
  group: BrewGroup;
  all: number;
  filtering: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  renderItem: (brew: BrewSummary) => ReactNode;
}) {
  const id = useId();
  const headingId = `${id}-heading`;
  const panelId = `${id}-panel`;
  return (
    <section className={styles.group} aria-labelledby={headingId} data-testid={`list-group-${group.id}`} data-group={group.id}>
      <h2 id={headingId} className={styles.groupHeading}>
        <button
          type="button"
          className={styles.groupToggle}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onToggle(!open)}
          data-group-toggle={group.id}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={18} />
          <span>{group.title}</span>
          <span className={styles.groupCount}>
            <VisuallyHidden>, </VisuallyHidden>
            {filtering ? `${group.brews.length} of ${all}` : String(all)}
          </span>
        </button>
      </h2>
      <div id={panelId} hidden={!open}>
        {group.brews.length === 0 ? (
          <p className={styles.empty}>{all === 0 ? group.empty : 'No brews match the filter.'}</p>
        ) : (
          <ul className={styles.items}>
            {group.brews.map((brew) => (
              <li key={brew.shareId} className={styles.itemCell}>
                {renderItem(brew)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
