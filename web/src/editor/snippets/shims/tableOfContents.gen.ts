// Replaces themes/V3/Blank/snippets/tableOfContents.gen.js in every build
// (web/vite/themeSnippetShims.ts). The original reads upstream's preview iframe
// (#BrewRenderer), which doesn't exist here; the table of contents is a live toc node instead
// (plan §6.5). Called as a plain generator it returns markdown that also parses into a toc node.
import { nativeGenerator } from '../native';

export default nativeGenerator({ kind: 'toc' }, '\n{{toc,wide\n# Contents\n}}\n');
