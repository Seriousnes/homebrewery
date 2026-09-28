// Types for the marked extensions marked-hbfm is built from (they ship none), which web/package.json
// lists as its own dependencies; see ./renderer.ts.

declare module 'marked-extended-tables' {
  import type { MarkedExtension } from 'marked';

  export default function markedExtendedTables(options?: { interruptPatterns?: string[]; skipEmptyRows?: boolean }): MarkedExtension;
}

declare module 'marked-definition-lists' {
  import type { MarkedExtension } from 'marked';

  export default function markedDefinitionLists(): MarkedExtension;
}

declare module 'marked-alignment-paragraphs' {
  import type { MarkedExtension } from 'marked';

  export default function markedAlignmentParagraphs(): MarkedExtension;
}

declare module 'marked-nonbreaking-spaces' {
  import type { MarkedExtension } from 'marked';

  export default function markedNonbreakingSpaces(): MarkedExtension;
}

declare module 'marked-subsuper-text' {
  import type { MarkedExtension } from 'marked';

  export default function markedSubSuperText(): MarkedExtension;
}

declare module 'marked-diagrams-markdeep' {
  import type { MarkedExtension } from 'marked';

  export default function markedDiagramsMarkdeep(options?: { langs: string[] }): MarkedExtension;
}

declare module 'marked-smartypants-lite' {
  import type { MarkedExtension } from 'marked';

  export function markedSmartypantsLite(): MarkedExtension;
}
