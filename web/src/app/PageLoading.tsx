import { Spinner } from '@/ui';
import styles from './PageLoading.module.css';

/** A page-sized loading state (a labelled spinner) for pages waiting on their first data. */
export function PageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className={styles.loading} data-testid="page-loading">
      <Spinner size={28} label={label} />
    </div>
  );
}
