// Replaces themes/V3/Blank/snippets/footer.gen.js in every build (web/vite/themeSnippetShims.ts).
// The original imports marked-hbfm (a dev dependency: never in production code) and calls an
// undefined global `Markdown` (footer.gen.js:9), so it fails upstream as well. The footer is a
// section setting in this editor (plan §6.3): the Insert menu reads the NativeSnippetAction and
// sets it from the last heading of that level before the cursor. Called as a plain generator it
// returns upstream's fallback text.
import { nativeGenerator, type NativeGenerator } from '../native';

/** Upstream's text when no heading of the level precedes the cursor. */
export const FOOTER_PLACEHOLDER = 'PART 1 | SECTION NAME';

export default {
  createFooterFunc(headerSize = 1): NativeGenerator {
    return nativeGenerator({ kind: 'footer', level: headerSize }, `\n{{footnote ${FOOTER_PLACEHOLDER}}}\n`);
  },
};
