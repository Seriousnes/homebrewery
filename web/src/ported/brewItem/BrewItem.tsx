// One brew in a list (port of legacy client/homebrew/pages/basePages/listPage/brewItem): its
// thumbnail, title (a link to the share page), description, tags, authors, views, page count and
// dates, and the actions that fit the reader: Edit, Download and Delete/Remove/Decline for the
// reader's own brews (the API gave an editId), Copy link for everyone, Clone for signed-in readers.
// Upstream revealed its icon links on hover and opened them in new tabs; here the actions are
// always visible, labelled buttons and links that stay in the app.
import clsx from 'clsx';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import type { BrewSummary } from '@/api';
import { paths } from '@/app/paths';
import { formatDateTime, formatRelativeTime } from '@/app/relativeTime';
import { displayTitle, hasTag, sortTags, tagParts } from '@/ported/listPage/listModel';
import { tagType } from '@/ported/tagInput/normalizeTag';
import { Icon, Spinner, VisuallyHidden } from '@/ui';
import { BrewIcon } from './brewIcons';
import styles from './BrewItem.module.css';
import { formatDate, pageCount, removeCopy, viewCount } from './brewItemModel';

/** Callbacks of the item's buttons; an action without its callback is not shown. */
export interface BrewItemActions {
  onCopyLink?: () => void;
  /** Signed-in readers; locked brews can't be cloned (the API answers 423). */
  onClone?: () => void;
  cloning?: boolean;
  /** Own brews (editId). */
  onDownload?: () => void;
  downloading?: boolean;
  /** Own brews (editId): delete, leave or decline, by role. */
  onRemove?: () => void;
}

export interface BrewItemProps {
  brew: BrewSummary;
  /** The title's heading level (default 3: under a group's h2). */
  headingLevel?: 2 | 3 | 4;
  /** Tags become filter toggles when given (the user page); plain labels otherwise (the vault). */
  onTagClick?: (tag: string) => void;
  selectedTags?: readonly string[];
  actions?: BrewItemActions;
  /** "Now" for the relative dates (tests). */
  now?: number;
  className?: string;
}

