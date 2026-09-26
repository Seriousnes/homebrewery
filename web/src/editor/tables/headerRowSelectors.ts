// Theme selectors for table header rows (P5.6, plan §3.2).
//
// Upstream tables put their header rows in <thead> and the rest in <tbody>. ProseMirror renders
// a node's children into one element, so every editor row is in the table's single <tbody>; the
// leading rows whose cells are all header cells get the class `hb-header-row` instead (a node
// decoration, tables/headerRows.ts). Theme and user CSS written for <thead> is rewritten here so
// it styles those rows exactly as upstream:
//
//   thead X                     → the original, plus  tr:where(.hb-header-row) X
//   thead > tr / thead tr       → the original, plus  tbody > tr:where(.hb-header-row) / tbody tr:where(.hb-header-row)
//   thead (the subject)         → the original, plus  tr:where(.hb-header-row)
//   tbody tr:nth-child(odd)     → tbody tr:where(:not(.hb-header-row)):nth-child(odd of :where(:not(.hb-header-row)))
//   tbody td                    → tbody > :where(tr:not(.hb-header-row)) td
//   tr:nth-child(odd) elsewhere → counted within the header rows and within the body rows, as
//                                 upstream counts within <thead> and within <tbody>
//
// Specificity never changes: the added parts are inside :where() (an `of S` selector adds S's
// specificity, so S is a :where() too), and `thead tr` → `tbody tr…` swaps one type for another.
// In a document with real <thead>/<tbody> (upstream HTML, the import probe, export) nothing has
// the class, so every rewritten selector matches exactly what the original matched.
//
// Pure string code with no imports: the build-time scoping of static themes (web/vite/
// scopeThemes.ts, Node) and the runtime scoping of user CSS (canvas/cssScope.ts) both use it.
// Only top-level compounds are rewritten; `thead` inside :is()/:not()/:has() is left alone.

/** Class of a leading all-header row (set by the headerRows decoration). */
export const HEADER_ROW_CLASS = 'hb-header-row';

const IS_HEADER = `:where(.${HEADER_ROW_CLASS})`;
const NOT_HEADER = `:where(:not(.${HEADER_ROW_CLASS}))`;
/** A body row or an element inside one. */
const IN_BODY_ROW = `:where(tr:not(.${HEADER_ROW_CLASS}), tr:not(.${HEADER_ROW_CLASS}) *)`;

type Combinator = ' ' | '>' | '+' | '~';

interface Parsed {
  compounds: string[];
  /** combinators[i] joins compounds[i] and compounds[i + 1] */
  combinators: Combinator[];
}

/** Calls `visit` for each top-level character (outside (), [] and strings); true stops. */
function walkTopLevel(text: string, visit: (i: number, ch: string) => boolean | void): void {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && visit(i, ch)) return;
  }
}

/** Splits a selector list at its top-level commas. */
export function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let start = 0;
  walkTopLevel(list, (i, ch) => {
    if (ch === ',') {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  });
  parts.push(list.slice(start));
  return parts.map((s) => s.trim()).filter((s) => s !== '');
}

