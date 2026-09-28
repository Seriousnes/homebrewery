// The /dev/perf page's state and its window API (window.__hbPerf), for web/e2e/perf/perf.spec.ts
// (P8.1, plan §4.10). The page mounts a document in one of two shells:
//
//   app      the real EditorApp (mode edit, saving none, no navbar): toolbar, app bar, panels,
//            layout status, every editor listener of the app pages. Typing, edits, loads.
//   canvas   EditorCanvas with the app's editing extensions, the toolbar and the layout status,
//            and a theme that can be switched (EditorApp takes its theme from the Properties
//            dialog, which pages that never save don't have).
//
// Timings use performance.now(); pagination work comes from the scheduler's profiler hook
// (PerfProbe). The API is plain data in and out, so Playwright can drive it.
import type { Editor, JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { RepaginateEvent } from '@/editor/canvas/useCanvasTheme';
import { PAGINATE, REPAGINATE, failedPulls, measurePage, pageAt, pullTarget, type PaginationFrameProfile, type PaginationStats } from '@/editor/pagination';
import { afterNextPaint, PerfProbe, summarizeFrames, type PaginationSummary, type TypingReport } from './perfProbe';

export type PerfShell = 'app' | 'canvas';

export interface PerfMount {
  key: number;
  doc: JSONContent;
  shell: PerfShell;
  theme: string;
  style: string;
}

export interface MountOptions {
  shell?: PerfShell;
  theme?: string;
  style?: string;
}

export interface LoadReport {
  shell: PerfShell;
  theme: string;
  /** pages in the document passed in, and once settled */
  pagesIn: number;
  pages: number;
  /** ms from the mount call to: the editor existing, its first painted frame, the canvas ready (theme, CSS, fonts), the last settle */
  toEditor: number;
  toFirstPaint: number;
  toReady: number;
  toSettled: number;
  /** ms of pagination from the canvas being ready to the last settle */
  paginationMs: number;
  pagination: PaginationSummary;
}

export interface ThemeSwitchReport {
  from: string;
  to: string;
  pagesBefore: number;
  pages: number;
  /** ms from the switch to: the new theme's styles and fonts applied, the first repagination, the last settle */
  toReady: number;
  toRepaginate: number;
  toSettled: number;
  /** ms from the first repagination to the last settle (the pagination pass alone) */
  paginationMs: number;
  repaginations: { at: number; from: number; reason: string }[];
  pagination: PaginationSummary;
}

export interface EditReport {
  /** ms from the dispatch to the settle */
  settle: number;
  pages: number;
  pagination: PaginationSummary;
}

export interface CaretReport {
  page: number;
  /** index of the caret's paragraph among the page's blocks, and the headings the page starts with */
  block: number;
  leadingHeadings: number;
  kind: string;
  pos: number;
  /** text before and after the caret in its paragraph (40 characters each) */
  before: string;
  after: string;
}

/**
 * The work done since the last work() call, as counts (they don't depend on how fast the machine
 * is, unlike the timings): what the perf specs assert.
 */
export interface WorkReport {
  /**
   * the pagination passes, each its steps in order (the page a step checked and what it did); a
   * pass ends with the scheduler run that settled
   */
  passes: { page: number; action: string }[][];
  /** transactions with pagination's meta (its dispatches) */
  transactions: number;
  /** REPAGINATE transactions (theme, CSS, fonts triggers) */
  repaginations: number;
  /**
   * pages whose content changed in the DOM (text or child nodes; attributes don't count), as
   * indexes now, sorted; -1 for a page element removed since
   */
  mutatedPages: number[];
  /** page elements added to and removed from the editor's root */
  pagesAdded: number;
  pagesRemoved: number;
  /** pages now */
  pages: number;
}

export interface EnvReport {
  userAgent: string;
  hardwareConcurrency: number;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  dev: boolean;
  eventTiming: boolean;
  longAnimationFrame: boolean;
}

export interface HbPerfApi {
  /** Mounts `doc` (a new editor) and resolves once it has settled and stayed idle for a second. */
  mount(doc: JSONContent, opts?: MountOptions): Promise<LoadReport>;
  /** Removes the editor. */
  unmount(): Promise<void>;
  settled(): boolean;
  pages(): number;
  stats(): PaginationStats | null;
  /** performance.now() */
  now(): number;
  /** Waits for a settle that stays idle for `quietMs`; the pagination work since `since`. */
  quiet(since: number, quietMs?: number): Promise<{ settledAt: number | null; frames: number; steps: number; docSteps: number }>;
  /** Puts the caret in the middle (or at the end) of the longest whole paragraph of page `page`, scrolled into view, focused. */
  placeCaret(page: number, where?: 'middle' | 'end'): CaretReport;
  startTyping(): void;
  stopTyping(): TypingReport;
  /**
   * While typing is recorded: waits until `keys` keystrokes are recorded, the last one has been
   * painted and pagination has settled (rejects after `timeoutMs`).
   */
  afterKeys(keys: number, timeoutMs?: number): Promise<void>;
  /** The work since the last call (the first call: since the page opened). */
  work(): WorkReport;
  /** Inserts `text` at the caret in one transaction (paste-like) and waits for the settle. */
  insertText(text: string): Promise<EditReport>;
  /** Canvas shell: switches the theme and waits until the new layout has settled and stayed idle. */
  setTheme(theme: string): Promise<ThemeSwitchReport>;
  /** Pagination frames recorded since frame index `from`. */
  frames(from?: number): PaginationFrameProfile[];
  frameCount(): number;
  /** The document as JSON (the stored form: auto pages included). */
  json(): JSONContent;
  /** Texts of each page's blocks (fixture checks). */
  pageKinds(): string[];
  /** Indexes of the pages with a block of type `type` at their top level. */
  pagesWith(type: string): number[];
  env(): EnvReport;
  /** Debugging: page `index`'s measurement, its pull estimate, and the boxes of its last block and of the next page's first block. */
  inspect(index: number): unknown;
  /** Debugging: the pulls pagination found pushed back whole since the last REPAGINATE (layout.ts). */
  failedPulls(): ReturnType<typeof failedPulls>;
}

declare global {
  interface Window {
    __hbPerf?: HbPerfApi;
    /** A document to mount on page load (set with Playwright's addInitScript). */
    __hbPerfDoc?: { doc: JSONContent; shell?: PerfShell; theme?: string; style?: string };
  }
}

const now = () => performance.now();
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Headings at the start of a page's flow. */
function leadingHeadings(page: { childCount: number; child(i: number): { type: { name: string } } }): number {
  let n = 0;
  while (n < page.childCount && page.child(n).type.name === 'heading') n += 1;
  return n;
}


/** The live editor of the page's canvas (EditorApp or the canvas shell), from TipTap's DOM back-reference. */
export function liveEditor(root: ParentNode = document): Editor | null {
  const dom = root.querySelector<HTMLElement & { editor?: Editor }>('.hb-canvas .ProseMirror');
  const editor = dom?.editor ?? null;
  return editor && !editor.isDestroyed ? editor : null;
}

export class PerfController {
  readonly probe = new PerfProbe(() => this.editor());
  current: PerfMount | null = null;
  private nextKey = 1;
  private listeners = new Set<() => void>();
  private version = 0;
  private status: { state: string; theme: string; at: number }[] = [];
  private repaginations: { at: number; from: number; reason: string }[] = [];
  private listened: Editor | null = null;
  /** Counts for work() since its last call (the step log is the probe's). */
  private counts = { transactions: 0, repaginations: 0, pagesAdded: 0, pagesRemoved: 0 };
  /** Page elements (children of the editor's root) whose content changed since work(). */
  private mutated = new Set<Element>();
  private dom: { root: HTMLElement; observer: MutationObserver } | null = null;

  constructor(initial: Window['__hbPerfDoc'] | null) {
    if (initial?.doc) this.current = this.mountOf(initial.doc, initial);
  }

  // React glue ------------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  /** EditorCanvas's onStatusChange (canvas shell). */
  onStatus = (status: { state: string; theme: string }): void => {
    this.status.push({ state: status.state, theme: status.theme, at: now() });
  };

  /** EditorCanvas's onRepaginate (canvas shell). */
  onRepaginate = (event: RepaginateEvent): void => {
    this.repaginations.push({ at: now(), from: event.from, reason: event.reason });
  };

  /** Starts the probe (an effect: React StrictMode runs it, its cleanup, and it again). */
  start(): void {
    this.probe.start();
  }

  stop(): void {
    this.listened?.off('transaction', this.onTransaction);
    this.listened = null;
    this.observeDom(null);
    this.probe.stop();
  }

  /** Watches the editor's pages for content changes and added or removed pages (work()). */
  private observeDom(editor: Editor | null): void {
    this.dom?.observer.disconnect();
    this.dom = null;
    if (!editor) return;
    const root = editor.view.dom;
    const observer = new MutationObserver((records) => this.onMutations(root, records));
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    this.dom = { root, observer };
  }

  private onMutations(root: HTMLElement, records: MutationRecord[]): void {
    const isPage = (node: Node) => node instanceof HTMLElement && node.classList.contains('page');
    for (const r of records) {
      if (r.target === root) {
        for (const node of Array.from(r.addedNodes)) if (isPage(node)) this.counts.pagesAdded += 1;
        for (const node of Array.from(r.removedNodes)) if (isPage(node)) this.counts.pagesRemoved += 1;
        continue;
      }
      let node: Node | null = r.target;
      while (node && node.parentNode !== root) node = node.parentNode;
      if (node instanceof Element) this.mutated.add(node);
    }
  }

  private takeWork(): WorkReport {
    if (this.dom) this.onMutations(this.dom.root, this.dom.observer.takeRecords());
    const children = this.dom ? Array.from(this.dom.root.children) : [];
    const mutatedPages = [...new Set(Array.from(this.mutated, (el) => children.indexOf(el)))].sort((a, b) => a - b);
    const report: WorkReport = { passes: this.probe.takePasses(), ...this.counts, mutatedPages, pages: this.probe.pages() };
    this.counts = { transactions: 0, repaginations: 0, pagesAdded: 0, pagesRemoved: 0 };
    this.mutated.clear();
    return report;
  }

  private mountOf(doc: JSONContent, opts: MountOptions): PerfMount {
    return { key: this.nextKey++, doc, shell: opts.shell ?? 'app', theme: opts.theme ?? '5ePHB', style: opts.style ?? '' };
  }

  /** The live editor, followed by the probe (React StrictMode and remounts re-create it). */
  editor(): Editor | null {
    const editor = liveEditor();
    if (editor !== this.listened) {
      this.listened?.off('transaction', this.onTransaction);
      this.listened = editor;
      editor?.on('transaction', this.onTransaction);
      this.observeDom(editor);
    }
    return editor;
  }

  private readonly onTransaction = ({ transaction }: { transaction: { getMeta(key: string): unknown } }): void => {
    if (transaction.getMeta(PAGINATE) !== undefined) this.counts.transactions += 1;
    const meta = transaction.getMeta(REPAGINATE);
    if (meta === undefined) return;
    this.counts.repaginations += 1;
    // The app shell has no onRepaginate: REPAGINATE metas are the theme, CSS and fonts triggers.
    if (this.current?.shell === 'app') this.repaginations.push({ at: now(), from: typeof meta === 'number' ? meta : -1, reason: 'meta' });
  };

  private async waitFor<T>(get: () => T | null | false, timeoutMs = 120_000): Promise<T> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const value = get();
      if (value) return value;
      if (now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  // The window API --------------------------------------------------------------------------------

  api(): HbPerfApi {
    const view = (): EditorView => {
      const editor = this.editor();
      if (!editor) throw new Error('no editor');
      return editor.view;
    };
    return {
      mount: async (doc, opts = {}) => {
        const framesFrom = this.probe.frames.length;
        const t0 = now();
        this.current = this.mountOf(doc, opts);
        this.emit();
        const editor = await this.waitFor(() => {
          const e = this.editor();
          return e && e.state.doc.childCount > 0 && e.view.dom.isConnected ? e : null;
        });
        const tEditor = now();
        const tPaint = await afterNextPaint();
        await this.waitFor(() => (editor.isDestroyed ? this.editor() : editor)?.storage.hbCanvas?.ready === true);
        const tReady = now();
        const q = await this.probe.quiet(t0, 1000);
        const frames = this.probe.frames.slice(framesFrom);
        const settledAt = q.settledAt ?? tReady;
        return {
          shell: this.current.shell,
          theme: this.current.theme,
          pagesIn: doc.content?.length ?? 0,
          pages: this.probe.pages(),
          toEditor: r1(tEditor - t0),
          toFirstPaint: r1(tPaint - t0),
          toReady: r1(tReady - t0),
          toSettled: r1(settledAt - t0),
          paginationMs: r1(Math.max(0, settledAt - tReady)),
          pagination: summarizeFrames(frames),
        };
      },
      unmount: async () => {
        this.current = null;
        this.emit();
        await afterNextPaint();
      },
      settled: () => {
        this.editor();
        return this.probe.settled();
      },
      pages: () => {
        this.editor();
        return this.probe.pages();
      },
      stats: () => {
        this.editor();
        return this.probe.stats();
      },
      now,
      quiet: (since, quietMs = 1000) => {
        this.editor();
        return this.probe.quiet(since, quietMs);
      },
      placeCaret: (pageIndex, where = 'middle') => {
        const v = view();
        const page = pageAt(v.state.doc, pageIndex);
        if (!page) throw new Error(`no page ${pageIndex}`);
        // The longest paragraph of the page that is whole (not a fragment of a split one).
        let best: { pos: number; size: number; index: number } | null = null;
        let pos = page.contentStart;
        for (let i = 0; i < page.node.childCount; i++) {
          const child = page.node.child(i);
          const whole = child.type.name === 'paragraph' && child.attrs.continuation !== true && !(i === page.node.childCount - 1 && pageAt(v.state.doc, pageIndex + 1)?.node.firstChild?.attrs.continuation === true);
          if (whole && child.textContent.length > (best?.size ?? 80)) best = { pos, size: child.content.size, index: i };
          pos += child.nodeSize;
        }
        if (!best) throw new Error(`no whole paragraph on page ${pageIndex}`);
        const para = v.state.doc.nodeAt(best.pos)!;
        let offset = where === 'end' ? para.content.size : Math.floor(para.content.size / 2);
        if (where === 'middle') {
          const text = para.textContent;
          const space = text.indexOf(' ', offset);
          offset = space > 0 ? space + 1 : offset; // the start of a word
        }
        const caret = best.pos + 1 + offset;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, caret)).scrollIntoView());
        const dom = v.domAtPos(caret);
        const el = dom.node instanceof Element ? dom.node : dom.node.parentElement;
        el?.scrollIntoView({ block: 'center', inline: 'nearest' });
        v.focus();
        return {
          page: pageIndex,
          block: best.index,
          leadingHeadings: leadingHeadings(page.node),
          kind: String(page.node.attrs.kind),
          pos: caret,
          before: para.textContent.slice(Math.max(0, offset - 40), offset),
          after: para.textContent.slice(offset, offset + 40),
        };
      },
      startTyping: () => {
        this.editor();
        this.probe.startRecording();
      },
      stopTyping: () => this.probe.stopRecording(),
      afterKeys: async (keys, timeoutMs = 10_000) => {
        await this.waitFor(() => {
          const recorded = this.probe.recordedKeys();
          return recorded.length >= keys && recorded[keys - 1]!.paint > 0 && this.probe.settled();
        }, timeoutMs);
      },
      work: () => {
        this.editor();
        return this.takeWork();
      },
      insertText: async (text) => {
        const v = view();
        const framesFrom = this.probe.frames.length;
        const settle = this.probe.nextSettle();
        const t0 = now();
        v.dispatch(v.state.tr.insertText(text));
        const w = await settle;
        return { settle: r1(w.at - t0), pages: this.probe.pages(), pagination: summarizeFrames(this.probe.frames.slice(framesFrom)) };
      },
      setTheme: async (theme) => {
        const mount = this.current;
        if (!mount || mount.shell !== 'canvas') throw new Error('setTheme needs the canvas shell');
        const from = mount.theme;
        const pagesBefore = this.probe.pages();
        const framesFrom = this.probe.frames.length;
        const repaginationsFrom = this.repaginations.length;
        const statusFrom = this.status.length;
        const t0 = now();
        this.current = { ...mount, theme };
        this.emit();
        await this.waitFor(() => this.status.slice(statusFrom).some((s) => s.state !== 'loading' && s.theme === theme));
        const ready = this.status.slice(statusFrom).find((s) => s.state !== 'loading' && s.theme === theme)!;
        await this.waitFor(() => this.repaginations.length > repaginationsFrom);
        const q = await this.probe.quiet(t0, 1500);
        const repaginations = this.repaginations.slice(repaginationsFrom).map((e) => ({ ...e, at: r1(e.at - t0) }));
        const settledAt = q.settledAt ?? now();
        return {
          from,
          to: theme,
          pagesBefore,
          pages: this.probe.pages(),
          toReady: r1(ready.at - t0),
          toRepaginate: repaginations[0]!.at,
          toSettled: r1(settledAt - t0),
          paginationMs: r1(settledAt - t0 - repaginations[0]!.at),
          repaginations,
          pagination: summarizeFrames(this.probe.frames.slice(framesFrom)),
        };
      },
      frames: (from = 0) => this.probe.frames.slice(from),
      frameCount: () => this.probe.frames.length,
      json: () => view().state.doc.toJSON() as JSONContent,
      pageKinds: () => {
        const out: string[] = [];
        view().state.doc.forEach((p) => out.push(String(p.attrs.kind)));
        return out;
      },
      pagesWith: (type) => {
        const out: number[] = [];
        view().state.doc.forEach((p, _offset, index) => {
          let found = false;
          p.forEach((block) => (found ||= block.type.name === type));
          if (found) out.push(index);
        });
        return out;
      },
      failedPulls: () => failedPulls(view()),
      inspect: (index) => {
        const v = view();
        const page = pageAt(v.state.doc, index);
        const next = pageAt(v.state.doc, index + 1);
        if (!page) return null;
        const m = measurePage(v, page);
        const box = (pos: number) => {
          const el = v.nodeDOM(pos);
          if (!(el instanceof HTMLElement)) return null;
          const cs = getComputedStyle(el);
          return {
            tag: el.tagName,
            rects: Array.from(el.getClientRects()).map((r) => [r.left, r.top, r.right, r.bottom].map((x) => Math.round(x * 100) / 100)),
            margin: [cs.marginTop, cs.marginBottom],
            lineHeight: cs.lineHeight,
            widows: cs.widows,
            orphans: cs.orphans,
          };
        };
        const lastPos = page.contentEnd - (page.node.lastChild?.nodeSize ?? 0);
        return {
          m: m && { ...m, first: m.first ? { index: m.first.index, pos: m.first.pos, rect: m.first.rect, startsInside: m.first.startsInside } : null },
          pull: m && next ? pullTarget(v, m, next) : null,
          nextStart: next?.contentStart ?? null,
          last: { pos: lastPos, type: page.node.lastChild?.type.name, attrs: page.node.lastChild?.attrs, size: page.node.lastChild?.content.size, ...box(lastPos) },
          nextFirst: next ? { type: next.node.firstChild?.type.name, attrs: next.node.firstChild?.attrs, size: next.node.firstChild?.content.size, ...box(next.contentStart) } : null,
        };
      },
      env: () => ({
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        devicePixelRatio: window.devicePixelRatio,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        dev: import.meta.env.DEV,
        eventTiming: (PerformanceObserver.supportedEntryTypes ?? []).includes('event'),
        longAnimationFrame: (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame'),
      }),
    };
  }
}


