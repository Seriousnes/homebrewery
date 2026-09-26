// HTML of the live table of contents, exactly as upstream's TOC snippet rendered it (plan §3.2
// CSS contract: div.block.toc[.wide] › ul › li › a › span + span, so the theme's dot leaders
// apply). Upstream's generator wrote markdown like
//
//   {{toc,wide
//   # Contents
//
//   - ### [{{ Chapter}}{{ 3}}](#p3)
//     - #### [{{ Section}}{{ 4}}](#p4)
//       - [{{ Subsection}}{{ 4}}](#p4)
//   }}
//
// and marked turned it into the markup below, whitespace text nodes included. The only
// differences: no ids on the TOC's own headings (they duplicated real heading ids), and links
// point at the heading ('#<id>') rather than its page.
import { tocTree, type TocEntry, type TocTreeItem } from './computeToc';

export interface TocRenderAttrs {
  title: string;
  wide: boolean;
  depth: number;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** Heading tag upstream wrapped entries of a nesting level in (### and ####), or null. */
export const entryWrapper = (nest: number): 'h3' | 'h4' | null => (nest === 0 ? 'h3' : nest === 1 ? 'h4' : null);

function linkHtml(entry: TocEntry): string {
  return `<a href="${escapeHtml(entry.href)}"><span class="inline-block">${escapeHtml(entry.text)}</span><span class="inline-block">${escapeHtml(entry.page)}</span></a>`;
}

function listHtml(items: readonly TocTreeItem[]): string {
  return `<ul>\n${items.map(itemHtml).join('')}</ul>\n`;
}

function itemHtml(item: TocTreeItem): string {
  const wrapper = entryWrapper(item.entry.nest);
  const link = linkHtml(item.entry);
  const head = wrapper ? `<${wrapper}>${link}</${wrapper}>\n` : link;
  const children = item.children.length ? listHtml(item.children) : '';
  return `<li>${head}${children}</li>\n`;
}

/** The inside of div.block.toc: the title h1, then the list (none without entries). */
export function tocInnerHtml(title: string, entries: readonly TocEntry[]): string {
  const heading = `<h1>${escapeHtml(title)}</h1>`;
  return entries.length ? `${heading}\n${listHtml(tocTree(entries))}` : `${heading}\n`;
}

/** Class attribute of the toc's div. */
export const tocClass = (wide: boolean): string => (wide ? 'block toc wide' : 'block toc');

/** The whole toc element as HTML (static export, share view). */
export function tocHtml(attrs: TocRenderAttrs, entries: readonly TocEntry[]): string {
  return `<div class="${tocClass(attrs.wide)}" data-depth="${attrs.depth}">${tocInnerHtml(attrs.title, entries)}</div>`;
}
