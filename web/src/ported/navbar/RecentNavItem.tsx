// Port of legacy client/homebrew/navbar/recent.navitem.jsx ("recent brews": both lists). The
// lists come from web/src/app/recentBrews.ts; the editor and share pages add to them. Upstream
// opened entries in a new tab; these are ordinary links (middle-click still opens a tab).
import clsx from 'clsx';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { type RecentBrew, type RecentKind, recentBrewUrl, removeRecentBrew, useRecentBrews } from '@/app/recentBrews';
import { formatDateTime, formatRelativeTime } from '@/app/relativeTime';
import { focusElement, IconButton } from '@/ui';
import { HistoryIcon } from './navIcons';
import { NavDisclosure } from './NavDisclosure';
import styles from './Navbar.module.css';

const SECTIONS: readonly { kind: RecentKind; heading: string }[] = [
  { kind: 'edit', heading: 'Edited' },
  { kind: 'view', heading: 'Viewed' },
];

export function RecentNavItem() {
  return (
    <NavDisclosure label="Recent" icon={<HistoryIcon />} tone="grey" collapsible panelLabel="Recent brews" data-testid="nav-recent">
      <RecentPanel />
    </NavDisclosure>
  );
}

/** Mounted while the panel is open, so relative times are fresh each time it opens. */
function RecentPanel() {
  const recent = useRecentBrews();
  const [now] = useState(() => Date.now());
  const panelRef = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  // After a removal, focus moves to the neighbouring entry's remove button (or the panel).
  const focusAfterRemove = useRef<{ kind: RecentKind; index: number } | null>(null);

  useLayoutEffect(() => {
    const pending = focusAfterRemove.current;
    if (!pending) return;
    focusAfterRemove.current = null;
    const panel = panelRef.current;
    const list = recent[pending.kind];
    const buttons = panel?.querySelectorAll<HTMLElement>(`[data-recent-remove="${pending.kind}"]`);
    const target =
      list.length > 0
        ? buttons?.[Math.min(pending.index, list.length - 1)]
        : panel?.querySelector<HTMLElement>('[data-recent-remove]');
    focusElement(target ?? panel?.closest<HTMLElement>('[role="group"]') ?? null);
  }, [recent]);

  const remove = (kind: RecentKind, brew: RecentBrew, index: number) => {
    focusAfterRemove.current = { kind, index };
    removeRecentBrew(kind, brew.id);
  };

  const sections = SECTIONS.filter(({ kind }) => recent[kind].length > 0);

  return (
    <div ref={panelRef}>
      {sections.length === 0 ? (
        <p className={styles.panelNote}>No recent brews yet. Brews you edit or view show up here.</p>
      ) : null}
      {sections.map(({ kind, heading }) => {
        const headingId = `${idPrefix}-${kind}`;
        return (
          <section key={kind} className={styles.panelSection} aria-labelledby={headingId}>
            <h2 id={headingId} className={styles.panelHeading}>
              {heading}
            </h2>
            <ul className={styles.panelList}>
              {recent[kind].map((brew, index) => {
                const name = brew.title.trim() || 'Untitled brew';
                return (
                  <li key={brew.id} className={styles.recentItem}>
                    <Link className={styles.panelLink} to={recentBrewUrl(kind, brew.id)} title={name}>
                      <span className={clsx(styles.recentTitle, !brew.title.trim() && styles.untitled)}>{name}</span>
                      <time className={styles.panelHint} dateTime={new Date(brew.ts).toISOString()} title={formatDateTime(brew.ts)}>
                        {formatRelativeTime(brew.ts, now)}
                      </time>
                    </Link>
                    <IconButton
                      icon="close"
                      size="sm"
                      label={`Remove ${name} from recent brews`}
                      tooltip={false}
                      data-recent-remove={kind}
                      onClick={() => remove(kind, brew, index)}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
