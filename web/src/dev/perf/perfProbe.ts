// In-page performance instrumentation for P8.1 (plan §4.10): what the /dev/perf page records while
// Playwright types, edits and switches themes.
//
//   keystrokes     keydown (capture, on window) → the next animation frame → the first task after
//                  that frame's rendering (a MessageChannel message posted from the frame's rAF):
//                  "event to next paint" on the main thread, the way INP counts it. Pagination's
//                  own rAF callback runs in the same frame, after ours (it is requested later, by
//                  the transaction), so its work is inside the measurement.
//   event timing   PerformanceObserver 'event' entries (durationThreshold 16, the minimum) where
//                  the browser has them: the browser's own input-to-paint duration, 8 ms granular.
//   long frames    'long-animation-frame' entries (Chromium) with script attribution.
//   pagination     every scheduler run (setPaginationProfiler): steps, document changes, time in
//                  steps and in dispatch; settles.
import type { Editor } from '@tiptap/core';
import { isCanvasReady } from '@/editor/canvas/canvasState';
import { isSettled, paginationKey, setPaginationProfiler, type PaginationFrameProfile } from '@/editor/pagination';
import { summarize, shareAbove, type Summary } from './perfStats';

export interface KeySample {
  key: string;
  /** keydown event.timeStamp (performance.now() clock) */
  at: number;
  /**
   * ms from the keydown to the end of its input processing: the later of the keydown task and the
   * input event's task (handlers, ProseMirror's transaction, editor listeners)
   */
  handlers: number;
  /** ms from the keydown to the start of the next animation frame */
  frame: number;
  /** ms from the keydown to the first task after that frame's rendering (event to next paint) */
  paint: number;
  /**
   * ms of main-thread work the keystroke caused: its input processing (handlers) plus the next
   * frame's work (rAF callbacks, pagination included, and the frame's style, layout and paint).
   * `paint` also includes the wait for the next frame (up to one frame interval, 16.7 ms at
   * 60 Hz); this is the part that must fit in a frame for the keystroke to show in the first one.
   */
  work: number;
  /** ms from the keydown to the next pagination settle (null: none before recording stopped) */
  settle: number | null;
  /** pagination steps run in the keystroke's frame */
  frameSteps: number;
  /** ms of pagination work in the keystroke's frame */
  frameWork: number;
  /**
   * ms in view.dispatch for the keystroke's own transactions (not pagination's) before its frame:
   * applying them (plugin state, appended transactions), the view update and the editor's
   * listeners; `view` is the view update (updateState) part of it
   */
  dispatch: number;
  view: number;
}

export interface EventTimingSample {
  name: string;
  startTime: number;
  duration: number;
  processing: number;
  interactionId: number;
}

export interface LongFrameSample {
  startTime: number;
  duration: number;
  blockingDuration: number;
  scripts: { invoker: string; source: string; duration: number }[];
}

export interface PaginationSummary {
  frames: number;
  steps: number;
  docSteps: number;
  stepMs: number;
  dispatchMs: number;
  settles: number;
  /** ms per step (measure + transaction + dispatch) */
  msPerStep: number;
  maxFrameMs: number;
  actions: Record<string, number>;
  /** per action: steps, ms in paginatePage (measuring) and in dispatch, on average */
  byAction: Record<string, { n: number; stepMs: number; dispatchMs: number }>;
  /** the slowest steps (paginatePage + dispatch) */
  slowest: { page: number; action: string; stepMs: number; dispatchMs: number }[];
}

export interface TypingReport {
  keys: KeySample[];
  paint: Summary;
  work: Summary;
  frame: Summary;
  handlers: Summary;
  /** the keystroke's own transactions in view.dispatch, and the view update part of that */
  dispatch: Summary;
  view: Summary;
  settle: Summary;
  /** share of keystrokes whose event-to-paint exceeded 16 ms */
  over16: number;
  /** share of keystrokes whose work exceeded 16 ms (a frame missed) */
  workOver16: number;
  eventTiming: {
    supported: boolean;
    /** keydown entries at or above the 16 ms threshold (the rest were faster) */
    keydownOver16: number;
    /** entries longer than 16 ms (duration is rounded to 8 ms: 24 and up) */
    keydownOver24: number;
    maxKeydown: number;
    entries: EventTimingSample[];
  };
  longFrames: LongFrameSample[];
  pagination: PaginationSummary;
}

export interface SettleWatch {
  /** performance.now() of the settle (end of the scheduler run that settled) */
  at: number;
  frames: number;
  steps: number;
}

const now = () => performance.now();
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Resolves after the next animation frame's rendering (rAF, then a MessageChannel task). */
export function afterNextPaint(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve(now());
      channel.port2.postMessage(null);
    });
  });
}

