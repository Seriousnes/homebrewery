// Snippets (plan §6.3, P5.1): theme snippet groups compiled for a theme chain, user snippets,
// the markdown insertion pipeline, native replacements and style-view helpers.
export type { ThemeSnippet, ThemeSnippetContext, ThemeSnippetGenerator, ThemeSnippetGroup } from './themeSnippets';
export { STATIC_SNIPPET_LOADERS, hasStaticSnippets, loadStaticSnippets } from './staticSnippets';
export {
  compileSnippets,
  groupsForView,
  loadSnippetGroups,
  mergeSnippetGroups,
  mergeSnippetLists,
  staticSnippetIds,
  type CompileSnippetsInput,
} from './compileSnippets';
export {
  UNTITLED_BREW,
  USER_SNIPPETS_GROUP,
  USER_SNIPPETS_ICON,
  parseUserSnippets,
  userSnippetGroup,
  type UserSnippet,
  type UserThemeSnippetsRef,
} from './userSnippets';
export {
  NATIVE_MARKDOWN,
  NATIVE_SNIPPET,
  describeNativeAction,
  nativeActionOf,
  nativeGenerator,
  type NativeGenerator,
  type NativeSnippetAction,
} from './native';
export { PATH_SEPARATOR, filterSections, findSnippet, pathLabel, snippetSections, type SnippetEntry, type SnippetSection } from './snippetTree';
export { SnippetGeneratorError, runSnippetGenerator, snippetContext, type SnippetBrewInfo, type SnippetContext } from './generate';
export {
  PAGE_LINE,
  applySnippetDoc,
  insertBlocksTr,
  insertFragment,
  insertPagesTr,
  insertSnippet,
  mergeLiftedPageAttrs,
  pagesFromJson,
  snippetToDoc,
  type InsertSnippetResult,
  type ProbeFactory,
  type SnippetDoc,
  type SnippetToDocOptions,
} from './insertSnippet';
export {
  INSERTED_TOC_ATTRS,
  footerFromHeadingTr,
  footerTextBefore,
  insertTocTr,
  nativeActionTr,
  pageBreakTr,
  pageMarkerTr,
  pageNumberTr,
} from './nativeCommands';
export { addPageMarkers, hasEmptyFlow, isBlankPage, pagePos, sectionBounds, setSectionAttrs, type SectionAttrName } from './sections';
export { createProbeCache, createSnippetInserter, type SnippetInserter, type SnippetInserterOptions, type SnippetOutcome } from './inserter';
export { generateStyleSnippet, insertStyleSnippet } from './styleSnippets';
export { useSnippetGroups, type SnippetGroupsState } from './useSnippetGroups';
export { FOOTER_PLACEHOLDER } from './shims/footer.gen';
export {
  GROUP_SEPARATOR,
  hasSnippetHeaderLine,
  isSnippetHeader,
  parseSnippetText,
  snippetLabel,
  snippetsToText,
  splitGroupAndName,
  type ParsedSnippetText,
  type TextSnippet,
} from './snippetText';
export {
  MAX_SNIPPETS_JSON,
  editableUserSnippets,
  jsonStringLength,
  serverJsonLength,
  snippetsFit,
  storedSnippet,
  storedSnippets,
  type StoredUserSnippet,
  type UserSnippetFields,
} from './storedSnippets';
