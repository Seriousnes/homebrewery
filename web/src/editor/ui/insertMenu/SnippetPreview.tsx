// A snippet's preview (the Insert snippet gallery): its pages (snippets/preview.ts) as static
// HTML in div.hb-canvas › div.pages › div.page › div.columnWrapper in this document, so the
// theme's stylesheets and the brew's CSS (both scoped to .hb-canvas, document-wide) style it as
// they style the editor. CSS the snippet itself carries is adopted for this preview only.
//
// Scaled to fit: a block snippet shows the top of its page down to the end of its content, at
// most at 100 %, fitted to the box's width; page snippets and native snippets show whole pages,
// the first one fitted into the box. The box scrolls when there is more (it is then a Tab stop).
// The rendering is decorative for assistive technology (aria-hidden, inert): the box is a named
// group, and the caption says what the snippet does.
import '@/editor/canvas/canvas.css';
import clsx from 'clsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { scopeCss } from '@/editor/canvas/cssScope';
import { renderPreviewPages, type SnippetPreview } from '@/editor/snippets/preview';
import styles from './SnippetPreview.module.css';

export interface SnippetPreviewViewProps {
  preview: SnippetPreview;
  /** The group's name (e.g. "Preview of Monster Stat Block"). */
  label: string;
  /** The brew's language (hyphenation), as on the editor's canvas. */
  lang?: string;
  className?: string;
  'data-testid'?: string;
}

/** Padding of the box (SnippetPreview.module.css .box). */
const BOX_PADDING = 12;
/** Room below a block snippet's content (CSS px of the page). */
const CONTENT_MARGIN = 48;
/** The smallest crop of a block snippet (CSS px of the page). */
const MIN_CROP = 160;
/** Gap between stacked pages (CSS px of the page). */
export const PAGE_GAP = 24;

interface Layout {
  scale: number;
  /** Page width and the height shown, in CSS px of the page. */
  width: number;
  height: number;
  scrolls: boolean;
}

const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, iframe, summary, audio[controls], video[controls], [tabindex], [contenteditable="true"]';

let nextScope = 0;

/** Adopts `css`, scoped to `scope`, into `doc`; returns its removal. */
function adoptScopedCss(doc: Document, css: string, scope: string): (() => void) | undefined {
  if (!('adoptedStyleSheets' in doc)) return undefined;
  let sheet: CSSStyleSheet;
  try {
    sheet = scopeCss(css, doc.baseURI, scope);
  } catch {
    return undefined; // CSS the CSSOM can't parse: the preview goes without it
  }
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  return () => {
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
  };
}

export function SnippetPreviewView({ preview, label, lang = 'en', className, 'data-testid': testId }: SnippetPreviewViewProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [scopeClass] = useState(() => `hb-snippet-preview-${++nextScope}`);
  const [layout, setLayout] = useState<Layout | null>(null);

  // The pages, and the measurements that fit them into the box.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const pages = renderPreviewPages(preview, canvas.ownerDocument);
    if (!pages) return;
    pages.classList.add(styles.pages!);
    // Inert already keeps the focus out; no Tab stops inside aria-hidden content either.
    for (const el of Array.from(pages.querySelectorAll(FOCUSABLE))) el.setAttribute('tabindex', '-1');
    canvas.replaceChildren(pages);

    const measure = () => {
      const pageEls = Array.from(pages.querySelectorAll<HTMLElement>(':scope > .page'));
      const first = pageEls[0];
      if (!first || !first.offsetWidth) return;
      const width = first.offsetWidth;
      const pageHeight = first.offsetHeight;
      const available = Math.max(1, box.clientWidth - 2 * BOX_PADDING);
      const availableHeight = Math.max(1, box.clientHeight - 2 * BOX_PADDING);
      let height: number;
      let scale: number;
      if (preview.fit === 'content') {
        // The canvas may already be scaled: rects in page px are rect / current scale.
        const pageRect = first.getBoundingClientRect();
        const current = pageRect.width / width || 1;
        let bottom = 0;
        for (const el of Array.from(first.querySelectorAll(':scope > .columnWrapper > *'))) {
          bottom = Math.max(bottom, (el.getBoundingClientRect().bottom - pageRect.top) / current);
        }
        height = Math.min(pageHeight, Math.max(MIN_CROP, Math.ceil(bottom + CONTENT_MARGIN)));
        scale = Math.min(1, available / width);
      } else {
        height = pageEls.reduce((sum, el) => sum + el.offsetHeight, 0) + PAGE_GAP * (pageEls.length - 1);
        scale = Math.min(1, available / width, availableHeight / pageHeight);
      }
      scale = Math.floor(scale * 1000) / 1000;
      const scrolls = height * scale > availableHeight + 1;
      setLayout((old) =>
        old && old.scale === scale && old.width === width && old.height === height && old.scrolls === scrolls ? old : { scale, width, height, scrolls },
      );
    };
    measure();

    // Images and fonts that arrive later change the content's height.
    const onLoad = () => measure();
    canvas.addEventListener('load', onLoad, true);
    const fonts = (canvas.ownerDocument as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.addEventListener('loadingdone', onLoad);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    observer?.observe(box);
    return () => {
      canvas.removeEventListener('load', onLoad, true);
      fonts?.removeEventListener('loadingdone', onLoad);
      observer?.disconnect();
      canvas.replaceChildren();
    };
  }, [preview]);

  // CSS the snippet adds to the brew's style, for this preview only.
  useEffect(() => {
    const doc = canvasRef.current?.ownerDocument;
    if (!doc || !preview.style.trim()) return;
    return adoptScopedCss(doc, preview.style, `.hb-canvas.${scopeClass}`);
  }, [preview, scopeClass]);

  const frameStyle = layout ? { width: `${layout.width * layout.scale}px`, height: `${layout.height * layout.scale}px` } : undefined;
  const canvasStyle = layout ? { width: `${layout.width}px`, transform: `scale(${layout.scale})` } : undefined;

  return (
    <div
      ref={boxRef}
      role="group"
      aria-label={label}
      // A scrolling preview is a Tab stop, for scrolling with the keyboard.
      tabIndex={layout?.scrolls ? 0 : undefined}
      className={clsx(styles.box, className)}
      data-testid={testId}
      data-fit={preview.fit}
      data-scale={layout?.scale}
    >
      <div className={styles.frame} style={frameStyle} data-measured={layout ? 'true' : 'false'}>
        <div ref={canvasRef} className={clsx('hb-canvas', scopeClass, styles.canvas)} style={canvasStyle} lang={lang} aria-hidden="true" inert />
      </div>
    </div>
  );
}

