// Inspector (P3.5, plan §6.2). See Inspector.tsx; the edits live in web/src/editor/commands/attrs.ts.
export { Inspector, type InspectorProps, type InspectorTab } from './Inspector';
export { InspectorPanel, type InspectorPanelProps } from './InspectorPanel';
export {
  InspectorStore,
  mapPin,
  resolveChain,
  resolvePage,
  targetIndex,
  typeLabel,
  type ChainItem,
  type InspectorSnapshot,
  type ObjectInfo,
  type PageInfo,
  type Pin,
  type ResolvedItem,
} from './model';
export { documentClassNames, filterClassSuggestions, MAX_CLASS_SUGGESTIONS, rankClassSuggestions, themeClasses, type ClassSuggester } from './classNames';
export { focusPageObject, OBJECT_SELECT_EVENT, pageObjectElement, type PageObjectRef } from './objectFocus';
