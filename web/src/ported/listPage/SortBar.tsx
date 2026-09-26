// The sort bar of the list pages (upstream's .sort-container): one button per sort; the active one
// is pressed and shows its direction, and pressing it again reverses the direction. The direction
// is part of the button's name ("Updated, newest first") for screen readers.
import clsx from 'clsx';
import { useId } from 'react';
import { Icon, VisuallyHidden } from '@/ui';
import { dirLabel, type SortDir } from './listModel';
import styles from './ListPage.module.css';

export interface SortOption<T extends string> {
  value: T;
  label: string;
}

export interface SortBarProps<T extends string> {
  options: readonly SortOption<T>[];
  sort: T;
  dir: SortDir;
  /** A new sort, or the same sort with the other direction. */
  onChange: (sort: T, dir: SortDir) => void;
  /** The direction a newly picked sort starts with. */
  defaultDir: (sort: T) => SortDir;
  label?: string;
  className?: string;
  'data-testid'?: string;
}

export function SortBar<T extends string>({ options, sort, dir, onChange, defaultDir, label = 'Sort by', className, 'data-testid': testId }: SortBarProps<T>) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className={clsx(styles.sortBar, className)} data-testid={testId}>
      <span id={labelId} className={styles.sortLabel}>
        {label}
      </span>
      {options.map((option) => {
        const active = option.value === sort;
        return (
          <button
            key={option.value}
            type="button"
            className={styles.sortButton}
            aria-pressed={active}
            data-sort={option.value}
            onClick={() => onChange(option.value, active ? (dir === 'asc' ? 'desc' : 'asc') : defaultDir(option.value))}
          >
            {option.label}
            {active ? (
              <>
                <Icon name={dir === 'asc' ? 'chevronUp' : 'chevronDown'} size={14} />
                <VisuallyHidden>{`, ${dirLabel(option.value, dir)}`}</VisuallyHidden>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
