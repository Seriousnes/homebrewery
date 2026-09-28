import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import styles from './ThemePreview.module.css';

export interface ThemePreviewProps {
  /** The sample: elements as the editor emits them (plan §3.2 CSS contract), e.g. <h1>, div.block.note. */
  children?: ReactNode;
  /** The sample as HTML instead of children: trusted or sanitized HTML only (it is inserted as is). */
  html?: string;
  /** Show the theme's page background behind the sample (default: none). */
  background?: boolean;
  /** Hidden from assistive technology (default true): the embedding item carries the name. */
  decorative?: boolean;
  className?: string;
  /** e.g. { '--hb-preview-padding': '10px 20px', '--hb-preview-zoom': 0.8 } (ThemePreview.module.css). */
  style?: CSSProperties;
  'data-testid'?: string;
}

/**
 * A live preview of content in the active theme's style: `div.hb-canvas > div.page > sample`. The
 * theme's CSS (and the brew's own), scoped to .hb-canvas, applies to it as to the editing canvas;
 * the preview's own rules take away the page (size, background, padding, columns, decorations),
 * so a heading looks like the theme's heading in a menu row. Without a theme loaded (tests), the
 * sample shows in the upstream base style.
 *
 *   <ThemePreview><h1>Heading 1</h1></ThemePreview>
 *   <ThemePreview html={sanitizedSnippetHtml} background />
 */
export function ThemePreview({ children, html, background = false, decorative = true, className, style, 'data-testid': testId }: ThemePreviewProps) {
  return (
    <div
      className={clsx('hb-canvas', styles.root, className)}
      style={style}
      aria-hidden={decorative || undefined}
      data-background={background ? '' : undefined}
      data-hb-theme-preview=""
      data-testid={testId}
    >
      {html !== undefined ? <div className="page" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="page">{children}</div>}
    </div>
  );
}
