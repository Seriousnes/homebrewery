// CSS text helpers for the HTML export (P6.4): url() tokens, comments, @font-face blocks and the
// selectors that decide whether a rule's images are needed. Pure string code (no DOM), so it runs
// and is tested anywhere.

/** One url() in CSS text. `start`/`end` cover the whole `url(…)` token. */
export interface CssUrlToken {
  start: number;
  end: number;
  /** The URL as written, CSS escapes resolved. */
  url: string;
}

// url("…") | url('…') | url(unquoted). Escapes (backslash + anything) are kept inside the match.
const URL_TOKEN = /url\(\s*(?:"((?:[^"\\\n]|\\[\s\S])*)"|'((?:[^'\\\n]|\\[\s\S])*)'|((?:[^)"'\s\\]|\\[\s\S])*))\s*\)/gi;

/** Resolves CSS escapes (`\22`, `\"`, `\\`, an escaped newline) in a string or url() value. */
export function unescapeCss(value: string): string {
  return value.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\s\S]))/g, (_whole, hex: string | undefined, char: string | undefined) => {
    if (hex !== undefined) {
      const code = parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code);
    }
    return char === '\n' || char === '\r\n' || char === '\r' || char === '\f' ? '' : (char ?? '');
  });
}

/** Every url() token of `css`, in order. */
export function cssUrlTokens(css: string): CssUrlToken[] {
  const tokens: CssUrlToken[] = [];
  for (const m of css.matchAll(URL_TOKEN)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    tokens.push({ start: m.index, end: m.index + m[0].length, url: unescapeCss(raw) });
  }
  return tokens;
}

/** The URLs of every url() in `css`, as written (escapes resolved). */
export function cssUrls(css: string): string[] {
  return cssUrlTokens(css).map((t) => t.url);
}

/** `url` as a double-quoted CSS url() token. */
export function cssUrlToken(url: string): string {
  return `url("${url.replace(/["\\\n\r\f]/g, (c) => (c === '"' ? '\\"' : c === '\\' ? '\\\\' : `\\${c.charCodeAt(0).toString(16)} `))}")`;
}

/**
 * Replaces url() tokens. `replace` gets each URL (escapes resolved) and returns the new URL, or
 * null to keep the token as written.
 */
export function replaceCssUrls(css: string, replace: (url: string) => string | null): string {
  let out = '';
  let last = 0;
  for (const token of cssUrlTokens(css)) {
    const next = replace(token.url);
    if (next === null) continue;
    out += css.slice(last, token.start) + cssUrlToken(next);
    last = token.end;
  }
  return last === 0 ? css : out + css.slice(last);
}

/** `css` without comments (strings are left alone, so `content: "/*"` survives). */
export function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      // Keep tokens apart (`a/**/b` is two tokens).
      if (out && !/\s$/.test(out)) out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * CSS made safe to put inside <style>: every `<` becomes the CSS escape `\3c `, which means the same
 * character inside strings and url()s and can't appear anywhere else in valid CSS. So no CSS text
 * (a brew's `content: "</style><script>…"`) can close the element or start markup.
 */
export function cssForStyleElement(css: string): string {
  return css.replace(/</g, '\\3c ');
}

/** A top-level @font-face block. */
export interface FontFaceBlock {
  start: number;
  end: number;
  /** The block's text with whitespace collapsed (for comparing). */
  key: string;
}

/**
 * Top-level @font-face blocks of `css` (comments should be stripped first). Blocks inside
 * @media/@supports are left out: they are rare and conditional.
 */
export function fontFaceBlocks(css: string): FontFaceBlock[] {
  const blocks: FontFaceBlock[] = [];
  let depth = 0;
  let i = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '@' && depth === 0 && /^@font-face\b/i.test(css.slice(i, i + 11))) {
      const open = css.indexOf('{', i);
      const close = open < 0 ? -1 : css.indexOf('}', open);
      if (close < 0) break;
      blocks.push({ start: i, end: close + 1, key: css.slice(i, close + 1).replace(/\s+/g, ' ').trim() });
      i = close + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

/**
 * Removes @font-face blocks that repeat an earlier identical block (several themes of a chain
 * import the same font files: Blank and Journal, Blank and UnearthedArcana). Identical rules
 * define identical faces, so only the first is kept, and its font is inlined once. Pass the same
 * `seen` set for every stylesheet of a document to compare across them.
 */
export function dedupeFontFaces(css: string, seen: Set<string> = new Set()): { css: string; removed: number } {
  let out = '';
  let last = 0;
  let removed = 0;
  for (const block of fontFaceBlocks(css)) {
    if (!seen.has(block.key)) {
      seen.add(block.key);
      continue;
    }
    out += css.slice(last, block.start);
    last = block.end;
    removed++;
  }
  return { css: removed ? out + css.slice(last) : css, removed };
}

// Pseudo-elements (a rule for `x::before` needs its images when an x exists) and the user-action
// pseudo-classes (state a static page may still reach: hover, focus, a followed link). Legacy
// single-colon pseudo-elements too.
const PSEUDO_ELEMENT = /::[a-zA-Z-]+(?:\([^()]*\))?|:(?:before|after|first-letter|first-line)(?![\w-])/g;
const USER_STATE = /:(?:hover|active|focus|focus-visible|focus-within|visited|target|target-within)(?![\w-])/g;

/**
 * The selector that finds the elements a rule could style, for querySelector: pseudo-elements and
 * user-action pseudo-classes removed (`.page .note::before:hover` → `.page .note`). A selector
 * left ending in a combinator gets `*` (`.page > ::marker` → `.page > *`).
 */
export function elementSelector(selector: string): string {
  let s = selector.replace(PSEUDO_ELEMENT, '').replace(USER_STATE, '');
  if (/^\s*$/.test(s) || /[\s>+~]$/.test(s)) s += '*';
  return s.trim();
}
