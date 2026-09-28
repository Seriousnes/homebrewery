// Upstream's V3 preview, reproduced for the S3 fidelity harness (plan §7): the brew is split
// and rendered page by page exactly as legacy/client/homebrew/brewRenderer/brewRenderer.jsx
// does it, with marked-hbfm itself (dev only: marked-variables included, as upstream), the
// trailing `&nbsp; \column &nbsp;` hack (brewRenderer.jsx:216-217) and upstream's safeHTML.
import { hbfm, type HbfmInjectedTags } from 'marked-hbfm';
import { splitTextStyleAndMetadata } from '@/editor/import/brewText';
import { PAGE_SPLIT } from '@/editor/import/pages';
import { safeHTML } from './safeHtml';

export interface LegacyPage {
  /** The page's HTML after safeHTML. */
  html: string;
  classes: string[];
  styles: Record<string, string>;
  attributes: Record<string, string>;
}

export interface LegacyBrew {
  pages: LegacyPage[];
  style: string;
  theme: string;
  lang: string;
}

const COLUMN_HACK = `\n\n&nbsp;\n\\column\n&nbsp;`;

function renderPage(rawPage: string, index: number): LegacyPage {
  let pageText = rawPage;
  let tags: HbfmInjectedTags | undefined;
  if (pageText.startsWith('\\page')) {
    const first = hbfm.marked.lexer(pageText.split('\n', 1)[0] ?? '')[0] as { tokens?: Array<{ injectedTags?: HbfmInjectedTags }> } | undefined;
    tags = first?.tokens?.find((t) => t.injectedTags !== undefined)?.injectedTags;
    pageText = pageText.includes('\n') ? pageText.substring(pageText.indexOf('\n') + 1) : '';
  }
  pageText += COLUMN_HACK;
  return {
    html: safeHTML(hbfm.render(pageText, index)),
    classes: (tags?.classes ?? '').split(/\s+/).filter(Boolean),
    styles: { ...tags?.styles },
    attributes: { ...tags?.attributes },
  };
}

/**
 * Renders a brew text like upstream's preview. Every page is rendered twice: upstream
 * force-renders pages with variables after the first pass so cross-page variables resolve
 * (brewRenderer.jsx:224-243); rendering all of them again gives the same HTML for the others.
 */
export function renderLegacyBrew(text: string): LegacyBrew {
  const brew = splitTextStyleAndMetadata({ text });
  if (brew.renderer === 'legacy') throw new Error('Legacy-renderer brews are not rendered by this harness.');
  const rawPages = brew.text.split(PAGE_SPLIT);
  rawPages.forEach((page, i) => renderPage(page, i));
  return {
    pages: rawPages.map((page, i) => renderPage(page, i)),
    style: brew.style ?? '',
    theme: brew.theme ?? '5ePHB',
    lang: brew.lang || 'en',
  };
}
