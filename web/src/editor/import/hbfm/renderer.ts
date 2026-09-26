// Homebrewery-flavoured markdown (HBFM) renderer for the importer and snippets.
//
// A port of marked-hbfm 1.0.1 (MIT, naturalcrit/marked-hbfm, src/index.js) that renders the
// same HTML with one change: the variables extension is ./variables.ts instead of
// marked-variables (whose math evaluator, expr-eval, has unpatched prototype-pollution /
// code-execution advisories; imports are other people's brews). Unlike marked-hbfm, which
// installs everything on marked's global instance, every call to createHbfmRenderer() builds
// its own `Marked` instance with its own variables, so renders can't leak into each other.
//
// Tested against marked-hbfm's output (renderer.test.ts) on the S3 fixtures (tests/markdown
// cases, welcome_msg.md, the theme snippets), and with upstream's own tests/markdown suites
// (upstreamSuite.test.ts). Nothing here imports marked-hbfm, marked-variables or expr-eval
// (noUpstreamVariables.test.ts checks that).
import { Marked, type MarkedExtension, type RendererThis, type TokenizerAndRendererExtension, type TokenizerThis, type Tokens } from 'marked';
import MarkedAlignedParagraphs from 'marked-alignment-paragraphs';
import MarkedDefinitionLists from 'marked-definition-lists';
import MarkedDiagramsMarkdeep from 'marked-diagrams-markdeep';
import { markedEmoji as MarkedEmojis } from 'marked-emoji';
import MarkedExtendedTables from 'marked-extended-tables';
import { gfmHeadingId as MarkedGFMHeadingId, resetHeadings as MarkedGFMResetHeadingIDs } from 'marked-gfm-heading-id';
import MarkedNonbreakingSpaces from 'marked-nonbreaking-spaces';
import { markedSmartypantsLite as MarkedSmartypantsLite } from 'marked-smartypants-lite';
import MarkedSubSuperText from 'marked-subsuper-text';
import diceFont from '@themes/fonts/iconFonts/diceFont.js';
import elderberryInn from '@themes/fonts/iconFonts/elderberryInn.js';
import fontAwesome from '@themes/fonts/iconFonts/fontAwesome.js';
import gameIcons from '@themes/fonts/iconFonts/gameIcons.js';
import { BrewVariables } from './variables';

/** Tags from {{…}} / {…} injection, e.g. `\page {pink,color:red,#id,data-x=1}`. */
export interface InjectedTags {
  id: string | null;
  classes: string | null;
  styles: Record<string, string> | null;
  attributes: Record<string, string> | null;
}

export interface HbfmRenderer {
  /** The configured marked instance (lexer for `\page {…}` lines). */
  readonly marked: Marked;
  /** Renders one page. Pages share variables; page 0 resets heading slugs (as hbfm.render). */
  render(rawBrewText: string, pageNumber?: number): string;
  /** The injected tags of a `\page {…}` line, as upstream reads them (brewRenderer.jsx:190-203). */
  pageLineTags(line: string): InjectedTags | null;
  /** Variables state (definitions found, unresolved calls). */
  readonly variables: BrewVariables;
}

// ---------------------------------------------------------------------------------------------
// Helpers (marked-hbfm src/index.js:385-490)
// ---------------------------------------------------------------------------------------------

const isEmpty = (value: object | null | undefined): boolean => !value || Object.keys(value).length === 0;

/** lodash's _.remove: removes matching items from `array` in place and returns them. */
function remove<T>(array: T[] | null, predicate: (item: T) => boolean): T[] {
  if (!array) return [];
  const removed: T[] = [];
  for (let i = 0; i < array.length; ) {
    if (predicate(array[i]!)) removed.push(...array.splice(i, 1));
    else i++;
  }
  return removed;
}

const setKey = (obj: Record<string, string>, key: string, value: string): Record<string, string> => {
  if (key !== '__proto__') obj[key] = value;
  return obj;
};

