// EditorCanvas (P3.3) in jsdom with the theme loader mocked: DOM shape, the fonts/theme gate,
// and the REPAGINATE meta after a theme or CSS change. Real theme CSS and layout are covered by
// web/e2e/canvas/canvas.spec.ts.
import type { Editor } from '@tiptap/core';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advance, tickUntil } from '@/test/fakeClock';
import { docOf, p, page } from '../schema/testing';
import { createCanvasGate, isCanvasReady, REPAGINATE_META } from './canvasState';
import { EditorCanvas, type EditorCanvasHandle } from './EditorCanvas';
import type { AppliedThemeStyles, ThemeChain } from './themeLoader';
import type { RepaginateEvent } from './useCanvasTheme';

const loader = vi.hoisted(() => ({
  loadThemeChain: vi.fn(),
  applyThemeStyles: vi.fn(),
  waitForFonts: vi.fn(),
  disposeThemeSlot: vi.fn(),
}));

vi.mock('./themeLoader', () => loader);

const chainOf = (theme: string): ThemeChain => ({
  theme,
  source: 'static',
  name: theme,
  author: null,
  styles: [{ kind: 'url', href: `/themes/V3/${theme}/style.scoped.css` }],
  snippets: [`V3_${theme}`],
});

let fontsGate: { resolve: (v: boolean) => void } | null = null;

beforeEach(() => {
  loader.loadThemeChain.mockImplementation((theme: string) => Promise.resolve(chainOf(theme)));
  loader.applyThemeStyles.mockImplementation((): Promise<AppliedThemeStyles> =>
    Promise.resolve({ slot: 's', links: [], sheets: [], failed: [], skippedCss: 0, dispose: vi.fn() }),
  );
  loader.waitForFonts.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        fontsGate = { resolve };
      }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  fontsGate = null;
});

const content = docOf(page([p('Hello canvas')], { pageNumber: true, footer: 'Foot' }), page([p('Second')]));

function setup(props: Partial<Parameters<typeof EditorCanvas>[0]> = {}) {
  const repaginations: RepaginateEvent[] = [];
  const metas: unknown[] = [];
  let editor: Editor | null = null;
  let handle: EditorCanvasHandle | null = null;
  const onReady = (e: Editor, h: EditorCanvasHandle) => {
    editor = e;
    handle = h;
    e.on('transaction', ({ transaction }) => {
      const meta: unknown = transaction.getMeta(REPAGINATE_META);
      if (meta !== undefined) metas.push(meta);
    });
  };
  const utils = render(
    <EditorCanvas
      content={content}
      theme="5ePHB"
      onReady={onReady}
      onRepaginate={(e) => repaginations.push(e)}
      userCssDelayMs={0}
      {...props}
    />,
  );
  return {
    ...utils,
    repaginations,
    metas,
    get editor() {
      return editor!;
    },
    get handle() {
      return handle!;
    },
  };
}

