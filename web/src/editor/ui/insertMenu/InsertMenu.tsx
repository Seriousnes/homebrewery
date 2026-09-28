// The Insert menu (plan §6.2, §6.3, P5.1): the text-view snippets of the brew's theme chain and
// the brew's own snippets, inserted into the editor. Place it in the toolbar's Insert slot:
//
//   const snippets = useSnippetGroups(chain?.snippets, brew.snippets, brew.title);
//   <EditorToolbar insertMenu={<InsertMenu editor={editor} groups={snippets.groups}
//       loading={snippets.status === 'loading'} theme={brew.theme} brew={…} onStyle={appendCss} />} … />
//
// The button (or the editor's 'insertSnippet' request: the context menu, a shortcut) opens the
// snippet gallery (SnippetGallery), which previews the active snippet with the insertion pipeline
// itself: a markdown snippet is generated and converted once (inserter.prepare: the importer, with
// a layout probe prepared when the gallery opens), previewed, and that same result is inserted,
// so a random generator inserts what its preview showed. Each opening generates afresh. Native
// snippets (table of contents, footer, page numbers, page break) preview the editor command on
// the current page and run it. Every insertion is one undo step. The result is announced in a
// polite live region; failures raise an error toast.
import type { Editor } from '@tiptap/core';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Button, toast, VisuallyHidden } from '@/ui';
import { onKeymapRequest } from '@/editor/commands/keymap';
import type { LoadThemeChainOptions } from '@/editor/canvas/themeLoader';
import { groupsForView } from '@/editor/snippets/compileSnippets';
import type { SnippetBrewInfo } from '@/editor/snippets/generate';
import { createSnippetInserter, type PreparedSnippet, type SnippetInserter, type SnippetOutcome } from '@/editor/snippets/inserter';
import { markdownPreview, nativePreview, type SnippetPreview } from '@/editor/snippets/preview';
import type { SnippetEntry } from '@/editor/snippets/snippetTree';
import type { ThemeSnippetGroup } from '@/editor/snippets/themeSnippets';
import { SnippetGallery } from './SnippetGallery';

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
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  /**
   * The focus when the gallery opened, and whether a snippet was picked. Closed without a pick,
   * the focus goes back: to the editor through view.focus(), which keeps its selection (focusing
   * its element would put the caret at the start). After a pick the insertion focuses the editor.
   */
  const focusOnOpen = useRef<{ target: Element | null; picked: boolean } | null>(null);
  /** This opening's prepared snippets and previews (a new opening generates afresh). */
  const prepared = useRef(new Map<SnippetEntry, Promise<PreparedSnippet>>());
  const previews = useRef(new Map<SnippetEntry, Promise<SnippetPreview>>());

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

  const openGallery = () => {
    if (disabled || !editable || !current) return false;
    prepared.current.clear();
    previews.current.clear();
    focusOnOpen.current = { target: document.activeElement, picked: false };
    setOpen(true);
    current.prewarm();
    return true;
  };

  // After the dialog closed (it doesn't move the focus itself, see focusOnOpen).
  useEffect(() => {
    const restore = focusOnOpen.current;
    if (open || !restore) return;
    focusOnOpen.current = null;
    const { target, picked } = restore;
    // A pick: the insertion focuses the editor once it is done (focused earlier, the caret could
    // end up where it was, not after the snippet).
    if (picked) return;
    if (editor && !editor.isDestroyed && target && editor.view.dom.contains(target)) editor.view.focus();
    else if (target instanceof HTMLElement && target.isConnected) target.focus();
  }, [open, editor]);

  const onRequest = useEffectEvent(() => (open ? true : openGallery()));
  useEffect(() => {
    if (!editor) return;
    return onKeymapRequest(editor, (request) => (request === 'insertSnippet' ? onRequest() : false));
  }, [editor]);

  const prepare = (entry: SnippetEntry): Promise<PreparedSnippet> => {
    let result = prepared.current.get(entry);
    if (!result) {
      result = current ? current.prepare(entry) : Promise.reject(new Error('The editor is not ready.'));
      result.catch(() => undefined); // failures surface in the preview or the insertion
      prepared.current.set(entry, result);
    }
    return result;
  };

  const loadPreview = (entry: SnippetEntry): Promise<SnippetPreview> => {
    let result = previews.current.get(entry);
    if (!result) {
      const e = editor;
      result = !e
        ? Promise.reject(new Error('The editor is not ready.'))
        : entry.native
          ? Promise.resolve().then(() => nativePreview(e.state, entry.native!))
          : prepare(entry).then((p) => (p.kind === 'native' ? nativePreview(e.state, p.action) : markdownPreview(e.schema, p.snippet)));
      previews.current.set(entry, result);
    }
    return result;
  };

  const onPick = (entry: SnippetEntry) => {
    if (!editor || !current) return;
    // The gallery closes onto the editor, where the snippet goes.
    if (focusOnOpen.current) focusOnOpen.current.picked = true;
    setOpen(false);
    setBusy(true);
    setAnnouncement(`Inserting ${entry.name}…`);
    let insertion: Promise<SnippetOutcome>;
    try {
      insertion = entry.native ? current.insert(entry) : current.insertPrepared(prepare(entry), entry.name);
    } catch (error) {
      // A synchronous failure still ends the busy state below (the button ignores clicks while busy).
      insertion = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    // Inserted once: the next pick of this snippet generates it again.
    prepared.current.delete(entry);
    previews.current.delete(entry);
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
      <Button
        icon="insert"
        aria-haspopup="dialog"
        aria-expanded={open}
        loading={busy}
        disabled={disabled || !editor || !editable}
        className={className}
        data-testid={testId}
        onClick={() => openGallery()}
      >
        Insert
      </Button>
      <SnippetGallery
        open={open}
        onOpenChange={setOpen}
        groups={textGroups}
        loading={loading}
        onPick={onPick}
        loadPreview={loadPreview}
        lang={lang}
        returnFocus={false}
        data-testid={`${testId}-dialog`}
      />
      <VisuallyHidden role="status" aria-live="polite" data-testid={`${testId}-status`}>
        {announcement}
      </VisuallyHidden>
    </>
  );
}
