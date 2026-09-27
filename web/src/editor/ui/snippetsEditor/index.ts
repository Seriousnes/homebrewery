// Brew snippets editor (plan §6.3). See SnippetsEditor.tsx.
export { SnippetsPanel, SnippetsToggle, type SnippetsPanelProps, type SnippetsToggleProps } from './SnippetsPanel';
export { SNIPPETS_REPORT_MS, useSnippetsEditor } from './useSnippetsEditor';
export { SnippetsEditor, type SnippetsEditorProps } from './SnippetsEditor';
export { SnippetBodyEditor, type SnippetBodyEditorHandle, type SnippetBodyEditorProps } from './SnippetBodyEditor';
export { SnippetTextDialog, type SnippetTextDialogProps } from './SnippetTextDialog';
export { exportFileName, formatSize, MAX_IMPORT_FILE_BYTES, userThemeSnippets, type UserThemeSnippets } from './helpers';
export {
  MAX_STEPS,
  MERGE_MS,
  SIZE_REFUSED,
  SnippetsEditorStore,
  type SnippetsEditorOptions,
  type SnippetsEditorSnapshot,
  type SnippetsEditorState,
  type SnippetsNotice,
} from './snippetsEditorStore';
export {
  countErrors,
  displayOrder,
  groupLabel,
  groupNames,
  groupSnippets,
  MAX_SNIPPET_LABEL_LENGTH,
  NEW_SNIPPET_NAME,
  snippetIssues,
  uniqueName,
  type EditableSnippet,
  type SnippetGroupView,
  type SnippetIssue,
  type SnippetIssueCode,
} from './snippetsModel';
export {
  createSnippetsPanelStore,
  DEFAULT_SNIPPETS_PANEL,
  SNIPPETS_PANEL_ID,
  SNIPPETS_PANEL_LIMITS,
  SNIPPETS_PANEL_STORAGE_KEY,
  snippetsPanelStore,
  useSnippetsPanel,
  type SnippetsPanelState,
  type SnippetsPanelStoreApi,
} from './snippetsPanelState';
export { hbfmHighlight, hbfmLanguage } from './hbfmLanguage';
