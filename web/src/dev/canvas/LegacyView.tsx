import { hbfm } from 'marked-hbfm';
import { useEffect, useRef } from 'react';
import openSans400 from '@/editor/canvas/fonts/open-sans-latin-400-normal.woff2?url';
import openSans700 from '@/editor/canvas/fonts/open-sans-latin-700-normal.woff2?url';
import { loadThemeCatalog, staticThemeChain, waitForFonts } from '@/editor/canvas/themeLoader';
import styles from './CanvasDevPage.module.css';

/**
 * The preview iframe of upstream's editor, reduced to what styles a page: the app CSS the themes
 * were written on (reset.less and core.less), brewRenderer.less's page spacing, the theme chain's
 * unscoped style.css files and marked-hbfm's HTML with the renderer's column-fill hack
 * (legacy/client/homebrew/brewRenderer/brewRenderer.jsx:216-219).
 */
const LEGACY_BASE_CSS = String.raw`
@font-face { font-family: 'Open Sans'; font-weight: normal; src: url('${openSans400}') format('woff2'); }
@font-face { font-family: 'Open Sans'; font-weight: bold; src: url('${openSans700}') format('woff2'); }
:where(html,body,div,span,applet,object,iframe,h1,h2,h3,h4,h5,h6,p,blockquote,pre,a,abbr,acronym,address,big,cite,code,del,dfn,em,img,ins,kbd,q,s,samp,small,strike,strong,sub,sup,tt,var,b,u,i,center,dl,dt,dd,ol,ul,li,fieldset,form,button,label,legend,table,caption,tbody,tfoot,thead,tr,th,td,article,aside,canvas,details,embed,figure,figcaption,footer,header,hgroup,menu,nav,output,ruby,section,summary,time,mark,audio,video) {padding:0;margin:0;font:inherit;font-size:100%;vertical-align:baseline;border:0;}
:where(article,aside,details,figcaption,figure,footer,header,hgroup,menu,nav,section) { display: block; }
:where(body) { line-height: 1; }
:where(ol,ul) { list-style: none; }
:where(blockquote,q) { quotes: none; }
:where(table) { border-spacing: 0; border-collapse: collapse; }
:where(i) { text-box-trim: trim-both; }
html, body { margin: 0; font-family: 'Open Sans', sans-serif; }
* { box-sizing: border-box; }
body { overflow: hidden; background: #585858; }
.brewRenderer { padding-top: 30px; }
.brewRenderer :where(.pages) > :where(.page) { width: 215.9mm; height: 279.4mm; margin: 0 auto 30px; box-shadow: 1px 4px 14px #000000; }
.page { content-visibility: visible; }
@supports (break-after: always) { .brewRenderer .columnSplit { margin-bottom: 100vh; } }
`;

export interface LegacyViewProps {
  markdown: string;
  theme: string;
  onStatus: (state: 'loading' | 'ready' | 'error', message?: string) => void;
}

export function LegacyView({ markdown, theme, onStatus }: LegacyViewProps) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    let cancelled = false;
    const run = async () => {
      const catalog = await loadThemeCatalog();
      const chain = staticThemeChain(catalog, theme);
      if (cancelled) return;
      const doc = iframe.contentDocument;
      if (!doc) throw new Error('no iframe document');
      doc.open();
      doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Rendered Brew Content</title></head><body></body></html>');
      doc.close();
      const base = doc.createElement('style');
      base.textContent = LEGACY_BASE_CSS;
      doc.head.append(base);
      // Unscoped theme files, root first (the scoped ones are for the editor's canvas).
      const keys = chain.snippets.map((s) => (typeof s === 'string' ? s.replace(/^V3_/, '') : s.name));
      const loads = keys.map((key) => {
        const entry = catalog.themes.find((t) => t.key === key);
        if (!entry) return Promise.resolve();
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = entry.style;
        doc.head.append(link);
        return new Promise<void>((resolve) => {
          link.onload = () => resolve();
          link.onerror = () => resolve();
        });
      });
      const html = hbfm.render(`${markdown}\n\n&nbsp;\n\\column\n&nbsp;`, 0);
      doc.body.innerHTML = `<div class="brewRenderer"><div class="pages" lang="en"><div class="page" id="p1"><div class="columnWrapper">${html}</div></div></div></div>`;
      await Promise.all(loads);
      await waitForFonts({ document: doc, root: doc.body });
      if (!cancelled) onStatus('ready');
    };
    onStatus('loading');
    run().catch((error: unknown) => {
      if (!cancelled) onStatus('error', String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [markdown, theme, onStatus]);

  return <iframe ref={frame} className={styles.legacyFrame} title="Legacy render" data-testid="legacy-frame" />;
}
