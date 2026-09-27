import clsx from 'clsx';
import { Spinner } from '@/ui';
import styles from './PageLoading.module.css';

/**
 * A page-sized loading state (a labelled spinner) for pages waiting on their first data.
 * `fullScreen` fills the viewport, for the first load before the shell exists.
 */
export function PageLoading({ label = 'Loading', fullScreen = false }: { label?: string; fullScreen?: boolean }) {
  return (
    <div className={clsx(styles.loading, fullScreen && styles.fullScreen)} data-testid="page-loading">
      <Spinner size={28} label={label} />
    </div>
  );
}