export function processStyleTags(input: string): InjectedTags {
  // Split tags up. Quotes can only occur right after : or =.
  const tags = input.match(/(?:[^, ":=]+|[:=](?:"[^"]*"|))+/g);
  const id = remove(tags, (tag) => tag.startsWith('#')).map((tag) => tag.slice(1))[0] || null;
  const classes = remove(tags, (tag) => !tag.includes(':') && !tag.includes('=')).join(' ') || null;
  const attributes =
    remove(tags, (tag) => tag.includes('='))
      .map((tag) => tag.replace(/="?([^"]*)"?/g, '="$1"'))
      .filter((attr) => !attr.startsWith('class="') && !attr.startsWith('style="') && !attr.startsWith('id="'))
      .reduce<Record<string, string>>((obj, attr) => {
        const index = attr.indexOf('=');
        const key = attr.substring(0, index);
        const value = attr.substring(index + 1).replace(/"/g, '');
        return setKey(obj, key.trim(), value.trim());
      }, {}) || null;
  const styles = tags?.length
    ? tags.reduce<Record<string, string>>((styleObj, style) => {
        const index = style.indexOf(':');
        const key = style.substring(0, index);
        const value = style.substring(index + 1);
        return setKey(styleObj, key.trim(), value.replace(/"?([^"]*)"?/g, '$1').trim());
      }, {})
    : null;
  return {
    id,
    classes,
    styles: isEmpty(styles) ? null : styles,
    attributes: isEmpty(attributes) ? null : attributes,
  };
}

/** The properties of the first element of an HTML string (id, class, style, other attributes). */
function extractHTMLStyleTags(htmlString: string): InjectedTags {
  const firstElementOnly = htmlString.split('>')[0] ?? '';
  const id = /id="([^"]*)"/.exec(firstElementOnly)?.[1] || null;
  const classes = /class="([^"]*)"/.exec(firstElementOnly)?.[1] || null;
  const styles =
    /style="([^"]*)"/
      .exec(firstElementOnly)?.[1]
      ?.split(';')
      .reduce<Record<string, string>>((styleObj, style) => {
        if (style.trim() === '') return styleObj;
        const index = style.indexOf(':');
        return setKey(styleObj, style.substring(0, index).trim(), style.substring(index + 1).trim());
      }, {}) || null;
  const attributes =
    firstElementOnly
      .match(/[a-zA-Z]+="[^"]*"/g)
      ?.filter((attr) => !attr.startsWith('class="') && !attr.startsWith('style="') && !attr.startsWith('id="'))
      .reduce<Record<string, string>>((obj, attr) => {
        const index = attr.indexOf('=');
        return setKey(obj, attr.substring(0, index).trim(), attr.substring(index + 1).replace(/"/g, ''));
      }, {}) || null;
  return {
    id,
    classes,
    styles: isEmpty(styles) ? null : styles,
    attributes: isEmpty(attributes) ? null : attributes,
  };
}

function mergeHTMLTags(originalTags: InjectedTags, newTags: InjectedTags) {
  return {
    id: newTags.id || originalTags.id || null,
    classes: [originalTags.classes, newTags.classes].join(' ').trim() || null,
    styles: Object.assign(originalTags.styles ?? {}, newTags.styles ?? {}),
    attributes: Object.assign(originalTags.attributes ?? {}, newTags.attributes ?? {}),
  };
}

const styleAttr = (styles: Record<string, string>): string =>
  ` style="${Object.entries(styles)
    .map(([key, value]) => `${key}:${value};`)
    .join(' ')}"`;
const otherAttrs = (attributes: Record<string, string>): string =>
  ` ${Object.entries(attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ')}`;

/** Re-writes the opening tag of `text` with merged tags (mustacheInject* renderers). */
function injectTags(text: string, injected: InjectedTags): string {
  const tags = mergeHTMLTags(extractHTMLStyleTags(text), injected);
  const openingTag = /(<[^\s<>]+)[^\n<>]*(>.*)/s.exec(text);
  if (!openingTag) return text;
  return (
    `${openingTag[1]}` +
    `${tags.classes ? ` class="${tags.classes}"` : ''}` +
    `${tags.id ? ` id="${tags.id}"` : ''}` +
    `${!isEmpty(tags.styles) ? styleAttr(tags.styles) : ''}` +
    `${!isEmpty(tags.attributes) ? otherAttrs(tags.attributes) : ''}` +
    `${openingTag[2]}`
  );
}

function cleanUrl(href: string): string | null {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!#?\w+;)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!#?\w+;)/g;
const ESCAPE_REPLACEMENTS: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (html: string): string =>
  ESCAPE_TEST_NO_ENCODE.test(html) ? html.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_REPLACEMENTS[ch] ?? ch) : html;

// ---------------------------------------------------------------------------------------------
// Extensions (marked-hbfm src/index.js:26-340)
// ---------------------------------------------------------------------------------------------

type InjectableToken = Tokens.Generic & { originalType?: string; injectedTags?: InjectedTags };

/** Finds the closing }} of a {{…}} span or block; returns the token fields or undefined. */
function matchMustache(src: string, whole: string, delimRegex: RegExp, block: boolean) {
  let blockCount = 0;
  let tags: InjectedTags | Record<string, never> = {};
  let endTags = 0;
  let endToken = 0;
  let delim: string | undefined;
  delimRegex.lastIndex = 0;
  while ((delim = block ? delimRegex.exec(whole)?.[0].trim() : delimRegex.exec(whole)?.[0])) {
    if (isEmpty(tags)) {
      tags = processStyleTags(delim.substring(2));
      endTags = block ? delim.length + src.indexOf(delim) : delim.length;
    }
    if (delim.startsWith('{{')) blockCount++;
    else if (delim === '}}' && blockCount !== 0) {
      blockCount--;
      if (blockCount === 0) {
        endToken = delimRegex.lastIndex;
        break;
      }
    }
  }
  if (!endToken) return undefined;
  const raw = src.slice(0, endToken);
  return { raw, text: raw.slice(endTags || -2, -2), tags: tags as InjectedTags };
}

const mustacheSpans: TokenizerAndRendererExtension = {
  name: 'mustacheSpans',
  level: 'inline',
  start(src) {
    return /{{[^{]/.exec(src)?.index;
  },
  tokenizer(this: TokenizerThis, src) {
    const completeSpan = /^{{[^\n]*}}/;
    const inlineRegex = /{{(?=((?:[:=](?:"['\w,\-+*/()#%=?.&:!@$^;:[\]_= ]*"|[\w\-+*/()#%.]*)|[^"=':{}\s]*)*))\1 *|}}/g;
    const match = completeSpan.exec(src);
    if (!match) return undefined;
    const found = matchMustache(src, match[0], inlineRegex, false);
    if (!found) return undefined;
    return { type: 'mustacheSpans', raw: found.raw, text: found.text, tags: found.tags, tokens: this.lexer.inlineTokens(found.text) };
  },
  renderer(this: RendererThis, token) {
    const tags = token.tags as InjectedTags;
    tags.classes = ['inline-block', tags.classes].join(' ').trim();
    return (
      `<span` +
      `${tags.classes ? ` class="${tags.classes}"` : ''}` +
      `${tags.id ? ` id="${tags.id}"` : ''}` +
      `${tags.styles ? styleAttr(tags.styles) : ''}` +
      `${tags.attributes ? otherAttrs(tags.attributes) : ''}` +
      `>${this.parser.parseInline(token.tokens ?? [])}</span>`
    );
  },
};

const mustacheDivs: TokenizerAndRendererExtension = {
  name: 'mustacheDivs',
  level: 'block',
  start(src) {
    return /\n *{{[^{]/m.exec(src)?.index;
  },
  tokenizer(this: TokenizerThis, src) {
    const completeBlock = /^ *{{[^\n}]* *\n.*\n *}}/s;
    const blockRegex = /^ *{{(?=((?:[:=](?:"['\w,\-+*/()#%=?.&:!@$^;:[\]_= ]*"|[\w\-()#%.]*)|[^"=':{}\s]*)*))\1 *$|^ *}}$/gm;
    const match = completeBlock.exec(src);
    if (!match) return undefined;
    const found = matchMustache(src, match[0], blockRegex, true);
    if (!found) return undefined;
    return { type: 'mustacheDivs', raw: found.raw, text: found.text, tags: found.tags, tokens: this.lexer.blockTokens(found.text) };
  },
  renderer(this: RendererThis, token) {
    const tags = token.tags as InjectedTags;
    tags.classes = ['block', tags.classes].join(' ').trim();
    return (
      `<div` +
      `${tags.classes ? ` class="${tags.classes}"` : ''}` +
      `${tags.id ? ` id="${tags.id}"` : ''}` +
      `${tags.styles ? styleAttr(tags.styles) : ''}` +
      `${tags.attributes ? otherAttrs(tags.attributes) : ''}` +
      `>${this.parser.parse(token.tokens ?? [])}</div>`
    );
  },
};

const mustacheInjectInline: TokenizerAndRendererExtension = {
  name: 'mustacheInjectInline',
  level: 'inline',
  start(src) {
    return / *{[^{\n]/.exec(src)?.index;
  },
  tokenizer(src, tokens) {
    const inlineRegex = /^ *{(?=((?:[:=](?:"['\w,\-+*/()#%=?.&:!@$^;:[\]_= ]*"|[\w\-()#%.]*)|[^"=':{}\s]*)*))\1}/g;
    const match = inlineRegex.exec(src);
    if (!match) return undefined;
    const lastToken: InjectableToken | undefined = tokens[tokens.length - 1];
    if (!lastToken || lastToken.type === 'mustacheInjectInline') return undefined;
    lastToken.originalType = lastToken.type;
    lastToken.type = 'mustacheInjectInline';
    lastToken.injectedTags = processStyleTags(match[1] ?? '');
    return { type: 'mustacheInjectInline', raw: match[0], text: '' };
  },
  renderer(this: RendererThis, t) {
    const token = t as InjectableToken;
    if (!token.originalType) return '';
    token.type = token.originalType;
    const text = this.parser.parseInline([token]);
    return injectTags(text, token.injectedTags!);
  },
};

const mustacheInjectBlock: MarkedExtension = {
  extensions: [
    {
      name: 'mustacheInjectBlock',
      level: 'block',
      start(src) {
        return /\n *{[^{\n]/m.exec(src)?.index;
      },
      tokenizer(src, tokens) {
        const inlineRegex = /^ *{(?=((?:[:=](?:"['\w,\-+*/()#%=?.&:!@$^;:[\]_= ]*"|[\w\-+*/()#%.]*)|[^"=':{}\s]*)*))\1}/ym;
        const match = inlineRegex.exec(src);
        if (!match) return undefined;
        const lastToken: InjectableToken | undefined = tokens[tokens.length - 1];
        if (!lastToken || lastToken.type === 'mustacheInjectBlock') return undefined;
        lastToken.originalType = 'mustacheInjectBlock';
        lastToken.injectedTags = processStyleTags(match[1] ?? '');
        return { type: 'mustacheInjectBlock', raw: match[0], text: '' };
      },
      renderer(this: RendererThis, t) {
        const token = t as InjectableToken;
        if (!token.originalType) return '';
        token.type = token.originalType;
        const text = this.parser.parse([token]);
        return injectTags(text, token.injectedTags!);
      },
    },
  ],
  walkTokens(t) {
    // After the token tree is finished, tag tokens to apply styles to so the renderer finds them.
    // Doesn't work with tables (marked's table tokens can't change type).
    const token = t as InjectableToken;
    if (token.originalType === 'mustacheInjectBlock' && token.type !== 'table') {
      token.originalType = token.type;
      token.type = 'mustacheInjectBlock';
    }
  },
};

const forcedParagraphBreaks: TokenizerAndRendererExtension = {
  name: 'hardBreaks',
  level: 'block',
  start(src) {
    return /\n:+$/m.exec(src)?.index;
  },
  tokenizer(src) {
    const match = /^(:+)(?:\n|$)/ym.exec(src);
    if (!match?.length) return undefined;
    return { type: 'hardBreaks', raw: match[0], length: match[1]?.length ?? 0, text: '' };
  },
  renderer(token) {
    return `<div class='blank'></div>\n`.repeat(Number(token.length));
  },
};

const TABLE_TERMINATORS = [
  `:+\\n`, // hardBreak
  ` *{[^\n]+}`, // blockInjector
  ` *{{[^{\n]*\n.*?\n}}`, // mustacheDiv
];

// ---------------------------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------------------------

/**
 * How brew variables (`[name]: value`, `$[name]`, `$[1+2]`) are handled:
 *   'expand' (default)  substituted as upstream displayed them (safe port, ./variables.ts, ./math.ts)
 *   'keep'              left in the text as written; definitions and calls are only recorded
 */
export type VariablesMode = 'expand' | 'keep';

export interface HbfmRendererOptions {
  variables?: VariablesMode;
}

/** A fresh HBFM renderer (own marked instance and variables). */
export function createHbfmRenderer(options: HbfmRendererOptions = {}): HbfmRenderer {
  const marked = new Marked();
  const variables = new BrewVariables({ expand: (options.variables ?? 'expand') === 'expand' });

  marked.use(variables.extension());
  marked.use(MarkedDiagramsMarkdeep({ langs: ['asciiArt'] }));
  marked.use(MarkedDefinitionLists());
  marked.use({ extensions: [forcedParagraphBreaks, mustacheSpans, mustacheDivs, mustacheInjectInline] });
  marked.use(mustacheInjectBlock);
  marked.use(MarkedAlignedParagraphs());
  marked.use(MarkedSubSuperText());
  marked.use(MarkedNonbreakingSpaces());
  marked.use({
    renderer: {
      // Processes the markdown inside an HTML block when it is just a class wrapper.
      html(token) {
        let html = token.text;
        if (html.trim().startsWith('<div') && html.trim().endsWith('</div>')) {
          const openTag = html.substring(0, html.indexOf('>') + 1);
          html = html.substring(html.indexOf('>') + 1);
          html = html.substring(0, html.lastIndexOf('</div>'));
          // Repeat the markdown processing for the content, minus the global pre/postprocess hooks.
          const opts = marked.defaults;
          const tokens = marked.lexer(html, opts);
          void marked.walkTokens(tokens, opts.walkTokens ?? (() => undefined));
          return `${openTag} ${marked.parser(tokens, opts)} </div>`;
        }
        return html;
      },
      // Don't wrap {{ spans alone on a line, or {{ divs, in <p> tags.
      paragraph(token) {
        const text = this.parser.parseInline(token.tokens);
        let match: RegExpMatchArray | null;
        if (text.startsWith('<div') || text.startsWith('</div')) return `${text}`;
        else if ((match = /(^|^.*?\n)<span class="inline-block(.*?<\/span>)$/.exec(text)))
          return `${match[1]?.trim() ? `<p>${match[1]}</p>` : ''}<span class="inline-block${match[2]}`;
        return `<p>${text}</p>\n`;
      },
      link(token) {
        const text = this.parser.parseInline(token.tokens);
        const href = cleanUrl(token.href);
        if (href === null) return text;
        let out = `<a href="${escape(href)}"`;
        if (token.title) out += ` title="${escape(token.title)}"`;
        return `${out}>${text}</a>`;
      },
      // Expose the src as --HB_src so CSS can use the URL.
      image(token) {
        const { href, title, text } = token;
        let out = `<img loading="lazy" src="${href}" alt="${text}" style="--HB_src:url(${href});"`;
        if (title) out += ` title="${title}"`;
        return `${out}>`;
      },
    },
    tokenizer: {
      // Disable reflink definitions: they step on the variables extension.
      def() {
        return undefined;
      },
    },
  });
  marked.use(
    MarkedExtendedTables({ interruptPatterns: TABLE_TERMINATORS }),
    MarkedGFMHeadingId({ globalSlugs: true } as Parameters<typeof MarkedGFMHeadingId>[0]),
    MarkedSmartypantsLite(),
    MarkedEmojis<string>({
      emojis: { ...diceFont, ...elderberryInn, ...fontAwesome, ...gameIcons },
      renderer: (token) => `<i class="${token.emoji}"></i>`,
    }),
  );

  const render = (rawBrewText: string, pageNumber = 0): string => {
    variables.setPage(pageNumber);
    const lastPageNumber = pageNumber > 0 ? variables.getVariable('HB_pageNumber', pageNumber - 1) : 0;
    variables.setVariable(
      'HB_pageNumber', // document variable for this page
      !isNaN(Number(lastPageNumber)) ? Number(lastPageNumber) + 1 : String(lastPageNumber),
      pageNumber,
    );
    if (pageNumber === 0) MarkedGFMResetHeadingIDs();

    let text = rawBrewText.replace(/^\\column(?:break)?$/gm, `\n<div class='columnSplit'></div>\n`);
    const opts = marked.defaults;
    const hooks = opts.hooks;
    text = hooks ? hooks.preprocess(text) : text;
    const tokens = marked.lexer(text, opts);
    void marked.walkTokens(tokens, opts.walkTokens ?? (() => undefined));
    const html = marked.parser(tokens, opts);
    return hooks ? hooks.postprocess(html) : html;
  };

  const pageLineTags = (line: string): InjectedTags | null => {
    const first: Tokens.Generic | undefined = marked.lexer(line.split('\n', 1)[0] ?? '')[0];
    const tokens = (first?.tokens ?? []) as InjectableToken[];
    return tokens.find((t) => t.injectedTags !== undefined)?.injectedTags ?? null;
  };

  return { marked, render, pageLineTags, variables };
}