export function summarizeFrames(frames: readonly PaginationFrameProfile[]): PaginationSummary {
  const actions: Record<string, number> = {};
  const byAction: PaginationSummary['byAction'] = {};
  const details: PaginationFrameProfile['detail'] = [];
  let steps = 0;
  let docSteps = 0;
  let stepMs = 0;
  let dispatchMs = 0;
  let settles = 0;
  let maxFrameMs = 0;
  for (const f of frames) {
    steps += f.steps;
    docSteps += f.docSteps;
    stepMs += f.stepMs;
    dispatchMs += f.dispatchMs;
    if (f.settled) settles += 1;
    maxFrameMs = Math.max(maxFrameMs, f.end - f.start);
    for (const [action, n] of Object.entries(f.actions)) actions[action] = (actions[action] ?? 0) + (n ?? 0);
    for (const d of f.detail) {
      const a = (byAction[d.action] ??= { n: 0, stepMs: 0, dispatchMs: 0 });
      a.n += 1;
      a.stepMs += d.stepMs;
      a.dispatchMs += d.dispatchMs;
      details.push(d);
    }
  }
  for (const a of Object.values(byAction)) {
    a.stepMs = Math.round((a.stepMs / a.n) * 100) / 100;
    a.dispatchMs = Math.round((a.dispatchMs / a.n) * 100) / 100;
  }
  const slowest = details
    .sort((x, y) => y.stepMs + y.dispatchMs - (x.stepMs + x.dispatchMs))
    .slice(0, 8)
    .map((d) => ({ page: d.page, action: d.action, stepMs: r1(d.stepMs), dispatchMs: r1(d.dispatchMs) }));
  return {
    frames: frames.length,
    steps,
    docSteps,
    stepMs: r1(stepMs),
    dispatchMs: r1(dispatchMs),
    settles,
    msPerStep: steps ? Math.round(((stepMs + dispatchMs) / steps) * 100) / 100 : 0,
    maxFrameMs: r1(maxFrameMs),
    actions,
    byAction,
    slowest,
  };
}

export function eventTimingSupported(): boolean {
  return typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes ?? []).includes('event');
}

interface Recording {
  keys: KeySample[];
  events: EventTimingSample[];
  longFrames: LongFrameSample[];
  framesFrom: number;
}

/**
 * One probe per page. It follows the editor it is attached to; pagination frames are recorded
 * for every paginated editor (the profiler hook is module-wide).
 */
export class PerfProbe {
  readonly frames: PaginationFrameProfile[] = [];
  /**
   * Every pagination step since the last takePasses(), in order and by pass (a pass ends with the
   * scheduler run that settled): the work the perf specs count.
   */
  private passLog: { page: number; action: string }[][] = [[]];
  private recording: Recording | null = null;
  private observers: { observer: PerformanceObserver; handle: (entries: PerformanceEntryList) => void }[] = [];
  /** the keystroke whose frame is running (between its rAF and the task after the frame) */
  private frameKey: KeySample | null = null;
  private settleWaiters: { resolve: (w: SettleWatch) => void; since: number }[] = [];

  /** `editor` returns the live editor (React StrictMode and remounts re-create it). */
  private readonly editor: () => Editor | null;

  constructor(editor: () => Editor | null) {
    this.editor = editor;
  }

  /** Starts recording pagination frames (the profiler hook is module-wide: one probe at a time). */
  start(): void {
    setPaginationProfiler(this.onFrame);
  }

  stop(): void {
    setPaginationProfiler(null);
    this.stopObservers();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('input', this.onInput, true);
  }

  /** Canvas ready (theme, CSS, fonts) and pagination idle. */
  settled(): boolean {
    const e = this.editor();
    return !!e && !e.isDestroyed && isCanvasReady(e) && isSettled(e.state);
  }

  pages(): number {
    return this.editor()?.state.doc.childCount ?? 0;
  }

  stats() {
    const e = this.editor();
    return e ? (paginationKey.getState(e.state)?.stats ?? null) : null;
  }

