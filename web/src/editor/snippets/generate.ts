// Running a snippet generator (legacy snippetbar.jsx `execute`, :46-49). Generators are the
// themes' unchanged upstream code; they return Homebrewery markdown (text view) or CSS (style
// view). Some use Math.random through lodash, which is fine at run time.
import type { ThemeSnippetGenerator } from './themeSnippets';

/** The brew fields a generator may read. */
export interface SnippetBrewInfo {
  shareId?: string;
  title?: string;
  theme?: string;
  lang?: string;
}

/**
 * What upstream passed to generators: the snippet group's props (snippetbar.jsx SnippetGroup),
 * of which generators read `brew` and `cursorPos`. The QR Code generator takes this object as
 * its `brew` parameter and reads `.shareId` from it, which upstream never set, so its code
 * links to the home page there as here.
 */
export interface SnippetContext {
  brew: SnippetBrewInfo & { renderer: 'V3' };
  cursorPos: { line: number; ch: number };
  view: 'text' | 'style';
  [key: string]: unknown;
}

export function snippetContext(brew: SnippetBrewInfo = {}, view: 'text' | 'style' = 'text'): SnippetContext {
  return { brew: { ...brew, renderer: 'V3' }, cursorPos: { line: 0, ch: 0 }, view };
}

export class SnippetGeneratorError extends Error {
  constructor(name: string, cause: unknown) {
    super(`The snippet "${name}" failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'SnippetGeneratorError';
  }
}

/** Runs a generator (synchronously) and returns its text. Throws SnippetGeneratorError. */
export function runSnippetGenerator(name: string, gen: ThemeSnippetGenerator | undefined, context: SnippetContext): string {
  try {
    const out = typeof gen === 'function' ? gen(context) : gen;
    if (out === undefined || out === null) return '';
    return typeof out === 'string' ? out : String(out);
  } catch (error) {
    throw new SnippetGeneratorError(name, error);
  }
}
