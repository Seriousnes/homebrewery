// Brew variables ($[var], [var]: …, $[var](…), $[math]) for the importer.
//
// A port of marked-variables 1.0.7 (MIT, naturalcrit/marked-variables, src/index.js) with two
// changes, both for untrusted input:
//  - math goes through ./math.ts instead of expr-eval (see there);
//  - state lives in one instance per import instead of module globals, so imports can't see
//    each other's variables.
// Everything else (queue, hoisting, page scoping, link/image variables) follows upstream so the
// expanded text matches what upstream displayed. The document model has no variables (plan §1):
// imports keep the expanded text, and the definitions found are listed in the import report.
// With `expand: false` the text is scanned (definitions and calls are recorded) but returned
// unchanged, so `[name]: value` lines and `$[name]` calls stay visible as written.
import type { MarkedExtension } from 'marked';
import { evaluateMath, type MathValue } from './math';

interface VarEntry {
  content: string;
  origContent?: string;
  resolved: boolean;
  external?: boolean;
}

interface QueueItem {
  type: 'text' | 'varDefBlock' | 'varCall' | 'resolved';
  prefix?: string;
  varName?: string | null;
  content?: MathValue | undefined;
  pageNumber: number;
}

/** A variable definition seen while rendering (for the import report). */
export interface VariableDefinition {
  name: string;
  page: number;
  /** 'block' = `[name]: value`, 'inline' = `$[name](value)` */
  form: 'block' | 'inline';
}

//                    url or <url>            "title"    or   'title'     or  (title)
const LINK_REGEX = /^([^<\s][^\s]*|<.*?>)(?: ("(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\((?:\\\(|\\\)|[^()])*\)))?$/m;
const VAR_CALL_REGEX = /([!$]?)\[((?!\s*\])(?:\\.|[^[\]\\])+)\]/g; // [var] or ![var] or $[var]

// Only used inside COMBINED_SOURCE, where the fence group is group 2 (hence the \2).
const CODE_BLOCK_SKIP =
  String.raw`^(?: {4}[^\n]+(?:\n(?: *(?:\n|$))*)?)+|^ {0,3}(` +
  '`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})' +
  String.raw`(?:[^\n]*)(?:\n|$)(?:|(?:[\s\S]*?)(?:\n|$))(?: {0,3}\2[~` +
  '`' +
  String.raw`]* *(?=\n|$))|` +
  '`[^`]*?`';
const VAR_LABEL_REGEX = /([!$]?)\[((?!\s*\])(?:\\.|[^[\]\\])+)\]/; // [var] or ![var] or $[var]
const BLOCK_DEF_REGEX = /:((?:\n? *[^\s].*)+)(?=\n+|$)/; // : block definitions
const INLINE_DEF_REGEX = /\(([^\n]+)\)/; // (inline definitions)
const COMBINED_SOURCE = `(${CODE_BLOCK_SKIP})|${VAR_LABEL_REGEX.source}(?:${BLOCK_DEF_REGEX.source}|${INLINE_DEF_REGEX.source})?`;