  private readonly onFrame = (frame: PaginationFrameProfile): void => {
    this.frames.push(frame);
    if (this.frames.length > 50_000) this.frames.splice(0, 25_000);
    const pass = this.passLog[this.passLog.length - 1]!;
    for (const d of frame.detail) pass.push({ page: d.page, action: d.action });
    if (frame.settled) this.passLog.push([]);
    if (this.passLog.length > 20_000) this.passLog.splice(0, 10_000);
    // The keystroke whose next frame this is (its rAF runs before pagination's).
    const key = this.frameKey;
    if (key && frame.start >= key.at + key.frame - 0.5) {
      key.frameSteps += frame.steps;
      key.frameWork = Math.round((key.frameWork + frame.end - frame.start) * 100) / 100;
    }
    if (!frame.settled) return;
    for (const k of this.recording?.keys ?? []) if (k.settle === null && frame.end >= k.at) k.settle = r1(frame.end - k.at);
    if (this.settleWaiters.length > 0) {
      const waiters = this.settleWaiters;
      this.settleWaiters = [];
      for (const w of waiters) {
        const since = this.frames.filter((f) => f.start >= w.since);
        w.resolve({ at: frame.end, frames: since.length, steps: since.reduce((s, f) => s + f.steps, 0) });
      }
    }
  };

  /**
   * The pagination passes since the last call: each pass's steps in order (page and action); the
   * last one is still running when it doesn't end in a settle.
   */
  takePasses(): { page: number; action: string }[][] {
    const passes = this.passLog.filter((p) => p.length > 0);
    this.passLog = [[]];
    return passes;
  }

  /** The keystrokes recorded so far (startRecording; empty when not recording). */
  recordedKeys(): readonly KeySample[] {
    return this.recording?.keys ?? [];
  }

