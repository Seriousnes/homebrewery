import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { probeUserCss } from '@/editor/canvas/probe';
import { applyThemeStyles, loadThemeChain, waitForFonts } from '@/editor/canvas/themeLoader';
import { buildPageElement } from '@/editor/import/pages';
import { OPEN_SANS_CSS, UPSTREAM_BASE_CSS } from '@/editor/import/upstreamBase';
import { fixtureNames, loadFixture, settleImages } from '../import/fixtures';
import { renderLegacyBrew } from './legacyRender';
import styles from './LegacyRenderPage.module.css';

type Status = { state: 'loading' } | { state: 'ready'; pages: number; theme: string; failed: string[] } | { state: 'error'; message: string };

/**
 * Preview-page rules of legacy/.../brewRenderer/brewRenderer.less (page spacing, all pages laid
 * out). Pages are left-aligned at a whole-pixel offset (not centred) so both harness routes put
 * them on the same pixel grid: A4/A3 pages have fractional widths.
 */
const LEGACY_PAGE_CSS = String.raw`
body { margin: 0; background: #eee; }
.hb-canvas .pages { padding: 30px 20px 0; }
.hb-canvas .pages > :where(.page) { margin: 0 0 30px; box-shadow: 1px 4px 14px #000; }
.hb-canvas .page { content-visibility: visible; }
`;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * /dev/legacy-render?fixture=<name>[&theme=<key>]: renders an S3 fixture the way upstream's
 * preview did (legacyRender.ts) inside an iframe, like upstream (so the editor's canvas.css
 * can't reach it), with the same scoped theme CSS the editor uses and the brew's CSS scoped the
 * same way. `data-render-status="ready"` on the frame once fonts and images have loaded;
 * `data-page-count` gives the number of pages.
 */
export function LegacyRenderPage() {
  const [params] = useSearchParams();
  const fixture = params.get('fixture') ?? '';
  const themeOverride = params.get('theme');
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>({ state: 'loading' });

  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe || !fixture) return;
    let cancelled = false;
    const run = async () => {
      const text = await loadFixture(fixture);
      if (cancelled) return;
      if (text === null) throw new Error(`No fixture named "${fixture}".`);
      const brew = renderLegacyBrew(text);
      const theme = themeOverride ?? brew.theme;
      const chain = await loadThemeChain(theme);
      // React may have re-run this effect meanwhile (StrictMode): only the live run touches the frame.
      if (cancelled) return;
      const doc = iframe.contentDocument;
      if (!doc) throw new Error('The render frame has no document.');
      doc.open();
      doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Rendered Brew Content</title></head><body></body></html>');
      doc.close();

      const base = doc.createElement('style');
      base.textContent = [OPEN_SANS_CSS, UPSTREAM_BASE_CSS, LEGACY_PAGE_CSS].join('\n');
      doc.head.appendChild(base);
      const applying = applyThemeStyles({ styles: chain.styles.filter((s) => s.kind === 'url') }, null, { document: doc, slot: 'legacy' });
      for (const s of chain.styles) {
        if (s.kind !== 'css') continue;
        const el = doc.createElement('style');
        el.textContent = probeUserCss(s.css, s.baseUrl ?? document.baseURI);
        doc.head.appendChild(el);
      }
      const user = doc.createElement('style');
      user.textContent = probeUserCss(brew.style, document.baseURI);
      doc.head.appendChild(user);

      const canvas = doc.createElement('div');
      canvas.className = 'hb-canvas';
      canvas.lang = brew.lang;
      const pages = doc.createElement('div');
      pages.className = 'pages';
      brew.pages.forEach((page, i) => {
        pages.appendChild(buildPageElement(doc, page, page.html, { id: `p${i + 1}`, 'data-index': String(i) }));
      });
      canvas.appendChild(pages);
      doc.body.appendChild(canvas);

      const applied = await applying;
      await waitForFonts({ document: doc, root: canvas });
      await settleImages(canvas, { forceEager: true });
      iframe.style.width = `${Math.max(900, doc.documentElement.scrollWidth)}px`;
      iframe.style.height = `${doc.documentElement.scrollHeight + 20}px`;
      await nextFrame();
      await nextFrame();
      if (!cancelled) setStatus({ state: 'ready', pages: brew.pages.length, theme, failed: applied.failed });
    };
    run().catch((error: unknown) => {
      if (!cancelled) setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [fixture, themeOverride]);

  if (!fixture) {
    return (
      <main className={styles.index}>
        <h1>/dev/legacy-render</h1>
        <p>Upstream-style render of an S3 fixture. Compare with /dev/import.</p>
        <ul>
          {fixtureNames.map((name) => (
            <li key={name}>
              <Link to={`?fixture=${encodeURIComponent(name)}`}>{name}</Link> · <Link to={`/dev/import?fixture=${encodeURIComponent(name)}`}>import</Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  return (
    <div className={styles.frame} data-render-status={status.state} data-page-count={status.state === 'ready' ? status.pages : undefined}>
      <header className={styles.bar}>
        <strong>/dev/legacy-render</strong> <code>{fixture}</code>{' '}
        {status.state === 'ready'
          ? `theme ${status.theme}, ${status.pages} page(s)${status.failed.length ? `, failed: ${status.failed.join(', ')}` : ''}`
          : status.state === 'error'
            ? status.message
            : 'loading…'}{' '}
        · <Link to={`/dev/import?fixture=${encodeURIComponent(fixture)}`}>imported version</Link>
      </header>
      <iframe ref={frameRef} className={styles.iframe} title="Upstream render" sandbox="allow-same-origin" />
    </div>
  );
}
