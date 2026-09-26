// Types for marked-hbfm (ships none). The one declaration of this module in web/: extend this
// file rather than declaring 'marked-hbfm' again (a second declaration of `hbfm` would clash).
declare module 'marked-hbfm' {
  import type { marked } from 'marked';

  /** Tags from {{…}} / {…} injection, e.g. `\page {pink,color:red,#id,data-x=1}`. */
  export interface HbfmInjectedTags {
    id: string | null;
    classes: string | null;
    styles: Record<string, string> | null;
    attributes: Record<string, string> | null;
  }

  export interface HbfmValidationError {
    line: number | string;
    type: string;
    text: string;
    id: 'OPEN' | 'CLOSE' | 'MISMATCH';
  }

  export interface Hbfm {
    /** marked's module-level instance with the Homebrewery extensions installed. */
    marked: typeof marked;
    /**
     * Renders one page of Homebrewery-flavoured markdown. Keeps module-level state (variables
     * per page, heading slugs reset on page 0).
     */
    render(rawBrewText: string, pageNumber?: number): string;
    /** Unbalanced div/span/a tags, per line. */
    validate(rawBrewText: string): HbfmValidationError[];
  }

  export const hbfm: Hbfm;
}