/** Compounds and combinators of one complex selector, or null for what this code doesn't handle. */
function parse(selector: string): Parsed | null {
  const compounds: string[] = [];
  const combinators: Combinator[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = -1; // start of the current compound, -1 between compounds
  let pending: Combinator | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    const topLevel = depth === 0 && quote === null;
    const space = /\s/.test(ch);
    const combinator = ch === '>' || ch === '+' || ch === '~';
    if (topLevel && (space || combinator)) {
      if (start >= 0) {
        compounds.push(selector.slice(start, i));
        start = -1;
      }
      if (combinator) {
        // Two explicit combinators in a row, or one before the first compound (a relative
        // selector): not something to rewrite.
        if ((pending !== null && pending !== ' ') || compounds.length === 0) return null;
        pending = ch;
      } else if (pending === null && compounds.length > 0) {
        pending = ' ';
      }
      continue;
    }
    if (start < 0) {
      if (compounds.length > 0) combinators.push(pending ?? ' ');
      pending = null;
      start = i;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
  }
  if (start >= 0) compounds.push(selector.slice(start));
  else if (pending !== null && pending !== ' ') return null; // trailing combinator
  if (compounds.length === 0 || compounds.length !== combinators.length + 1) return null;
  return { compounds, combinators };
}

const TYPE = /^(?:\*|[a-zA-Z][\w-]*)/;

/** The compound's type selector, lower case ('' for none, '*' for the universal selector). */
function typeOf(compound: string): string {
  return TYPE.exec(compound)?.[0].toLowerCase() ?? '';
}

/** A compound whose element is a table row: type tr, or no type (`*`, `.x`, `:nth-child()`). */
function isRowCompound(compound: string): boolean {
  const type = typeOf(compound);
  return type === 'tr' || type === '' || type === '*';
}

const NTH = /:(nth-child|nth-last-child|nth-of-type|nth-last-of-type)\(|:(first-child|last-child|first-of-type|last-of-type)(?![\w-])/gi;

/** The argument of the parenthesised pseudo-class starting at `open` (index of '('), and its end. */
function argumentAt(text: string, open: number): { arg: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return { arg: text.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

type RowGroup = 'header' | 'body';

/**
 * One positional pseudo-class rewritten to count only among the rows of `group` (header rows lead
 * the table, so nth-child/first-child of a header row need nothing). Null: leave it as it is.
 */
function groupPseudo(name: string, arg: string | null, group: RowGroup): string | null {
  const of = group === 'header' ? IS_HEADER : NOT_HEADER;
  const lower = name.toLowerCase();
  if (arg !== null && /\sof\s/i.test(arg)) return null; // already `An+B of S`
  switch (lower) {
    case 'nth-child':
    case 'nth-of-type':
      return group === 'header' ? null : `:nth-child(${arg} of ${of})`;
    case 'first-child':
    case 'first-of-type':
      return group === 'header' ? null : `:nth-child(1 of ${of})`;
    case 'nth-last-child':
    case 'nth-last-of-type':
      return group === 'header' ? `:nth-last-child(${arg} of ${of})` : null;
    case 'last-child':
    case 'last-of-type':
      return group === 'header' ? `:nth-last-child(1 of ${of})` : null;
    default:
      return null;
  }
}

interface Positional {
  start: number;
  end: number;
  name: string;
  arg: string | null;
}

/** Positional pseudo-classes at the top level of a compound. */
function positionals(compound: string): Positional[] {
  const found: Positional[] = [];
  const topLevel = new Set<number>();
  walkTopLevel(compound, (i) => {
    topLevel.add(i);
  });
  NTH.lastIndex = 0;
  for (let m = NTH.exec(compound); m; m = NTH.exec(compound)) {
    if (!topLevel.has(m.index)) continue;
    if (m[1]) {
      const open = m.index + m[0].length - 1;
      const a = argumentAt(compound, open);
      if (!a) continue;
      found.push({ start: m.index, end: a.end, name: m[1], arg: a.arg.trim() });
      NTH.lastIndex = a.end;
    } else {
      found.push({ start: m.index, end: m.index + m[0].length, name: m[2]!, arg: null });
    }
  }
  return found;
}

/** The compound with its positional pseudo-classes counted within `group`, plus `extra`. */
function inGroup(compound: string, group: RowGroup, extra: string): string {
  let out = compound;
  const found = positionals(compound);
  for (let i = found.length - 1; i >= 0; i--) {
    const p = found[i]!;
    const replacement = groupPseudo(p.name, p.arg, group);
    if (replacement !== null) out = out.slice(0, p.start) + replacement + out.slice(p.end);
  }
  return insertBeforePseudoElement(out, extra);
}

/**
 * A row compound in no known group (`table tr:nth-child(odd)`): upstream counted it within each
 * row group, so it becomes `tr:is(<as a header row>, <as a body row>)`. Same specificity: :is()
 * takes its most specific argument, and both arguments carry the same pseudo-classes.
 */
function eitherGroup(compound: string): string {
  const found = positionals(compound);
  if (found.length === 0) return compound;
  const header = found.map((p) => groupPseudo(p.name, p.arg, 'header') ?? compound.slice(p.start, p.end)).join('');
  const body = found.map((p) => groupPseudo(p.name, p.arg, 'body') ?? compound.slice(p.start, p.end)).join('');
  let rest = compound;
  for (let i = found.length - 1; i >= 0; i--) rest = rest.slice(0, found[i]!.start) + rest.slice(found[i]!.end);
  return insertBeforePseudoElement(rest, `:is(${IS_HEADER}${header}, ${NOT_HEADER}${body})`);
}

/** `extra` appended to the compound, before a pseudo-element (`tr::before` → `tr<extra>::before`). */
function insertBeforePseudoElement(compound: string, extra: string): string {
  if (extra === '') return compound;
  let at = compound.length;
  walkTopLevel(compound, (i, ch) => {
    if (ch === ':' && (compound[i + 1] === ':' || /^:(?:before|after|first-line|first-letter)(?![\w-])/i.test(compound.slice(i)))) {
      at = i;
      return true;
    }
    return false;
  });
  // A compound that is only `*` keeps its star (`*:where(…)` is valid, so is `:where(…)`).
  return compound.slice(0, at) + extra + compound.slice(at);
}

function join(p: Parsed): string {
  let out = p.compounds[0]!;
  for (let i = 0; i < p.combinators.length; i++) {
    const c = p.combinators[i]!;
    out += (c === ' ' ? ' ' : ` ${c} `) + p.compounds[i + 1]!;
  }
  return out;
}

/** The `thead` alternative of a parsed selector (see the file header), or null. */
function headerAlternative(p: Parsed): Parsed | null {
  const i = p.compounds.findIndex((c) => c.trim().toLowerCase() === 'thead');
  if (i < 0) return null;
  const compounds = [...p.compounds];
  const combinators = [...p.combinators];
  if (i === compounds.length - 1) {
    compounds[i] = `tr${IS_HEADER}`;
    return { compounds, combinators };
  }
  const combinator = combinators[i]!;
  const next = compounds[i + 1]!;
  if (combinator === '+' || combinator === '~') return null;
  if (combinator === '>' || typeOf(next) === 'tr') {
    if (!isRowCompound(next)) return null; // `thead > th` never matches upstream either
    compounds[i] = 'tbody';
    compounds[i + 1] = inGroup(next, 'header', IS_HEADER);
    return { compounds, combinators };
  }
  compounds[i] = `tr${IS_HEADER}`; // `thead th`, `thead p`: descendants of a header row
  return { compounds, combinators };
}

/** Body-row rewrites (tbody contexts and other row compounds), in place. */
function bodyRewrite(p: Parsed): Parsed {
  const compounds: string[] = [];
  const combinators: Combinator[] = [];
  for (let i = 0; i < p.compounds.length; i++) {
    const compound = p.compounds[i]!;
    const before = i > 0 ? p.combinators[i - 1] : undefined;
    const prev = i > 0 ? p.compounds[i - 1]! : '';
    const inBody = typeOf(prev) === 'tbody' && (before === ' ' || before === '>');
    let next = compound;
    if (inBody) {
      // A child of tbody is a row: not a header row. A descendant: a body row or inside one.
      const extra = before === '>' ? NOT_HEADER : IN_BODY_ROW;
      next = isRowCompound(compound) ? inGroup(compound, 'body', extra) : insertBeforePseudoElement(compound, extra);
    } else if (typeOf(compound) === 'tr') {
      next = eitherGroup(compound);
    }
    if (before) combinators.push(before);
    compounds.push(next);
  }
  return { compounds, combinators };
}
/**
 * Rewrites one complex selector (no top-level commas) for header rows. Returns a selector list:
 * the selector itself (rewritten for body rows where needed), plus its `thead` alternative.
 */
export function rewriteHeaderRowSelector(selector: string): string {
  const trimmed = selector.trim();
  if (!/\b(?:thead|tbody|tr)\b/i.test(trimmed) || trimmed.includes(HEADER_ROW_CLASS)) return trimmed;
  const parsed = parse(trimmed);
  if (!parsed) return trimmed;
  const theadAt = parsed.compounds.findIndex((c) => c.trim().toLowerCase() === 'thead');
  // Compounds after a thead are header rows or their content: never body-rewritten.
  const original = theadAt >= 0 ? bodyRewriteBefore(parsed, theadAt) : bodyRewrite(parsed);
  const alternative = headerAlternative(parsed);
  const out = [join(original)];
  if (alternative) out.push(join(theadAt >= 0 ? bodyRewriteBefore(alternative, theadAt) : alternative));
  return out.join(', ');
}

/** bodyRewrite for the compounds before index `end` only (the rest stays as it is). */
function bodyRewriteBefore(p: Parsed, end: number): Parsed {
  const head = bodyRewrite({ compounds: p.compounds.slice(0, end), combinators: p.combinators.slice(0, Math.max(0, end - 1)) });
  if (end === 0) return p;
  return {
    compounds: [...head.compounds, ...p.compounds.slice(end)],
    combinators: [...head.combinators, ...p.combinators.slice(end - 1)],
  };
}

/** rewriteHeaderRowSelector for every selector of a list. */
export function rewriteHeaderRowSelectorList(list: string): string {
  if (!/\b(?:thead|tbody|tr)\b/i.test(list) || list.includes(HEADER_ROW_CLASS)) return list;
  return splitSelectors(list)
    .map((s) => rewriteHeaderRowSelector(s))
    .join(', ');
}