  /** Resolves at the next settle (the end of a scheduler run that settled). Rejects after `timeoutMs`. */
  nextSettle(timeoutMs = 60_000): Promise<SettleWatch> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no settle within ${timeoutMs} ms`)), timeoutMs);
      this.settleWaiters.push({
        since: now(),
        resolve: (w) => {
          clearTimeout(timer);
          resolve(w);
        },
      });
    });
  }

  /**
   * Waits until the canvas is ready and pagination settled, and no scheduler run happened for
   * `quietMs`; returns the time of the last settle since `since` (null when none) and the work
   * since then.
   */
  async quiet(since: number, quietMs = 1000, timeoutMs = 180_000): Promise<{ settledAt: number | null; frames: number; steps: number; docSteps: number }> {
    const deadline = now() + timeoutMs;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const last = this.frames.length ? this.frames[this.frames.length - 1]! : null;
      const idleFor = last ? now() - last.end : Number.POSITIVE_INFINITY;
      if (this.settled() && idleFor >= quietMs) break;
      if (now() > deadline) throw new Error(`pagination not quiet within ${timeoutMs} ms`);
    }
    const run = this.frames.filter((f) => f.start >= since);
    const settles = run.filter((f) => f.settled);
    return {
      settledAt: settles.length ? settles[settles.length - 1]!.end : null,
      frames: run.length,
      steps: run.reduce((s, f) => s + f.steps, 0),
      docSteps: run.reduce((s, f) => s + f.docSteps, 0),
    };
  }

  // Typing ----------------------------------------------------------------------------------------

  startRecording(): void {
    this.recording = { keys: [], events: [], longFrames: [], framesFrom: this.frames.length };
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('input', this.onInput, true);
    this.startObservers();
    this.wrapView();
  }

  /** The view whose dispatch and updateState are timed while recording, and how to restore them. */
  private wrapped: { restore: () => void } | null = null;

  /**
   * Times view.dispatch and view.updateState of the editor's view while recording (own properties
   * shadowing the prototype's methods; removed again when recording stops). Pagination's
   * transactions (PAGINATE meta) are left out: the frame's work counts them.
   */
  private wrapView(): void {
    this.wrapped?.restore();
    const view = this.editor()?.view;
    if (!view) return;
    const dispatch = view.dispatch.bind(view);
    const updateState = view.updateState.bind(view);
    let depth = 0;
    let own = false;
    view.dispatch = (tr) => {
      const key = this.inputKey;
      const top = depth === 0;
      if (top) own = key !== null && tr.getMeta('hbPaginate') === undefined;
      depth += 1;
      const t0 = now();
      try {
        dispatch(tr);
      } finally {
        depth -= 1;
        if (top && own && key) key.dispatch = r1(key.dispatch + now() - t0);
      }
    };
    view.updateState = (state) => {
      const key = this.inputKey;
      const t0 = now();
      try {
        updateState(state);
      } finally {
        if (own && key) key.view = r1(key.view + now() - t0);
      }
    };
    this.wrapped = {
      restore: () => {
        delete (view as unknown as Record<string, unknown>).dispatch;
        delete (view as unknown as Record<string, unknown>).updateState;
      },
    };
  }

  stopRecording(): TypingReport {
    this.stopObservers();
    const rec = this.recording ?? { keys: [], events: [], longFrames: [], framesFrom: this.frames.length };
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('input', this.onInput, true);
    this.wrapped?.restore();
    this.wrapped = null;
    this.recording = null;
    this.frameKey = null;
    this.inputKey = null;
    const keys = rec.keys.filter((k) => k.paint > 0);
    for (const k of keys) k.work = r1(k.handlers + (k.paint - k.frame));
    const paints = keys.map((k) => k.paint);
    const works = keys.map((k) => k.work);
    const keydowns = rec.events.filter((e) => e.name === 'keydown');
    return {
      keys,
      paint: summarize(paints),
      work: summarize(works),
      frame: summarize(keys.map((k) => k.frame)),
      handlers: summarize(keys.map((k) => k.handlers)),
      dispatch: summarize(keys.map((k) => k.dispatch)),
      view: summarize(keys.map((k) => k.view)),
      settle: summarize(keys.flatMap((k) => (k.settle === null ? [] : [k.settle]))),
      over16: shareAbove(paints, 16),
      workOver16: shareAbove(works, 16),
      eventTiming: {
        supported: eventTimingSupported(),
        keydownOver16: keydowns.length,
        keydownOver24: keydowns.filter((e) => e.duration > 16).length,
        maxKeydown: keydowns.reduce((m, e) => Math.max(m, e.duration), 0),
        entries: rec.events,
      },
      longFrames: rec.longFrames,
      pagination: summarizeFrames(this.frames.slice(rec.framesFrom)),
    };
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const rec = this.recording;
    if (!rec) return;
    const at = event.timeStamp;
    const sample: KeySample = { key: event.key, at, handlers: 0, frame: 0, paint: 0, work: 0, settle: null, frameSteps: 0, frameWork: 0, dispatch: 0, view: 0 };
    rec.keys.push(sample);
    this.inputKey = sample;
    // The keystroke's task: keydown handlers (keymaps), the input, ProseMirror's DOM-change
    // transaction (flushed in a microtask) and the editor listeners. A message posted now runs as
    // the next task, after all of that. The input event may come in a task of its own (onInput).
    this.afterTask(sample);
    requestAnimationFrame(() => {
      if (this.inputKey === sample) this.inputKey = null;
      sample.frame = r1(now() - at);
      this.frameKey = sample;
      const after = new MessageChannel();
      after.port1.onmessage = () => {
        sample.paint = r1(now() - at);
        if (this.frameKey === sample) this.frameKey = null;
      };
      after.port2.postMessage(null);
    });
  };

  /** The keystroke whose input event may still come (between its keydown and its frame). */
  private inputKey: KeySample | null = null;

  /** Records the end of the current task as the end of `sample`'s input processing (the latest wins). */
  private afterTask(sample: KeySample): void {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      sample.handlers = Math.max(sample.handlers, r1(now() - sample.at));
    };
    channel.port2.postMessage(null);
  }

  private readonly onInput = (): void => {
    if (this.inputKey) this.afterTask(this.inputKey);
  };

  private startObservers(): void {
    this.stopObservers();
    const rec = this.recording;
    if (!rec) return;
    const observe = (type: string, handle: (entries: PerformanceEntryList) => void, init: Record<string, unknown> = {}) => {
      const observer = new PerformanceObserver((list) => handle(list.getEntries()));
      observer.observe({ type, ...init });
      this.observers.push({ observer, handle });
    };
    if (eventTimingSupported()) {
      observe(
        'event',
        (entries) => {
          for (const e of entries as PerformanceEventTiming[]) {
            rec.events.push({
              name: e.name,
              startTime: r1(e.startTime),
              duration: e.duration,
              processing: r1(e.processingEnd - e.processingStart),
              interactionId: (e as PerformanceEventTiming & { interactionId?: number }).interactionId ?? 0,
            });
          }
        },
        { durationThreshold: 16 },
      );
    }
    if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
      observe('long-animation-frame', (entries) => {
        for (const e of entries) {
          const loaf = e as PerformanceEntry & {
            blockingDuration?: number;
            scripts?: { invoker?: string; sourceURL?: string; sourceFunctionName?: string; duration: number }[];
          };
          rec.longFrames.push({
            startTime: Math.round(e.startTime),
            duration: Math.round(e.duration),
            blockingDuration: Math.round(loaf.blockingDuration ?? 0),
            scripts: (loaf.scripts ?? [])
              .filter((s) => s.duration >= 5)
              .map((s) => ({
                invoker: s.invoker ?? '',
                source: `${s.sourceFunctionName ?? ''} ${(s.sourceURL ?? '').replace(/^.*\/src\//, 'src/')}`.trim(),
                duration: Math.round(s.duration),
              })),
          });
        }
      });
    }
  }

  private stopObservers(): void {
    for (const { observer, handle } of this.observers) {
      // Entries still queued belong to the recording.
      handle(observer.takeRecords());
      observer.disconnect();
    }
    this.observers = [];
  }
}
