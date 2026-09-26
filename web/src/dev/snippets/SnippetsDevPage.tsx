import type { AnyExtension, Editor, JSONContent } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { EditorCanvas, type EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import type { ThemeSnippetRef } from '@/editor/canvas/themeLoader';
import type { CanvasStatus } from '@/editor/canvas/useCanvasTheme';
import { hbfmToDoc } from '@/editor/import/hbfmToDoc';
import { paginatedExtensions } from '@/editor/paginatedExtensions';
import { isSettled } from '@/editor/pagination/state';
import { ImageWithView } from '@/editor/objects/imageView';
import { groupsForView } from '@/editor/snippets/compileSnippets';
import { runSnippetGenerator, snippetContext } from '@/editor/snippets/generate';
import { createSnippetInserter, type SnippetInserter, type SnippetOutcome } from '@/editor/snippets/inserter';
import { nativeActionOf } from '@/editor/snippets/native';
import { findSnippet, snippetSections } from '@/editor/snippets/snippetTree';
import { loadStaticSnippets } from '@/editor/snippets/staticSnippets';
import { insertStyleSnippet } from '@/editor/snippets/styleSnippets';
import type { ThemeSnippet } from '@/editor/snippets/themeSnippets';
import { useSnippetGroups } from '@/editor/snippets/useSnippetGroups';
import { TOC_ENTRIES_ATTR } from '@/editor/nodeviews/TocView';
import { themeBlockOverlayOf } from '@/editor/themeBlocks/overlay';
import { InsertMenu } from '@/editor/ui/insertMenu';
import { Select } from '@/ui';
import { settleImages } from '../import/fixtures';
import { devDocs } from './devDocs';
import styles from './SnippetsDevPage.module.css';

const THEMES = ['5ePHB', 'Blank', '5eDMG', 'Journal', 'UnearthedArcana'];

/** The brew's own snippets on this page (brews.snippets, the plan's flat form). */
const USER_SNIPPETS = [{ name: 'Tavern Note', gen: '{{note\n##### The Tavern\nA warm fire and a cold welcome.\n}}\n' }];

/**
 * Images load eagerly on this page (screenshots compare them with upstream's render). Built on
 * ImageWithView, which it replaces (same name): inserted images carry their natural size, which
 * only ImageView renders without fixing both dimensions.
 */
const EagerImage = ImageWithView.extend({
  renderHTML(props) {
    const spec = this.parent?.(props) as [string, Record<string, unknown>] | undefined;
    return spec ? [spec[0], { ...spec[1], loading: 'eager' }] : ['img', props.HTMLAttributes];
  },
  // extend() copies ImageWithView's addProseMirrorPlugins, which calls this.parent: inherited as
  // is, it would run twice and add the keyed natural-size plugin twice (a RangeError).
  addProseMirrorPlugins() {
    return this.parent?.() ?? [];
  },
});

/** A raw generator of a static theme's snippets.js (not merged with its parents). */
export interface RawSnippetInfo {
  group: string;
  view: 'text' | 'style';
  /** Submenu names, then the snippet's own name. */
  names: string[];
  kind: 'function' | 'string';
  native: string | null;
}

/** The test API (web/e2e/snippets). */
export interface SnippetsDevApi {
  editor: Editor;
  /** Theme, CSS and fonts applied. */
  ready(): boolean;
  /** Ready and pagination settled. */
  settled(): boolean;
  /** The compiled entries of the current chain. */
  entries(view?: 'text' | 'style'): { path: string[]; native: string | null }[];
  /** Every generator of a static theme's own snippets.js. */
  rawEntries(theme: string): Promise<RawSnippetInfo[]>;
  /** Runs a raw generator (after __hbReseed(seed) when the page has one; e2e installs it). */
  generate(theme: string, group: string, names: string[], seed?: number): Promise<string>;
  /** Runs a raw generator's native action, if it has one. */
  runRawNative(theme: string, group: string, names: string[]): Promise<SnippetOutcome | null>;
  insertMarkdown(markdown: string): Promise<SnippetOutcome>;
  insertEntry(path: string[]): Promise<SnippetOutcome>;
  /** Removes the empty paragraph a block insertion leaves for the cursor at the end of the document. */
  dropCursorLine(): boolean;
  /** A fresh one-page document (or `doc`), no user CSS. */
  reset(doc?: JSONContent): void;
  /** Imports markdown as the whole document (hbfmToDoc) and its CSS as the user CSS. */
  loadMarkdown(markdown: string): Promise<void>;
  setUserCss(css: string): void;
  userCss(): string;
  /** Adds CSS the way the Style drawer's snippets do (insertStyleSnippet at the end). */
  appendStyleSnippet(css: string): void;
  /** Blur, cursor to the start, wait for images: ready for screenshots. */
  prepareScreenshot(): Promise<void>;
  /** Rows of every toc: [text, page, href]. */
  tocRows(): string[][][];
  /** The theme-block overlay's state. */
  overlay(): { visible: boolean; label: string | null; classes: string[] };
  /** How many times the canvas repaginated for a user-CSS change (it applied the CSS). */
  cssApplied(): number;
  outcomes: SnippetOutcome[];
}

declare global {
  interface Window {
    __hbSnippets?: SnippetsDevApi;
    /** Installed by the e2e init script: reseeds Math.random (and lodash through it). */
    __hbReseed?: (seed: number) => void;
  }
}

function walkRaw(snippets: readonly ThemeSnippet[], trail: string[], visit: (s: ThemeSnippet, names: string[]) => void): void {
  for (const snippet of snippets) {
    const names = [...trail, snippet.name];
    if (snippet.subsnippets?.length) walkRaw(snippet.subsnippets, names, visit);
    if (snippet.gen !== undefined && snippet.gen !== '' && !snippet.disabled) visit(snippet, names);
  }
}

async function findRaw(theme: string, group: string, names: string[]): Promise<{ snippet: ThemeSnippet; view: 'text' | 'style' } | null> {
  const groups = await loadStaticSnippets(`V3_${theme}`);
  const g = groups.find((x) => x.groupName === group);
  if (!g) return null;
  let found: ThemeSnippet | null = null;
  walkRaw(g.snippets, [], (s, n) => {
    if (!found && n.join('\u0000') === names.join('\u0000')) found = s;
  });
  return found ? { snippet: found, view: g.view } : null;
}

/**
 * /dev/snippets[?theme=5ePHB&doc=empty|blocks|toc|toc-long]: the Insert menu on a paginated
 * EditorCanvas (theme block labels, live TOC). window.__hbSnippets is the e2e API; the frame
 * has data-theme-status and data-settled.
 */
export function SnippetsDevPage() {
  const [params, setParams] = useSearchParams();
  const theme = params.get('theme') ?? '5ePHB';
  const docKey = params.get('doc') ?? 'empty';
  const content = devDocs[docKey] ?? devDocs.empty!;
  const [status, setStatus] = useState<CanvasStatus>({ state: 'loading', theme });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [userCss, setUserCss] = useState('');
  const [settled, setSettledFlag] = useState(false);
  const userCssRef = useRef('');
  const cssApplied = useRef(0);

  const gate = useMemo(() => createCanvasGate(), []);
  const extensions = useMemo<AnyExtension[]>(
    () => [...paginatedExtensions({ gate, onSettle: () => setSettledFlag(true) }), EagerImage],
    [gate],
  );

  const refs = useMemo<ThemeSnippetRef[] | null>(() => (status.state === 'ready' ? status.chain.snippets : null), [status]);
  const snippets = useSnippetGroups(refs, USER_SNIPPETS, 'Snippets Dev');
  const groupsRef = useRef(snippets.groups);
  // The test API reads the latest values.
  useEffect(() => {
    userCssRef.current = userCss;
    groupsRef.current = snippets.groups;
  });

  const onReady = useCallback(
    (e: Editor, handle: EditorCanvasHandle) => {
      setEditor(e);
      const outcomes: SnippetOutcome[] = [];
      const brew = { title: 'Snippets Dev', shareId: 'dev', theme };
      const inserter: SnippetInserter = createSnippetInserter(e, { theme: () => theme, brew: () => brew, onStyle: (css) => setUserCss((old) => insertStyleSnippet(old, css).css) });
      const record = (outcome: SnippetOutcome) => {
        outcomes.push(outcome);
        return outcome;
      };
      window.__hbSnippets = {
        editor: e,
        outcomes,
        ready: () => handle.isReady(),
        settled: () => handle.isReady() && isSettled(e.state),
        entries: (view = 'text') =>
          snippetSections(groupsForView(groupsRef.current, view)).flatMap((s) => s.entries.map((en) => ({ path: en.path, native: en.native?.kind ?? null }))),
        rawEntries: async (t) => {
          const out: RawSnippetInfo[] = [];
          for (const group of await loadStaticSnippets(`V3_${t}`)) {
            walkRaw(group.snippets, [], (s, names) =>
              out.push({ group: group.groupName, view: group.view, names, kind: typeof s.gen === 'function' ? 'function' : 'string', native: nativeActionOf(s.gen)?.kind ?? null }),
            );
          }
          return out;
        },
        generate: async (t, group, names, seed) => {
          const raw = await findRaw(t, group, names);
          if (!raw) throw new Error(`No snippet ${t} › ${group} › ${names.join(' › ')}`);
          // Reseed and run in one synchronous step, as scripts/fidelity-fixtures.ts does.
          if (seed !== undefined) window.__hbReseed?.(seed);
          return runSnippetGenerator(names.at(-1) ?? '', raw.snippet.gen, snippetContext(brew, raw.view));
        },
        runRawNative: async (t, group, names) => {
          const raw = await findRaw(t, group, names);
          const action = raw ? nativeActionOf(raw.snippet.gen) : null;
          return action ? record(inserter.runNative(action, names.at(-1))) : null;
        },
        insertMarkdown: async (markdown) => record(await inserter.insertMarkdown(markdown)),
        insertEntry: async (path) => {
          const entry = findSnippet(snippetSections(groupsRef.current), path);
          if (!entry) throw new Error(`No snippet ${path.join(' › ')}`);
          return record(await inserter.insert(entry));
        },
        dropCursorLine: () => {
          const { doc } = e.state;
          const last = doc.lastChild;
          const block = last?.lastChild;
          if (!last || !block || last.childCount < 2 || block.type.name !== 'paragraph' || block.content.size > 0) return false;
          const end = doc.content.size - 1;
          e.view.dispatch(e.state.tr.delete(end - block.nodeSize, end).setMeta('addToHistory', false));
          return true;
        },
        reset: (doc) => {
          setSettledFlag(false);
          e.commands.setContent(doc ?? devDocs.empty!);
          e.view.dispatch(e.state.tr.setMeta('addToHistory', false));
          setUserCss('');
        },
        loadMarkdown: async (markdown) => {
          const result = await hbfmToDoc(markdown, { theme });
          setSettledFlag(false);
          e.commands.setContent(result.doc);
          setUserCss(result.style);
        },
        setUserCss: (css) => setUserCss(css),
        userCss: () => userCssRef.current,
        appendStyleSnippet: (css) => setUserCss((old) => insertStyleSnippet(old, css).css),
        prepareScreenshot: async () => {
          e.view.dom.blur();
          e.commands.setTextSelection(0);
          await settleImages(e.view.dom);
        },
        tocRows: () =>
          [...e.view.dom.querySelectorAll(`div.block.toc[${TOC_ENTRIES_ATTR}]`)].map((toc) =>
            [...toc.querySelectorAll('a')].map((a) => [a.children[0]?.textContent ?? '', a.children[1]?.textContent ?? '', a.getAttribute('href') ?? '']),
          ),
        cssApplied: () => cssApplied.current,
        overlay: () => {
          const s = themeBlockOverlayOf(e.view)?.store.getSnapshot();
          return { visible: Boolean(s?.visible), label: s?.block?.label ?? null, classes: s?.block?.classes ?? [] };
        },
      };
    },
    [theme],
  );

  const set = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(key, value);
        return next;
      },
      { replace: true },
    );

  return (
    <div className={styles.frame} data-theme-status={status.state} data-settled={settled ? 'true' : 'false'} data-snippets-status={snippets.status}>
      <header className={styles.bar}>
        <strong>/dev/snippets</strong>
        <InsertMenu
          editor={editor}
          groups={snippets.groups}
          loading={snippets.status === 'loading'}
          theme={theme}
          brew={{ title: 'Snippets Dev', shareId: 'dev', theme }}
          onStyle={(css) => setUserCss((old) => insertStyleSnippet(old, css).css)}
        />
        <Select label="Theme" value={theme} options={THEMES.map((t) => ({ value: t, label: t }))} onChange={(ev) => set('theme', ev.target.value)} data-testid="theme-select" />
        <Select
          label="Document"
          value={docKey}
          options={Object.keys(devDocs).map((d) => ({ value: d, label: d }))}
          onChange={(ev) => set('doc', ev.target.value)}
          data-testid="doc-select"
        />
        <span data-testid="canvas-status">{status.state === 'ready' ? `${status.chain.source} chain, ${snippets.groups.length} snippet groups` : status.state}</span>
      </header>
      <main className={styles.main}>
        <EditorCanvas
          key={`${theme}:${docKey}`}
          content={content}
          theme={theme}
          userCss={userCss}
          gate={gate}
          extensions={extensions}
          onReady={onReady}
          onStatusChange={setStatus}
          onRepaginate={(event) => {
            if (event.reason === 'css') cssApplied.current += 1;
          }}
        />
      </main>
    </div>
  );
}