export function BrewItem({ brew, headingLevel = 3, onTagClick, selectedTags = [], actions = {}, now, className }: BrewItemProps) {
  const title = displayTitle(brew);
  const Heading = `h${headingLevel}` as const;
  const titleId = `brew-${brew.shareId}-title`;
  const tags = sortTags(brew.tags);
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumbnail = Boolean(brew.thumbnailUrl) && !thumbFailed;
  const remove = removeCopy(brew);

  return (
    <article className={clsx(styles.item, className)} aria-labelledby={titleId} data-testid="brew-item" data-share-id={brew.shareId} data-thumbnail={showThumbnail || undefined}>
      {showThumbnail ? (
        <img
          className={styles.thumbnail}
          src={brew.thumbnailUrl ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setThumbFailed(true)}
          data-testid="brew-thumbnail"
        />
      ) : null}
      <div className={styles.text}>
        <Heading id={titleId} className={styles.title}>
          <Link to={paths.share(brew.shareId)} className={styles.titleLink} data-brew-focus={brew.shareId}>
            {title}
          </Link>
        </Heading>
        {brew.locked ? (
          <p className={styles.badges}>
            <span className={styles.badge} data-tone="locked" data-testid="brew-locked">
              <Icon name="lock" size={14} />
              Locked
            </span>
          </p>
        ) : null}
        {brew.description.trim() ? <p className={styles.description}>{brew.description}</p> : null}
      </div>

      {tags.length > 0 ? (
        <ul className={styles.tags} aria-label={onTagClick ? 'Tags (select to filter)' : 'Tags'}>
          {tags.map((tag, index) => (
            <li key={`${index}:${tag}`}>
              <TagChip tag={tag} selected={hasTag(selectedTags, tag)} onClick={onTagClick} />
            </li>
          ))}
        </ul>
      ) : null}

      <ul className={styles.facts} aria-label="Details">
        {brew.authors.length > 0 ? (
          <li className={styles.authors}>
            <Icon name="user" size={14} />
            <span>
              by{' '}
              {brew.authors.map((author, index) => (
                <span key={author}>
                  {index > 0 ? ', ' : null}
                  <Link to={paths.user(author)} className={styles.inlineLink}>
                    {author}
                  </Link>
                </span>
              ))}
            </span>
          </li>
        ) : null}
        <li title={brew.lastViewedAt ? `Last viewed ${formatDateTime(brew.lastViewedAt)}` : undefined} data-testid="brew-views">
          <Icon name="eye" size={14} />
          {viewCount(brew.views)}
        </li>
        <li data-testid="brew-pages">
          <BrewIcon name="pages" size={14} />
          {pageCount(brew.pageCount)}
        </li>
        <li data-testid="brew-updated">
          <BrewIcon name="clock" size={14} />
          <span>
            Updated{' '}
            <time dateTime={brew.updatedAt} title={formatDateTime(brew.updatedAt)}>
              {formatRelativeTime(brew.updatedAt, now)}
            </time>
          </span>
        </li>
        <li data-testid="brew-created">
          <BrewIcon name="calendar" size={14} />
          <span>
            Created{' '}
            <time dateTime={brew.createdAt} title={formatDateTime(brew.createdAt)}>
              {formatDate(brew.createdAt)}
            </time>
          </span>
        </li>
      </ul>

      <div className={styles.actions}>
        {brew.editId ? (
          <Link to={paths.edit(brew.editId)} className={styles.action} aria-label={`Edit ${title}`} data-testid="brew-edit">
            <BrewIcon name="pencil" size={14} />
            Edit
          </Link>
        ) : null}
        {actions.onCopyLink ? (
          <ActionButton icon={<BrewIcon name="link" size={14} />} label="Copy link" name={`Copy link to ${title}`} onClick={actions.onCopyLink} testId="brew-copy-link" />
        ) : null}
        {actions.onClone && !brew.locked ? (
          <ActionButton
            icon={<BrewIcon name="clone" size={14} />}
            label="Clone"
            name={`Clone ${title}`}
            onClick={actions.onClone}
            busy={actions.cloning}
            testId="brew-clone"
          />
        ) : null}
        {brew.editId && actions.onDownload ? (
          <ActionButton
            icon={<Icon name="download" size={14} />}
            label="PDF"
            name={`Download ${title} as PDF`}
            onClick={actions.onDownload}
            busy={actions.downloading}
            testId="brew-download"
          />
        ) : null}
        {brew.editId && actions.onRemove ? (
          <ActionButton
            icon={<Icon name="trash" size={14} />}
            label={remove.label}
            name={`${remove.label} ${title}`}
            onClick={actions.onRemove}
            tone="danger"
            testId="brew-remove"
          />
        ) : null}
      </div>
    </article>
  );
}

function TagChip({ tag, selected, onClick }: { tag: string; selected: boolean; onClick?: (tag: string) => void }) {
  const tone = tagType(tag);
  const { prefix, value } = tagParts(tag);
  // Known prefixes (type, group, meta, system) are shown as a colour, as upstream; others in full.
  const content = tone ? (
    <>
      <VisuallyHidden>{`${prefix}:`}</VisuallyHidden> {value}
    </>
  ) : (
    tag
  );
  if (!onClick) {
    return (
      <span className={styles.tag} data-tone={tone ?? undefined} title={tone ? tag : undefined}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.tag}
      data-tone={tone ?? undefined}
      aria-pressed={selected}
      aria-label={tone ? `${prefix}: ${value}` : undefined}
      title={tone ? tag : undefined}
      onClick={() => onClick(tag)}
    >
      {content}
    </button>
  );
}

function ActionButton({
  icon,
  label,
  name,
  onClick,
  busy = false,
  tone,
  testId,
}: {
  icon: ReactNode;
  /** The visible text. */
  label: string;
  /** The accessible name: the label and which brew ("Delete The Sunless Citadel"). */
  name: string;
  onClick: () => void;
  busy?: boolean;
  tone?: 'danger';
  testId: string;
}) {
  return (
    <button
      type="button"
      className={styles.action}
      data-tone={tone}
      aria-label={name}
      aria-busy={busy || undefined}
      onClick={() => {
        if (!busy) onClick();
      }}
      data-testid={testId}
    >
      {busy ? <Spinner size={14} decorative /> : icon}
      {label}
    </button>
  );
}