const MATH_SPLIT = /[a-z]+\(|[+\-*/^(),]/g;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Trim edge spaces and shorten runs of whitespace to one space (upstream normalizeVarNames). */
const normalizeVarName = (label: string): string => label.trim().replace(/\s+/g, ' ');

export interface BrewVariablesOptions {
  /** false: record definitions and calls, but leave the text as written (default true). */
  expand?: boolean;
}

/** Variables state for one document. */
export class BrewVariables {
  /** Whether preprocess() substitutes values (true) or only records what it finds (false). */
  readonly expand: boolean;
  private varsQueue: QueueItem[] = [];
  private readonly globalVarsList: Record<number, Record<string, VarEntry>> = {};
  private globalPageNumber = 0;
  /** Definitions seen, keyed `${page}:${name}` (the last render wins). */
  private readonly definitionsSeen = new Map<string, VariableDefinition>();
  /** `$[…]` calls left as text in the last render of each page. */
  private readonly unresolvedByPage = new Map<number, string[]>();

  constructor(options: BrewVariablesOptions = {}) {
    this.expand = options.expand ?? true;
  }

  /** The marked extension (a preprocess hook), registered where upstream registers its own. */
  extension(): MarkedExtension {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- marked calls hooks with its own `this`
    const self = this;
    return {
      hooks: {
        preprocess(src: string) {
          return self.preprocess(src);
        },
      },
    };
  }

  setPage(pageNumber: number): void {
    this.globalPageNumber = pageNumber;
  }

  /** An externally injected variable (upstream setMarkedVariable, used for HB_pageNumber). */
  setVariable(name: string, content: MathValue, page = 0): void {
    if (page < 0) return;
    this.globalVarsList[page] ??= Object.create(null) as Record<string, VarEntry>;
    this.globalVarsList[page][name] = { content: String(content), resolved: true, external: true };
  }

  getVariable(name: string, page = 0): string | undefined {
    const lookup = this.lookupVar(name, page);
    return lookup?.resolved ? lookup.content : undefined;
  }

  /** Every definition seen in the source (excluding injected variables such as HB_pageNumber). */
  get definitions(): VariableDefinition[] {
    return [...this.definitionsSeen.values()];
  }

  /**
   * `$[…]` calls kept as text, per page: the unresolved ones when expanding, every call when
   * not. (`[text]` and `![text]` without a definition are ordinary markdown text, not listed.)
   */
  get unresolved(): ReadonlyMap<number, string[]> {
    return this.unresolvedByPage;
  }

  private replaceVar(prefix: string, label: string, pageNumber: number, allowUnresolved = false): MathValue | undefined {
    // Math
    const mathVars = label
      .split(MATH_SPLIT)
      .filter((match) => isNaN(match as unknown as number))
      .map((s) => s.trim());
    if (prefix.startsWith('$') && mathVars[0] !== label.trim()) {
      let replacedLabel = label;
      for (const variable of mathVars) {
        const foundVar = this.lookupVar(variable, pageNumber);
        if (foundVar && foundVar.resolved && foundVar.content && !isNaN(foundVar.content as unknown as number)) {
          replacedLabel = replacedLabel.replaceAll(new RegExp(`(?<!\\w)(${escapeRegExp(variable)})(?!\\w)`, 'g'), foundVar.content);
        }
      }
      try {
        return evaluateMath(replacedLabel);
      } catch {
        return undefined; // invalid math: the call stays as text
      }
    }

    const foundVar = this.lookupVar(label, pageNumber);
    if (!foundVar || (!foundVar.resolved && !allowUnresolved)) return undefined;

    if (prefix.startsWith('$')) return foundVar.content; // variable

    const linkMatch = LINK_REGEX.exec(foundVar.content);
    const href = linkMatch ? linkMatch[1] : null;
    const title = linkMatch ? linkMatch[2]?.slice(1, -1) : null;
    if (!prefix && href) return `[${label}](${href}${title ? ` "${title}"` : ''})`; // link
    if (prefix.startsWith('!') && href) return `![${label}](${href} ${title ? ` "${title}"` : ''})`; // image
    return undefined;
  }

  private lookupVar(label: string, index: number): VarEntry | undefined {
    for (let i = index; i >= 0; i--) {
      const vars = this.globalVarsList[i];
      const found = vars && Object.hasOwn(vars, label) ? vars[label] : undefined;
      if (found !== undefined) return found;
    }
    // Normal lookup failed: hoist from later pages.
    for (let i = Object.keys(this.globalVarsList).length; i >= 0; i--) {
      const vars = this.globalVarsList[i];
      const found = vars && Object.hasOwn(vars, label) ? vars[label] : undefined;
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private processVariableQueue(): void {
    let resolvedOne = true;
    let finalLoop = false;
    let guard = 0;
    while (resolvedOne || finalLoop) {
      if (++guard > 10_000) break; // upstream has no guard; the loop always terminates, but be safe
      resolvedOne = false;
      for (const item of this.varsQueue) {
        if (item.type === 'text') continue;

        if (item.type === 'varDefBlock') {
          let resolved = true;
          const content = String(item.content ?? '');
          let tempContent = content;
          const origContent = content;
          VAR_CALL_REGEX.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = VAR_CALL_REGEX.exec(content))) {
            const value = this.replaceVar(match[1] ?? '', match[2] ?? '', item.pageNumber);
            if (value === undefined) resolved = false;
            else tempContent = tempContent.replaceAll(match[0], String(value));
          }
          if (resolved || content !== tempContent) {
            resolvedOne = true;
            item.content = tempContent;
          }
          const pageVars = (this.globalVarsList[item.pageNumber] ??= Object.create(null) as Record<string, VarEntry>);
          pageVars[item.varName ?? ''] = { content: String(item.content ?? ''), origContent, resolved };
          if (resolved) item.type = 'resolved';
        }

        if (item.type === 'varCall') {
          const value = this.replaceVar(item.prefix ?? '', item.varName ?? '', item.pageNumber, finalLoop);
          if (value === undefined) continue;
          resolvedOne = true;
          item.content = value;
          item.type = 'text';
        }
      }
      this.varsQueue = this.varsQueue.filter((item) => item.type !== 'resolved');
      if (finalLoop) break;
      if (!resolvedOne) finalLoop = true;
    }
    this.varsQueue = this.varsQueue.filter((item) => item.type !== 'varDefBlock');
  }

  private preprocess(src: string): string {
    const page = this.globalPageNumber;
    this.globalVarsList[page] ??= Object.create(null) as Record<string, VarEntry>;
    for (let p = 0; p <= page; p++) {
      const vars = this.globalVarsList[p];
      if (!vars) continue;
      for (const [varName, data] of Object.entries(vars)) {
        if (data.external) continue;
        if (p === page) {
          // Clear variables for the current page (except externally injected ones).
          delete vars[varName];
        } else {
          // Reset resolved status on previous pages so hoisting can be recalculated.
          data.content = data.origContent ?? data.content;
          data.resolved = false;
        }
      }
    }
    for (const key of [...this.definitionsSeen.keys()]) if (key.startsWith(`${page}:`)) this.definitionsSeen.delete(key);

    const queue: Array<Omit<QueueItem, 'pageNumber'>> = [];
    const calls: string[] = [];
    const combined = new RegExp(COMBINED_SOURCE, 'gm');
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = combined.exec(src)) !== null) {
      const isLineStart = match.index === 0 || src[match.index - 1] === '\n';
      const prefix = match[3] ?? '';
      const label = match[4] ? normalizeVarName(match[4]) : null;

      if (match.index > lastIndex) queue.push({ type: 'text', content: src.slice(lastIndex, match.index) });
      if (!isLineStart && match[5]) {
        // Invalid block definition (not at line start): rewind to just after the label.
        combined.lastIndex = combined.lastIndex - (match[5].length + 1);
      }
      if (match[1]) {
        queue.push({ type: 'text', content: match[0] }); // code: left alone
      } else if (isLineStart && match[5]) {
        // Block definition
        const content = match[5].trim().replace(/[ \t]+/g, ' ');
        queue.push({ type: 'varDefBlock', prefix, varName: label, content });
        if (label) this.definitionsSeen.set(`${page}:${label}`, { name: label, page, form: 'block' });
      } else if (match[6]) {
        // Inline definition; find the matching end parenthesis in case of nesting
        let content = match[6];
        let level = 0;
        let i: number;
        for (i = 0; i < content.length; i++) {
          if (content[i] === '\\') i++;
          else if (content[i] === '(') level++;
          else if (content[i] === ')') {
            level--;
            if (level < 0) break;
          }
        }
        combined.lastIndex = combined.lastIndex - (content.length - i);
        content = content.slice(0, i).trim().replace(/\s+/g, ' ');
        queue.push({ type: 'varDefBlock', prefix, varName: label, content });
        queue.push({ type: 'varCall', prefix, varName: label });
        // Plain links and images ([text](url), ![alt](src)) are inline definitions too; only $[name](…) is reported.
        if (label && prefix === '$') this.definitionsSeen.set(`${page}:${label}`, { name: label, page, form: 'inline' });
      } else if (match[4]) {
        // Variable call; keeps the original `$[var]` when it is never defined
        queue.push({ type: 'varCall', prefix, varName: label, content: `${prefix}[${label}]` });
        if (prefix === '$') calls.push(`$[${label ?? ''}]`);
      }
      lastIndex = combined.lastIndex;
    }
    if (lastIndex < src.length) queue.push({ type: 'text', varName: null, content: src.slice(lastIndex) });

    const pageQueue: QueueItem[] = queue.map((item) => ({ ...item, pageNumber: page }));
    // Unresolved variables from previous pages, in case this page lets them be hoisted.
    const unresolved: QueueItem[] = Object.entries(this.globalVarsList)
      .filter(([pageNumber]) => Number(pageNumber) < page)
      .flatMap(([pageNumber, vars]) =>
        Object.entries(vars).map(([varName, data]) => ({
          type: 'varDefBlock' as const,
          varName,
          content: data.content,
          pageNumber: Number(pageNumber),
        })),
      );
    this.varsQueue = [...unresolved, ...pageQueue];
    this.processVariableQueue();

    if (!this.expand) {
      this.unresolvedByPage.set(page, calls);
      return src;
    }
    this.unresolvedByPage.set(
      page,
      this.varsQueue.filter((item) => item.type === 'varCall' && item.prefix === '$').map((item) => `$[${item.varName ?? ''}]`),
    );
    return this.varsQueue.map((item) => (item.content === undefined ? '' : String(item.content))).join('');
  }
}
