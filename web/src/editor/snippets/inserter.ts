// The Insert menu's engine for one editor: runs a snippet's generator, then its native action
// or the markdown pipeline (insertSnippet.ts). Conversions run one at a time (they share the
// importer's layout probe), and the probe is kept between them (the theme and fonts load once),
// re-created when the theme changes.
//
// prepare() generates and converts a snippet without inserting it (the gallery's preview), and
// insertPrepared() inserts that same result: a random generator inserts what its preview showed.
import type { Editor } from '@tiptap/core';
import { mountProbe, type Probe } from '../canvas/probe';
import type { LoadThemeChainOptions } from '../canvas/themeLoader';
import { runSnippetGenerator, snippetContext, type SnippetBrewInfo } from './generate';
import { applySnippetDoc, snippetToDoc, type InsertSnippetResult, type ProbeFactory, type SnippetDoc } from './insertSnippet';
import { nativeActionOf, type NativeSnippetAction } from './native';
import { nativeActionTr } from './nativeCommands';
import type { SnippetEntry } from './snippetTree';

export interface SnippetInserterOptions {
  /** The brew's theme key (read at every insertion). */
  theme: () => string;
  /** The brew fields generators may read. */
  brew?: () => SnippetBrewInfo;
  lang?: () => string;
  themeOptions?: LoadThemeChainOptions;
  /** CSS carried by a text snippet (<style>, ```css): append it to the brew's style. */
  onStyle?: (css: string) => void;
  /** Probe factory (tests: mountInlineProbe); default: a cached mountProbe. */
  probe?: ProbeFactory;
}

export interface SnippetOutcome {
  kind: InsertSnippetResult['kind'] | 'native';
  /** For announcements: what happened, in a sentence. */
  message: string;
  style: string;
}

/** A probe factory that keeps one probe (per theme, CSS and language) until disposed. */
export function createProbeCache(themeOptions?: LoadThemeChainOptions): { factory: ProbeFactory; dispose: () => void } {
  let cached: { key: string; probe: Promise<Probe> } | null = null;
  const drop = () => {
    const old = cached;
    cached = null;
    void old?.probe.then((p) => p.dispose()).catch(() => undefined);
  };
  const factory: ProbeFactory = async (theme, css, lang) => {
    const key = JSON.stringify([theme, css, lang]);
    if (cached?.key !== key) {
      drop();
      cached = { key, probe: mountProbe(theme, css, { lang, ...(themeOptions ? { themeOptions } : {}) }) };
    }
    const entry = cached;
    try {
      const probe = await entry.probe;
      // hbfmToDoc disposes the probe it gets: hand out a copy whose dispose keeps it.
      return { ...probe, dispose: () => undefined };
    } catch (error) {
      if (cached === entry) cached = null;
      throw error;
    }
  };
  return { factory, dispose: drop };
}

/** A snippet ready to insert: its native action, or its generated markdown converted. */
export type PreparedSnippet = { kind: 'native'; action: NativeSnippetAction } | { kind: 'markdown'; markdown: string; snippet: SnippetDoc };

export interface SnippetInserter {
  /** Runs the snippet: its native action, or its markdown through the importer. */
  insert(entry: Pick<SnippetEntry, 'name' | 'gen'>): Promise<SnippetOutcome>;
  /**
   * Runs the snippet's generator and converts its markdown (queued with the other conversions)
   * without inserting anything. Rejects with SnippetGeneratorError when the generator fails.
   */
  prepare(entry: Pick<SnippetEntry, 'name' | 'gen'>): Promise<PreparedSnippet>;
  /** Inserts a prepared snippet; busy until it is inserted. */
  insertPrepared(prepared: Promise<PreparedSnippet>, name?: string): Promise<SnippetOutcome>;
  /** Inserts markdown (already generated) through the importer. */
  insertMarkdown(markdown: string, name?: string): Promise<SnippetOutcome>;
  /** Runs a native action synchronously. */
  runNative(action: NativeSnippetAction, name?: string): SnippetOutcome;
  /** Mounts the layout probe ahead of the first insertion. */
  prewarm(): void;
  /** Whether an insertion is in progress. */
  readonly busy: boolean;
  dispose(): void;
}

export function createSnippetInserter(editor: Editor, options: SnippetInserterOptions): SnippetInserter {
  const cache = options.probe ? null : createProbeCache(options.themeOptions);
  const probe = options.probe ?? cache!.factory;
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;

  const lang = () => options.lang?.() || 'en';

  const runNative = (action: NativeSnippetAction, name = 'Snippet'): SnippetOutcome => {
    if (editor.isDestroyed) return { kind: 'nothing', message: `${name}: the editor is closed.`, style: '' };
    const tr = nativeActionTr(editor.state, action);
    if (!tr) return { kind: 'nothing', message: `${name}: nothing to change here.`, style: '' };
    editor.view.dispatch(tr);
    return { kind: 'native', message: `${name} applied.`, style: '' };
  };

  /** Snippet markdown through the importer, one conversion at a time (the probe is shared). */
  const convert = (markdown: string): Promise<SnippetDoc> => {
    const run = queue.then(() =>
      snippetToDoc(markdown, { theme: options.theme(), lang: lang(), probe, ...(options.themeOptions ? { themeOptions: options.themeOptions } : {}) }),
    );
    queue = run.catch(() => undefined);
    return run;
  };

  const apply = (snippet: SnippetDoc, name: string): SnippetOutcome => {
    const result = applySnippetDoc(editor, snippet);
    if (result.style.trim()) options.onStyle?.(result.style);
    const message =
      result.kind === 'pages'
        ? `${name}: inserted ${result.pages} page${result.pages === 1 ? '' : 's'}.`
        : result.kind === 'blocks'
          ? `${name} inserted.`
          : `${name}: nothing to insert.`;
    return { kind: result.kind, message, style: result.style };
  };

  const insertPrepared = (prepared: Promise<PreparedSnippet>, name = 'Snippet'): Promise<SnippetOutcome> => {
    pending++;
    return prepared
      .then((p) => (p.kind === 'native' ? runNative(p.action, name) : apply(p.snippet, name)))
      .finally(() => {
        pending--;
      });
  };

  const prepare = (entry: Pick<SnippetEntry, 'name' | 'gen'>): Promise<PreparedSnippet> => {
    const action = nativeActionOf(entry.gen);
    if (action) return Promise.resolve({ kind: 'native', action });
    let markdown: string;
    try {
      markdown = runSnippetGenerator(entry.name, entry.gen, snippetContext(options.brew?.() ?? {}, 'text'));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return convert(markdown).then((snippet): PreparedSnippet => ({ kind: 'markdown', markdown, snippet }));
  };

  const insertMarkdown = (markdown: string, name = 'Snippet'): Promise<SnippetOutcome> =>
    insertPrepared(
      convert(markdown).then((snippet): PreparedSnippet => ({ kind: 'markdown', markdown, snippet })),
      name,
    );

  return {
    insert(entry) {
      const action = nativeActionOf(entry.gen);
      if (action) {
        // Never throws: callers set a busy state before the promise exists.
        try {
          return Promise.resolve(runNative(action, entry.name));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return insertPrepared(prepare(entry), entry.name);
    },
    prepare,
    insertPrepared,
    insertMarkdown,
    runNative,
    prewarm() {
      if (!cache) return;
      void cache.factory(options.theme(), '', lang()).catch(() => undefined);
    },
    get busy() {
      return pending > 0;
    },
    dispose() {
      cache?.dispose();
    },
  };
}
