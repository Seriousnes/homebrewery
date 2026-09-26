// HTML text of the export (P6.4): a small serializer for the pages' DOM, and the document shell.
//
// The browser's own serializer (outerHTML) leaves `<` and `>` in attribute values as they are, so
// an alt text or a TOC entry reading "<script>" would appear literally in the file. This one
// escapes them in text and attributes alike, drops comments, and writes <style> text through
// cssForStyleElement: nothing in the output can open or close an element except the elements
// themselves (the exported file must contain no <script>, and must look like it).
import { cssForStyleElement } from './cssText';

const XHTML = 'http://www.w3.org/1999/xhtml';

/** Elements without an end tag (HTML's void elements). */
const VOID = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** `text` escaped for an HTML text node. */
export function escapeText(text: string): string {
  return text.replace(/[&<>\u00a0]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&nbsp;'));
}

/** `value` escaped for a double-quoted attribute value. */
export function escapeAttribute(value: string): string {
  return value.replace(/[&"<>\u00a0]/g, (c) => (c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&nbsp;'));
}

/** An attribute name the HTML parser reads back as the same name. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what it rejects
const SAFE_ATTRIBUTE_NAME = /^[^\s"'>/=\u0000-\u001f\u007f]+$/;

function serializeNode(node: Node, out: string[]): void {
  if (node.nodeType === 3) {
    const parent = node.parentNode as Element | null;
    const text = node.nodeValue ?? '';
    out.push(parent?.localName === 'style' ? cssForStyleElement(text) : escapeText(text));
    return;
  }
  if (node.nodeType === 11) {
    for (const child of Array.from(node.childNodes)) serializeNode(child, out);
    return;
  }
  if (node.nodeType !== 1) return; // comments, processing instructions: dropped
  const el = node as Element;
  const html = el.namespaceURI === XHTML || el.namespaceURI === null;
  const name = html ? el.localName : el.tagName;
  out.push(`<${name}`);
  for (const attr of Array.from(el.attributes)) {
    if (!SAFE_ATTRIBUTE_NAME.test(attr.name)) continue;
    out.push(` ${attr.name}="${escapeAttribute(attr.value)}"`);
  }
  out.push('>');
  if (html && VOID.has(name)) return;
  const content = html && name === 'template' ? (el as HTMLTemplateElement).content : el;
  for (const child of Array.from(content.childNodes)) serializeNode(child, out);
  out.push(`</${name}>`);
}

/** The HTML text of `node` (the element itself and its content). */
export function serializeHtml(node: Node): string {
  const out: string[] = [];
  serializeNode(node, out);
  return out.join('');
}

export interface ExportDocumentParts {
  lang: string;
  title: string;
  /** Stylesheets in cascade order, with a name for data-hb-export (theme, editor, brew …). */
  styles: { name: string; css: string }[];
  /** The body's content: div.pages (HTML text). */
  pages: string;
}

/**
 * The Content-Security-Policy of the exported file: no scripts, plugins, <base> or form targets,
 * whatever the brew's HTML holds. Images, fonts and styles may still come from anywhere (images
 * of other sites stay links).
 */
export const EXPORT_CSP = "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** The generator meta of exported files (tests and tools recognise them by it). */
export const EXPORT_GENERATOR = 'The Homebrewery (HTML export)';

/**
 * The exported file: <html lang> › <head> (charset, CSP, title, the stylesheets) › <body
 * class="hb-canvas" lang> › div.pages. The body plays the editor's div.hb-canvas, so the scoped
 * theme CSS (`:root`, `html` and `body` rewritten to .hb-canvas) applies as it does in the editor.
 */
export function exportDocumentHtml(parts: ExportDocumentParts): string {
  const lang = escapeAttribute(parts.lang || 'en');
  const styles = parts.styles
    .filter((s) => s.css.trim() !== '')
    .map((s) => `<style data-hb-export="${escapeAttribute(s.name)}">\n${cssForStyleElement(s.css)}\n</style>`);
  return [
    '<!DOCTYPE html>',
    `<html lang="${lang}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(EXPORT_CSP)}">`,
    `<meta name="generator" content="${escapeAttribute(EXPORT_GENERATOR)}">`,
    `<title>${escapeText(parts.title)}</title>`,
    ...styles,
    '</head>',
    `<body class="hb-canvas" lang="${lang}">`,
    parts.pages,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
