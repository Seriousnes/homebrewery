import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ImportReportData } from '@/editor/import/importReport';
import { ImportReportView } from './ImportReportView';

const report: ImportReportData = {
  pages: 2,
  theme: '5ePHB',
  clippedPages: [{ page: 2, estimatedPages: 3, paginatedPages: 3 }],
  variables: { mode: 'expand', definitions: [], unresolved: [] },
  paginated: { pages: 4, grown: [{ page: 2, pages: 3 }] },
  rawHtml: { count: 1, samples: ['<section class="x">Raw</section>'] },
  commentsDropped: 0,
  styleTagsLifted: 0,
  unknownClasses: [{ name: 'glow', count: 2 }],
  sanitizer: { elements: {}, attributes: {} },
  transparentElements: {},
  lifted: { markers: 0, footers: 0, pageNumbers: 0, objects: 0 },
  positionedInFlow: [],
  lost: [],
  warnings: [],
};

describe('ImportReportView', () => {
  it('is a named section with one description-list entry per item', () => {
    render(<ImportReportView report={report} layout="done" headingLevel={2} />);
    const section = screen.getByRole('region', { name: 'Import report' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Import report' })).toBeInTheDocument();
    expect(section).toHaveAttribute('data-layout', 'done');
    const terms = within(section).getAllByRole('term').map((t) => t.textContent);
    expect(terms).toEqual([
      'Pages',
      'Pages cut off on the Homebrewery',
      'Variable definitions',
      'Raw HTML kept',
      'HTML comments dropped',
      'Unknown classes',
      'Tags that lost their attributes',
    ]);
    expect(screen.getByTestId('import-report-pages-count')).toHaveTextContent('4');
    expect(screen.getByTestId('import-report-unknown-classes')).toHaveAttribute('data-tone', 'warning');
    // Warnings carry a "Check:" prefix for screen readers; zero counts don't.
    expect(within(screen.getByTestId('import-report-unknown-classes')).getByText('Check:', { exact: false })).toBeInTheDocument();
    expect(within(screen.getByTestId('import-report-transparent')).queryByText('Check:', { exact: false })).toBeNull();
  });

  it('shows the details in a disclosure', async () => {
    const user = userEvent.setup();
    render(<ImportReportView report={report} layout="done" />);
    const raw = screen.getByTestId('import-report-raw-html');
    const toggle = within(raw).getByText('Show it');
    expect(toggle.tagName).toBe('SUMMARY');
    await user.click(toggle);
    const list = within(raw).getByRole('list', { name: 'Raw HTML samples' });
    expect(within(list).getByText('<section class="x">Raw</section>').tagName).toBe('CODE');
    expect(within(screen.getByTestId('import-report-clipped')).getByText('Page 2: now 3 pages')).toBeInTheDocument();
  });

  it('marks an item that was not checked with a dash, and lists the page notes', () => {
    render(<ImportReportView report={{ ...report, unknownClasses: null, paginated: null }} layout="pending" notes={['Theme fell back']} />);
    expect(screen.getByTestId('import-report')).toHaveAttribute('data-layout', 'pending');
    expect(screen.getByTestId('import-report-unknown-classes-count')).toHaveTextContent('–');
    expect(screen.getByTestId('import-report-warnings')).toHaveTextContent('Worth checking before you create the brew.');
    expect(screen.getByTestId('import-report-pages')).toHaveTextContent('Laying out the pages…');
  });
});