describe('EditorCanvas', () => {
  it('renders div.hb-canvas[lang] › div.pages.ProseMirror › div.page with PageView chrome', () => {
    const { container } = setup({ lang: 'de' });
    const canvas = container.querySelector('.hb-canvas')!;
    expect(canvas.getAttribute('lang')).toBe('de');
    const root = canvas.querySelector(':scope > .ProseMirror.pages')!;
    expect(Array.from(root.children).map((c) => `${c.className}#${c.id}`)).toEqual(['page#p1', 'page#p2']);
    expect(Array.from(root.children[0]!.children).map((c) => c.className)).toEqual([
      'inline-block footnote',
      'inline-block pageNumber auto',
      'columnWrapper',
    ]);
    expect(canvas.getAttribute('data-spread')).toBe('single');
  });

  it('is not ready until the theme and fonts are applied, then dispatches REPAGINATE from page 0', async () => {
    const t = setup();
    await waitFor(() => expect(loader.applyThemeStyles).toHaveBeenCalled());
    expect(isCanvasReady(t.editor)).toBe(false);
    expect(t.handle.isReady()).toBe(false);
    expect(t.metas).toEqual([]);
    await act(async () => {
      fontsGate!.resolve(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(isCanvasReady(t.editor)).toBe(true));
    expect(t.metas).toEqual([0]);
    expect(t.repaginations).toEqual([{ from: 0, reason: 'theme' }]);
    // The chain and the (empty) user CSS went to applyThemeStyles with the cssScope hook.
    const [chain, css, options] = loader.applyThemeStyles.mock.calls[0] as [ThemeChain, string, { scopeCss: unknown; slot: string }];
    expect(chain.styles).toEqual(chainOf('5ePHB').styles);
    expect(css).toBe('');
    expect(typeof options.scopeCss).toBe('function');
    expect(options.slot).toMatch(/^canvas-/);
  });

  it('re-applies styles and dispatches REPAGINATE when the user CSS changes (same editor)', async () => {
    const t = setup();
    await waitFor(() => expect(fontsGate).not.toBeNull());
    await act(async () => {
      fontsGate!.resolve(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(t.metas).toEqual([0]));
    const editor = t.editor;

    t.rerender(
      <EditorCanvas
        content={content}
        theme="5ePHB"
        userCss=".page { color: red }"
        userCssDelayMs={0}
        onReady={() => {}}
        onRepaginate={(e) => t.repaginations.push(e)}
      />,
    );
    await waitFor(() => expect(loader.applyThemeStyles).toHaveBeenCalledTimes(2));
    expect(loader.applyThemeStyles.mock.calls[1]![1]).toBe('.page { color: red }');
    expect(loader.loadThemeChain).toHaveBeenCalledTimes(1); // same theme: chain not reloaded
    expect(isCanvasReady(editor)).toBe(false); // gated until fonts settle again
    await waitFor(() => expect(loader.waitForFonts).toHaveBeenCalledTimes(2));
    await act(async () => {
      fontsGate!.resolve(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(t.metas).toEqual([0, 0]));
    expect(t.repaginations.map((r) => r.reason)).toEqual(['theme', 'css']);
    expect(isCanvasReady(editor)).toBe(true);
  });

  it('loads the new chain and dispatches REPAGINATE when the theme changes', async () => {
    const t = setup();
    await waitFor(() => expect(fontsGate).not.toBeNull());
    await act(async () => {
      fontsGate!.resolve(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(t.metas).toEqual([0]));

    t.rerender(
      <EditorCanvas content={content} theme="Blank" userCssDelayMs={0} onReady={() => {}} onRepaginate={(e) => t.repaginations.push(e)} />,
    );
    await waitFor(() => expect(loader.loadThemeChain).toHaveBeenLastCalledWith('Blank', expect.anything()));
    await waitFor(() => expect(loader.applyThemeStyles).toHaveBeenCalledTimes(2));
    expect((loader.applyThemeStyles.mock.calls[1]![0] as ThemeChain).styles).toEqual(chainOf('Blank').styles);
    await waitFor(() => expect(loader.waitForFonts).toHaveBeenCalledTimes(2));
    await act(async () => {
      fontsGate!.resolve(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(t.metas).toEqual([0, 0]));
    expect(t.repaginations.map((r) => r.reason)).toEqual(['theme', 'theme']);
    expect(t.editor.storage.hbCanvas.theme).toBe('Blank');
  });

  it('keeps the pages hidden until the theme is first applied, and visible through later theme changes', async () => {
    const t = setup();
    const hidden = () => /unstyled/.test(t.container.querySelector('.hb-canvas')!.parentElement!.className);
    expect(hidden()).toBe(true);
    await waitFor(() => expect(fontsGate).not.toBeNull());
    expect(hidden()).toBe(true); // styles applied, fonts still loading
    await act(async () => {
      fontsGate!.resolve(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(hidden()).toBe(false));

    t.rerender(<EditorCanvas content={content} theme="Blank" userCssDelayMs={0} onReady={() => {}} />);
    await waitFor(() => expect(loader.waitForFonts).toHaveBeenCalledTimes(2));
    expect(t.container.querySelector('[data-canvas-status="loading"]')).not.toBeNull();
    expect(hidden()).toBe(false);
  });

  it('shows the pages when the theme fails to load', async () => {
    loader.loadThemeChain.mockImplementationOnce(() => Promise.reject(new Error('Unknown theme "Nope"')));
    const t = setup({ theme: 'Nope' });
    await waitFor(() => expect(t.container.querySelector('[data-canvas-status="error"]')).not.toBeNull());
    expect(t.container.querySelector('.hb-canvas')!.parentElement!.className).not.toMatch(/unstyled/);
  });

  it('reports a theme that fails to load and keeps the canvas usable', async () => {
    loader.loadThemeChain.mockImplementationOnce(() => Promise.reject(new Error('Unknown theme "Nope"')));
    const statuses: string[] = [];
    const t = setup({ theme: 'Nope', onStatusChange: (s) => statuses.push(s.state) });
    await waitFor(() => expect(statuses).toContain('error'));
    expect(isCanvasReady(t.editor)).toBe(true);
    expect(t.container.querySelector('[data-canvas-status="error"]')).not.toBeNull();
  });

  // RV-10: after a failed theme switch, a CSS edit must not re-apply the previous theme's chain
  // (which hid the error and left the status 'loading' for good).
  it('a CSS edit after a failed theme switch keeps the error and the applied styles', async () => {
    const statuses: { state: string; theme: string }[] = [];
    const onStatusChange = (s: { state: string; theme: string }) => statuses.push({ state: s.state, theme: s.theme });
    const t = setup({ onStatusChange });
    await waitFor(() => expect(fontsGate).not.toBeNull());
    await act(async () => {
      fontsGate!.resolve(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(statuses).toContainEqual({ state: 'ready', theme: '5ePHB' }));

    loader.loadThemeChain.mockImplementationOnce(() => Promise.reject(new Error('HTTP 500')));
    const props = { content, userCssDelayMs: 0, onReady: () => {}, onStatusChange };
    t.rerender(<EditorCanvas {...props} theme="Journal" />);
    await waitFor(() => expect(statuses).toContainEqual({ state: 'error', theme: 'Journal' }));
    expect(loader.applyThemeStyles).toHaveBeenCalledTimes(1);

    // The edit on a fake clock, run well past its userCssDelayMs: nothing re-applies after it.
    vi.useFakeTimers();
    t.rerender(<EditorCanvas {...props} theme="Journal" userCss=".page { background: lavender }" />);
    await advance(1000);
    vi.useRealTimers();
    expect(loader.applyThemeStyles).toHaveBeenCalledTimes(1); // 5ePHB's chain is not re-applied
    expect(t.container.querySelector('[data-canvas-status="error"][data-canvas-theme="Journal"]')).not.toBeNull();
    expect(t.editor.storage.hbCanvas.ready).toBe(true);
  });

  // RV-3: a brew @import that never answers held back the whole theme (no links) and the ready gate.
  it('applies the theme at once while a brew @import is still loading, then again with it inlined', async () => {
    let answer: ((r: Response) => void) | null = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    try {
      const t = setup({ userCss: '@import url("https://slow.test/font.css"); .page { background: lavender }' });
      await waitFor(() => expect(loader.applyThemeStyles).toHaveBeenCalledTimes(1));
      const [chain, css] = loader.applyThemeStyles.mock.calls[0] as [ThemeChain, string];
      expect(chain.styles).toEqual(chainOf('5ePHB').styles); // theme links right away
      expect(css).toContain('.page { background: lavender }'); // the brew's own rules too (imports stripped by scopeCss)
      expect(fetchSpy).toHaveBeenCalledWith('https://slow.test/font.css', expect.anything());
      expect(isCanvasReady(t.editor)).toBe(false); // gated until the import is in

      await act(async () => {
        answer!(new Response('.imported { color: red }'));
        await Promise.resolve();
      });
      await waitFor(() => expect(loader.applyThemeStyles).toHaveBeenCalledTimes(2));
      expect(loader.applyThemeStyles.mock.calls[1]![1]).toContain('.imported { color: red }');
      await waitFor(() => expect(fontsGate).not.toBeNull());
      await act(async () => {
        fontsGate!.resolve(true);
        await Promise.resolve();
      });
      await waitFor(() => expect(isCanvasReady(t.editor)).toBe(true));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // RV-4: a superseded apply that finishes last must not become "the applied styles": its chain
  // made the next CSS edit a 'theme' repagination, and unmounting disposed its (stale) result
  // instead of the slot, so the newer theme's links leaked into later canvases.
  it('a superseded apply that finishes last is ignored, and unmounting disposes the whole slot', async () => {
    let releaseFirst: (() => void) | null = null;
    loader.applyThemeStyles.mockImplementationOnce(
      (): Promise<AppliedThemeStyles> =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ slot: 's', links: [], sheets: [], failed: [], skippedCss: 0, dispose: vi.fn() });
        }),
    );
    loader.waitForFonts.mockImplementation(() => Promise.resolve(true));
    const t = setup({ theme: 'Journal' });
    await waitFor(() => expect(releaseFirst).not.toBeNull());
    const props = { content, userCssDelayMs: 0, onReady: () => {}, onRepaginate: (e: RepaginateEvent) => t.repaginations.push(e) };
    t.rerender(<EditorCanvas {...props} theme="UnearthedArcana" />);
    await waitFor(() => expect(t.repaginations.map((r) => r.reason)).toEqual(['theme']));

    await act(async () => {
      releaseFirst!(); // Journal's apply ends after UnearthedArcana's
      // A macrotask: what follows the released promise (microtasks only) has run by then.
      await new Promise((r) => setTimeout(r, 0));
    });
    t.rerender(<EditorCanvas {...props} theme="UnearthedArcana" userCss=".page { color: red }" />);
    await waitFor(() => expect(t.repaginations.map((r) => r.reason)).toEqual(['theme', 'css']));
    expect(t.editor.storage.hbCanvas.theme).toBe('UnearthedArcana');

    const slot = (loader.applyThemeStyles.mock.calls[0]![2] as { slot: string }).slot;
    t.unmount();
    expect(loader.disposeThemeSlot).toHaveBeenCalledWith(slot);
  });

  it('a CanvasGate (for the paginator, created before the editor) follows the canvas', async () => {
    const gate = createCanvasGate();
    expect(gate.isReady()).toBe(false); // no editor yet
    const t = setup({ gate });
    await waitFor(() => expect(loader.waitForFonts).toHaveBeenCalled());
    expect(gate.isReady()).toBe(false); // attached, fonts pending
    await act(async () => {
      fontsGate!.resolve(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(gate.isReady()).toBe(true));
    t.unmount();
    expect(gate.isReady()).toBe(false);
  });

  it('handle.repaginate dispatches the meta from the given page', async () => {
    const t = setup();
    await waitFor(() => expect(t.handle).toBeTruthy());
    act(() => t.handle.repaginate(1));
    expect(t.metas).toContain(1);
    expect(t.repaginations).toContainEqual({ from: 1, reason: 'manual' });
  });

  // On a fake clock (timers and performance.now): each delay is exact, and "not yet" is checked
  // 1 ms before it runs out. The steps are driven by hand (src/test/fakeClock.ts): ticks that let
  // promises settle (the clock stays put), or advancing it.
  describe('repagination debounce (plan §4.7: theme or user CSS change, debounced 300 ms)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Resolves the fonts wait of the `n`-th style apply. */
    async function fontsReady(n: number) {
      await tickUntil(() => loader.waitForFonts.mock.calls.length === n);
      await act(async () => {
        fontsGate!.resolve(true);
        await Promise.resolve();
      });
      await advance(0);
    }

    function timedSetup(props: Partial<Parameters<typeof EditorCanvas>[0]> = {}) {
      const times: { reason: string; at: number }[] = [];
      const base = { content, theme: '5ePHB', userCssDelayMs: 20, onRepaginate: (e: RepaginateEvent) => times.push({ reason: e.reason, at: performance.now() }) };
      const t = setup({ ...base, ...props }); // setup's onReady records the metas
      const rerender = (next: Partial<Parameters<typeof EditorCanvas>[0]>) => {
        t.rerender(<EditorCanvas {...base} onReady={() => {}} {...props} {...next} />);
      };
      const reasons = () => times.map((x) => x.reason);
      return { ...t, times, reasons, rerender };
    }

    it('the first load repaginates as soon as styles and fonts are ready', async () => {
      const t = timedSetup();
      const start = performance.now();
      await fontsReady(1);
      expect(t.times).toEqual([{ reason: 'theme', at: start }]); // the clock never moved
    });

    it('user CSS: styles apply after userCssDelayMs, the repagination once, 300 ms after the last edit', async () => {
      const t = timedSetup();
      await fontsReady(1);
      expect(t.metas).toEqual([0]);

      t.rerender({ userCss: '.page { color: red }' });
      await advance(19);
      expect(loader.applyThemeStyles).toHaveBeenCalledTimes(1); // userCssDelayMs (20) not over yet
      await advance(1);
      expect(loader.applyThemeStyles).toHaveBeenCalledTimes(2);
      await fontsReady(2);
      expect(isCanvasReady(t.editor)).toBe(true);
      expect(t.metas).toEqual([0]); // … but not repaginated yet

      await advance(100);
      t.rerender({ userCss: '.page { color: blue }' }); // the last edit, at 0 ms
      await advance(20);
      expect(loader.applyThemeStyles).toHaveBeenCalledTimes(3);
      expect(loader.applyThemeStyles.mock.calls[2]![1]).toBe('.page { color: blue }');
      await fontsReady(3);
      await advance(279); // 299 ms
      expect(t.metas).toEqual([0]);
      await advance(1); // 300 ms
      expect(t.metas).toEqual([0, 0]);
      expect(t.reasons()).toEqual(['theme', 'css']); // one repagination for both edits
      await advance(1000);
      expect(t.metas).toEqual([0, 0]);
    });

    it('an edit back to the applied CSS (no new apply) still repaginates, 300 ms after it', async () => {
      const t = timedSetup();
      await fontsReady(1);
      t.rerender({ userCss: 'p { color: red }' });
      await advance(20);
      await fontsReady(2);
      t.rerender({ userCss: 'p { color: green }' });
      await advance(10);
      t.rerender({ userCss: 'p { color: red }' }); // within userCssDelayMs: no apply. At 0 ms
      await advance(299);
      expect(t.reasons()).toEqual(['theme']);
      await advance(1);
      expect(t.reasons()).toEqual(['theme', 'css']);
      expect(loader.applyThemeStyles).toHaveBeenCalledTimes(2);
    });

    it('a theme change repaginates no sooner than repaginateDelayMs after it', async () => {
      const t = timedSetup({ repaginateDelayMs: 400 });
      await fontsReady(1);
      t.rerender({ theme: 'Blank' }); // at 0 ms
      await fontsReady(2);
      await advance(399);
      expect(t.reasons()).toEqual(['theme']);
      await advance(1);
      expect(t.reasons()).toEqual(['theme', 'theme']);
    });

    it('unmounting cancels a pending repagination', async () => {
      const t = timedSetup();
      await fontsReady(1);
      t.rerender({ userCss: 'p { color: red }' });
      await advance(20);
      await fontsReady(2);
      t.unmount();
      await advance(1000); // well past the 300 ms
      expect(t.reasons()).toEqual(['theme']);
    });
  });

  it('applies editable and zoom', async () => {
    const t = setup({ editable: false, zoom: 0.5 });
    await waitFor(() => expect(t.editor).toBeTruthy());
    expect(t.editor.isEditable).toBe(false);
    const canvas = t.container.querySelector<HTMLElement>('.hb-canvas')!;
    expect(canvas.style.transform).toBe('scale(0.5)');
    expect(t.editor.storage.hbCanvas.zoom).toBe(0.5);
  });
});
