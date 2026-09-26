// The Insert menu (plan §6.2, §6.3, P5.1): the text-view snippets of the brew's theme chain and
// the brew's own snippets, inserted into the editor. Place it in the toolbar's Insert slot:
//
//   const snippets = useSnippetGroups(chain?.snippets, brew.snippets, brew.title);
//   <EditorToolbar insertMenu={<InsertMenu editor={editor} groups={snippets.groups}
//       loading={snippets.status === 'loading'} theme={brew.theme} brew={…} onStyle={appendCss} />} … />
//
// Markdown snippets go through the importer (a layout probe is prepared when the menu opens);
// native ones (table of contents, footer, page numbers, page break) run editor commands. Every
// insertion is one undo step. The result is announced in a polite live region; failures raise
// an error toast.
import type { Editor } from '@tiptap/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast, VisuallyHidden } from '@/ui';
import type { LoadThemeChainOptions } from '@/editor/canvas/themeLoader';
import { groupsForView } from '@/editor/snippets/compileSnippets';
import type { SnippetBrewInfo } from '@/editor/snippets/generate';
import { createSnippetInserter, type SnippetInserter, type SnippetOutcome } from '@/editor/snippets/inserter';
import type { SnippetEntry } from '@/editor/snippets/snippetTree';
import type { ThemeSnippetGroup } from '@/editor/snippets/themeSnippets';
import { SnippetPicker } from './SnippetPicker';

export interface InsertMenuProps {
  editor: Editor | null;
  /** Compiled snippet groups (useSnippetGroups); only the text-view groups are shown. */
  groups: readonly ThemeSnippetGroup[];
  loading?: boolean;
  /** The brew's theme: snippets are laid out with it to find page objects. */
  theme: string;
  lang?: string;
  /** Fields generators may read (share id, title). */
  brew?: SnippetBrewInfo;
  themeOptions?: LoadThemeChainOptions;
  /** CSS a snippet carried (<style> blocks): append it to the brew's style. */
  onStyle?: (css: string) => void;
  /** Called after each insertion (tests, analytics). */
  onInserted?: (outcome: SnippetOutcome, entry: SnippetEntry) => void;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function InsertMenu({
  editor,
  groups,
  loading = false,
  theme,
  lang,
  brew,
  themeOptions,
  onStyle,
  onInserted,
  disabled = false,
  className,
  'data-testid': testId = 'insert-menu',
}: InsertMenuProps) {
  const textGroups = useMemo(() => groupsForView(groups, 'text'), [groups]);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  // Latest values for the inserter's callbacks (it lives as long as the editor).
  const latest = useRef({ theme, lang, brew, onStyle });
  useEffect(() => {
    latest.current = { theme, lang, brew, onStyle };
  });

  const [inserter, setInserter] = useState<{ editor: Editor; inserter: SnippetInserter } | null>(null);
  useEffect(() => {
    if (!editor) return;
    const created = createSnippetInserter(editor, {
      theme: () => latest.current.theme,
      lang: () => latest.current.lang ?? 'en',
      brew: () => latest.current.brew ?? {},
      onStyle: (css) => latest.current.onStyle?.(css),
      ...(themeOptions ? { themeOptions } : {}),
    });
    setInserter({ editor, inserter: created });
    return () => {
      created.dispose();
      setInserter(null);
    };
  }, [editor, themeOptions]);

  const current = inserter && inserter.editor === editor ? inserter.inserter : null;
  const editable = Boolean(editor?.isEditable);

  const onPick = (entry: SnippetEntry) => {
    if (!editor || !current) return;
    setBusy(true);
    setAnnouncement(`Inserting ${entry.name}…`);
    let insertion: Promise<SnippetOutcome>;
    try {
      insertion = current.insert(entry);
    } catch (error) {
      // A synchronous failure still ends the busy state below (the button ignores clicks while busy).
      insertion = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    insertion
      .then((outcome) => {
        setAnnouncement(outcome.message);
        onInserted?.(outcome, entry);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setAnnouncement(`${entry.name} could not be inserted.`);
        toast({ title: `${entry.name} could not be inserted`, description: message, tone: 'error' });
      })
      .finally(() => {
        setBusy(current.busy);
        if (!editor.isDestroyed) editor.view.focus();
      });
  };

  return (
    <>
      <SnippetPicker
        groups={textGroups}
        onPick={onPick}
        onOpen={() => current?.prewarm()}
        busy={busy}
        loading={loading}
        disabled={disabled || !editor || !editable}
        className={className}
        data-testid={testId}
      />
      <VisuallyHidden role="status" aria-live="polite" data-testid={`${testId}-status`}>
        {announcement}
      </VisuallyHidden>
    </>
  );
}
