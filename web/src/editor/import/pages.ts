// Page splitting and `\page {…}` lines, as upstream's V3 renderer does them
// (legacy/client/homebrew/brewRenderer/brewRenderer.jsx:23, 190-203).
import type { InjectedTags } from './hbfm/renderer';

/** Splits before every `\page` / `\pagebreak` line, optionally with `{…}` tags (brewRenderer.jsx:23). */
export const PAGE_SPLIT = /^(?=\\page(?:break)?(?: *{[^\n{}]*})?$)/m;

/** The brew text split into pages (the first page may start with its own \page line). */
export function splitPages(text: string): string[] {
  return text.split(PAGE_SPLIT);
}

export const hasPageLine = (page: string): boolean => page.startsWith('\\page');

/** The page without its leading `\page …` line (brewRenderer.jsx:212). */
export function stripPageLine(page: string): string {
  if (!hasPageLine(page)) return page;
  return page.includes('\n') ? page.substring(page.indexOf('\n') + 1) : '';
}

/** The first line of a page when it is a `\page` line, else null. */
export function pageLine(page: string): string | null {
  return hasPageLine(page) ? (page.split('\n', 1)[0] ?? null) : null;
}

/** Page shell settings from `\page {classes,styles,attrs}`. */
export interface PageShell {
  classes: string[];
  styles: Record<string, string>;
  attributes: Record<string, string>;
}

export const EMPTY_SHELL: PageShell = { classes: [], styles: {}, attributes: {} };

export function pageShellFromTags(tags: InjectedTags | null): PageShell {
  if (!tags) return EMPTY_SHELL;
  return {
    classes: (tags.classes ?? '').split(/\s+/).filter(Boolean),
    styles: { ...(tags.styles ?? {}) },
    attributes: { ...(tags.attributes ?? {}) },
  };
}

/** Attribute names never copied from a `\page` line onto the page element. */
const BLOCKED_ATTR = /^(?:on|class$|style$|id$|src$|href$|srcdoc$|formaction$)/i;
const VALID_ATTR = /^[a-z_][\w:.-]*$/i;

/**
 * The page element upstream renders around one page's HTML: div.page[.classes][style][attrs] ›
 * div.columnWrapper (brewRenderer.jsx:82-84). Styles are set one property at a time, as React
 * did with the style object. `extra` attributes (data-kind, …) are added as given.
 */
export function buildPageElement(doc: Document, shell: PageShell, innerHtml: string, extra: Record<string, string> = {}): HTMLElement {
  const page = doc.createElement('div');
  page.className = ['page', ...shell.classes].join(' ');
  for (const [key, value] of Object.entries(shell.styles)) {
    try {
      page.style.setProperty(key, value);
    } catch {
      // invalid property name: dropped, as React would
    }
  }
  for (const [key, value] of Object.entries(shell.attributes)) {
    if (!VALID_ATTR.test(key) || BLOCKED_ATTR.test(key)) continue;
    try {
      page.setAttribute(key, value);
    } catch {
      // invalid attribute name
    }
  }
  for (const [key, value] of Object.entries(extra)) page.setAttribute(key, value);
  const wrapper = doc.createElement('div');
  wrapper.className = 'columnWrapper';
  wrapper.innerHTML = innerHtml;
  page.appendChild(wrapper);
  return page;
}
