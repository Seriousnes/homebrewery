// The import report (plan §7, P6.3): what the conversion changed or couldn't keep, shown before
// the brew is saved. A description list (one entry per report item, reportModel.ts) with the count,
// one sentence, and the details in a disclosure. The pages entry fills in once the preview has
// laid the pages out (recordPaginatedPages).
import clsx from 'clsx';
import { useId } from 'react';
import type { ImportReportData } from '@/editor/import/importReport';
import { Icon, type IconName } from '@/ui';
import styles from './ImportReportView.module.css';
import { type LayoutState, type ReportItem, type ReportTone, reportItems } from './reportModel';

export interface ImportReportViewProps {
  report: ImportReportData;
  /** The preview's layout pass (the page counts after pagination). */
  layout: LayoutState;
  /** Notes from the import page, listed with the report's warnings. */
  notes?: readonly string[];
  /** The report heading's level (default 3). */
  headingLevel?: 2 | 3 | 4;
  title?: string;
  className?: string;
  'data-testid'?: string;
}

const TONE_ICON: Record<ReportTone, IconName> = { neutral: 'check', info: 'info', warning: 'warning' };
const TONE_TEXT: Record<ReportTone, string> = { neutral: '', info: '', warning: 'Check: ' };

function Details({ item }: { item: ReportItem }) {
  const details = item.details;
  if (!details) return null;
  return (
    <details className={styles.details}>
      <summary className={styles.summaryToggle}>
        Show {details.items.length === 1 ? 'it' : `all ${details.items.length}`}
      </summary>
      <ul className={styles.detailList} aria-label={details.label}>
        {details.items.map((line, i) => (
          <li key={i}>{details.code ? <code className={styles.code}>{line}</code> : line}</li>
        ))}
      </ul>
    </details>
  );
}

export function ImportReportView({
  report,
  layout,
  notes = [],
  headingLevel = 3,
  title = 'Import report',
  className,
  'data-testid': testId = 'import-report',
}: ImportReportViewProps) {
  const titleId = useId();
  const Heading = `h${headingLevel}` as const;
  const items = reportItems(report, { layout, notes });
  return (
    <section className={clsx(styles.report, className)} aria-labelledby={titleId} data-testid={testId} data-layout={report.paginated ? 'done' : layout}>
      <Heading id={titleId} className={styles.title}>
        {title}
      </Heading>
      <dl className={styles.list}>
        {items.map((item) => (
          <div
            key={item.id}
            className={clsx(styles.item, styles[item.tone])}
            data-testid={`import-report-${item.id}`}
            data-count={item.count ?? ''}
            data-tone={item.tone}
          >
            <dt className={styles.label}>
              <Icon name={TONE_ICON[item.tone]} size={16} className={styles.icon} />
              {item.label}
            </dt>
            <dd className={styles.value}>
              <span className={styles.count} data-testid={`import-report-${item.id}-count`}>
                {item.count ?? '–'}
              </span>
              <span className={styles.text}>
                {TONE_TEXT[item.tone] && item.count !== 0 ? <span className={styles.srOnly}>{TONE_TEXT[item.tone]}</span> : null}
                {item.summary}
              </span>
              <Details item={item} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
