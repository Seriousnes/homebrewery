// The vault's page links (upstream: .paginationControls): Previous, the first page, up to ten pages
// around the current one, the last page, Next. They are links (each page is a URL), the current
// one marked with aria-current="page".
import { Link } from 'react-router';
import { Icon, VisuallyHidden } from '@/ui';
import { pageWindow } from './vaultQuery';
import styles from './VaultPage.module.css';

export interface PaginationProps {
  page: number;
  pages: number;
  /** The URL search string of a page ("?q=x&page=2"). */
  searchFor: (page: number) => string;
  /** After a page link was followed (the page moves focus to the results). */
  onNavigate?: () => void;
}

export function Pagination({ page, pages, searchFor, onNavigate }: PaginationProps) {
  if (pages <= 1) return null;
  const { start, end } = pageWindow(page, pages);
  const numbers: number[] = [];
  for (let n = start; n <= end; n++) numbers.push(n);

  const pageLink = (n: number, label?: string) =>
    n === page ? (
      <span className={styles.pageCurrent} aria-current="page">
        <VisuallyHidden>Page </VisuallyHidden>
        {n}
      </span>
    ) : (
      <Link className={styles.pageLink} to={{ search: searchFor(n) }} onClick={onNavigate} aria-label={label ?? `Page ${n}`}>
        {n}
      </Link>
    );

  return (
    <nav className={styles.pagination} aria-label="Result pages" data-testid="vault-pagination">
      <ul className={styles.pageList}>
        <li>
          {page > 1 ? (
            <Link
              className={styles.pageStep}
              to={{ search: searchFor(Math.min(page - 1, pages)) }}
              onClick={onNavigate}
              aria-label="Previous page"
              data-testid="vault-previous"
            >
              <Icon name="chevronLeft" size={14} />
              Previous
            </Link>
          ) : (
            <span className={styles.pageStep} data-disabled="" aria-hidden="true">
              <Icon name="chevronLeft" size={14} />
              Previous
            </span>
          )}
        </li>
        {start > 1 ? (
          <>
            <li>{pageLink(1, 'Page 1, the first page')}</li>
            {start > 2 ? (
              <li className={styles.pageGap} aria-hidden="true">
                …
              </li>
            ) : null}
          </>
        ) : null}
        {numbers.map((n) => (
          <li key={n}>{pageLink(n)}</li>
        ))}
        {end < pages ? (
          <>
            {end < pages - 1 ? (
              <li className={styles.pageGap} aria-hidden="true">
                …
              </li>
            ) : null}
            <li>{pageLink(pages, `Page ${pages}, the last page`)}</li>
          </>
        ) : null}
        <li>
          {page < pages ? (
            <Link className={styles.pageStep} to={{ search: searchFor(page + 1) }} onClick={onNavigate} aria-label="Next page" data-testid="vault-next">
              Next
              <Icon name="chevronRight" size={14} />
            </Link>
          ) : (
            <span className={styles.pageStep} data-disabled="" aria-hidden="true">
              Next
              <Icon name="chevronRight" size={14} />
            </span>
          )}
        </li>
      </ul>
    </nav>
  );
}
