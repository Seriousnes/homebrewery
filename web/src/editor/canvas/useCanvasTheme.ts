// Theme chain + user CSS + fonts for one EditorCanvas (plan §5, §4.7).
//
// 1. theme changes → loadThemeChain (API bundle, static fallback). The canvas is marked not
//    ready (isCanvasReady → false) until step 2 finishes.
// 2. chain or user CSS changes (the CSS debounced by userCssDelayMs) → applyThemeStyles: theme
//    <link>s at the start of <head>, CSS text through cssScope into document.adoptedStyleSheets
//    after them. CSS with @imports is applied at once without them, and again once they are
//    inlined (inlineCssImports: fetched, failed or timed out), so a slow import host never holds
//    back the theme. Then waitForFonts. Only a chain for the current theme is applied.
// 3. Ready → isCanvasReady(editor) = true and requestRepagination(editor, 0), debounced (plan
//    §4.7): no sooner than repaginateDelayMs after the last theme or user CSS change. The first
//    load repaginates at once.
// 4. Later font loads (document.fonts `loadingdone`) → requestRepagination(editor, 0) again.
import type { Editor } from '@tiptap/core';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { isCanvasReady, requestRepagination, setCanvasReady, type RepaginateReason } from './canvasState';
import { extractCssImports, inlineCssImports, scopeCss } from './cssScope';
import { applyThemeStyles, disposeThemeSlot, loadThemeChain, waitForFonts, type AppliedThemeStyles, type ThemeChain } from './themeLoader';

export type CanvasStatus =
  | { state: 'loading'; theme: string }
  | {
      state: 'ready';
      theme: string;
      chain: ThemeChain;
      /** Theme stylesheets that failed to load. */
      failed: string[];
      /** @import URLs of the user CSS / user themes that could not be fetched. */
      failedImports: string[];
      /** false when waiting for fonts timed out. */
      fontsLoaded: boolean;
    }
  | { state: 'error'; theme: string; message: string };

export interface RepaginateEvent {
  from: number;
  reason: RepaginateReason;
}

/** Default of UseCanvasThemeOptions.userCssDelayMs. */
export const USER_CSS_DELAY_MS = 150;
/** Default of UseCanvasThemeOptions.repaginateDelayMs (plan §4.7: theme or user CSS change, debounced 300 ms). */
export const REPAGINATE_DELAY_MS = 300;

export interface UseCanvasThemeOptions {
  editor: Editor | null;
  theme: string;
  /** The brew's CSS, as edited (the hook debounces it). */
  userCss: string;
  /** Delay before a user CSS edit restyles the canvas (ms, default 150). */
  userCssDelayMs?: number;
  /**
   * Debounce of the repagination (REPAGINATE from page 0) a theme or user CSS change triggers
   * (ms, default 300): dispatched once the change's styles and fonts are applied, and no sooner
   * than this long after the last theme or user CSS change. The first load repaginates at once.
   */
  repaginateDelayMs?: number;
  themeSource?: 'auto' | 'api' | 'static';
  /** Independent style slot for this canvas (applyThemeStyles). */
  slot: string;
  canvas: () => HTMLElement | null;
  onStatusChange?: (status: CanvasStatus) => void;
  onRepaginate?: (event: RepaginateEvent) => void;
}

/** The value, delayed by `ms` after its last change (the first value is immediate). */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, debounced, ms]);
  return debounced;
}

export function useCanvasTheme(options: UseCanvasThemeOptions): CanvasStatus {
  const { editor, theme, themeSource, slot } = options;
  const userCss = useDebouncedValue(options.userCss, options.userCssDelayMs ?? USER_CSS_DELAY_MS);
  // Results of loading/applying (set asynchronously); while the current theme has none, the
  // status is 'loading'.
  const [result, setResult] = useState<CanvasStatus | null>(null);
  const status: CanvasStatus = result && result.theme === theme ? result : { state: 'loading', theme };
  const [chain, setChain] = useState<ThemeChain | null>(null);
  /** The chain whose styles were last applied (a change of user CSS alone is a 'css' repagination). */
  const appliedChainRef = useRef<ThemeChain | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const importCache = useRef(new Map<string, Promise<string | null>>());

  const notifyStatus = useEffectEvent((next: CanvasStatus) => options.onStatusChange?.(next));
  const emitStatus = useEffectEvent((next: CanvasStatus) => {
    setResult(next);
    options.onStatusChange?.(next);
  });
  const repaginate = useEffectEvent((reason: RepaginateReason) => {
    if (requestRepagination(editor, 0)) options.onRepaginate?.({ from: 0, reason });
  });
  const canvasElement = useEffectEvent(() => options.canvas());

  // Repagination debounce (plan §4.7). changedAt: performance.now() of the last theme or user CSS
  // change (-Infinity until the first one, so the first load repaginates at once).
  const changedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const inputsRef = useRef({ theme, userCss: options.userCss });
  const repaginateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelRepaginate = useEffectEvent(() => {
    clearTimeout(repaginateTimer.current);
    repaginateTimer.current = undefined;
  });
  // Dispatches the repagination once repaginateDelayMs have passed since the last change. A change
  // after this call pushes it back again (a change back to the applied CSS starts no new apply).
  const scheduleRepaginate = useEffectEvent((reason: RepaginateReason) => {
    cancelRepaginate();
    const run = () => {
      const wait = changedAtRef.current + (options.repaginateDelayMs ?? REPAGINATE_DELAY_MS) - performance.now();
      if (wait > 0) {
        repaginateTimer.current = setTimeout(run, wait);
        return;
      }
      repaginateTimer.current = undefined;
      if (mountedRef.current) repaginate(reason);
    };
    run();
  });

  useEffect(() => {
    const previous = inputsRef.current;
    if (previous.theme === theme && previous.userCss === options.userCss) return;
    inputsRef.current = { theme, userCss: options.userCss };
    changedAtRef.current = performance.now();
  }, [theme, options.userCss]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRepaginate();
      // The whole slot, not the last result: applies to one slot share and replace its links.
      disposeThemeSlot(slot);
    };
  }, [slot]);

  // 1. Theme → chain.
  useEffect(() => {
    const controller = new AbortController();
    cancelRepaginate(); // the new theme's apply schedules its own
    setCanvasReady(editor, false, theme);
    notifyStatus({ state: 'loading', theme });
    loadThemeChain(theme, { source: themeSource, signal: controller.signal }).then(
      (loaded) => {
        if (!controller.signal.aborted) setChain(loaded);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // Keep whatever styles are applied; layout may proceed with them.
        setCanvasReady(editor, true);
        emitStatus({ state: 'error', theme, message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [editor, theme, themeSource]);

  // 2. Chain + user CSS → styles → fonts → ready.
  useEffect(() => {
    // A chain loaded for another theme (the current theme's chain is loading, or failed to load)
    // is never applied: a CSS edit after a failed theme switch keeps the error and the styles.
    if (!chain || chain.theme !== theme) return;
    const generation = ++generationRef.current;
    // Aborted when superseded (new chain, CSS or theme) and on unmount.
    const controller = new AbortController();
    const current = () => generation === generationRef.current && !controller.signal.aborted;
    const kind: RepaginateReason = appliedChainRef.current === chain ? 'css' : 'theme';
    cancelRepaginate(); // this apply schedules its own, with the styles it applies
    setCanvasReady(editor, false, chain.theme);

    const run = async () => {
      const failedImports: string[] = [];
      const inline = async (css: string, baseUrl: string) => {
        const result = await inlineCssImports(css, { baseUrl, cache: importCache.current, signal: controller.signal });
        failedImports.push(...result.failed);
        return result.css;
      };
      const texts = [...chain.styles.flatMap((s) => (s.kind === 'css' ? [s.css] : [])), userCss];
      let applied: AppliedThemeStyles;
      if (!texts.some((css) => extractCssImports(css).length > 0)) {
        applied = await applyThemeStyles(chain, userCss, { slot, scopeCss });
      } else {
        // Imports (web fonts on another host, typically) are fetched while the theme's links and
        // the CSS without its imports (scopeCss drops them) apply; then the CSS is applied again
        // with the imported sheets inlined.
        const inlining = Promise.all([
          Promise.all(
            chain.styles.map(async (s) => (s.kind === 'css' ? { ...s, css: await inline(s.css, s.baseUrl ?? document.baseURI) } : s)),
          ),
          userCss ? inline(userCss, document.baseURI) : '',
        ]);
        await applyThemeStyles(chain, userCss, { slot, scopeCss });
        if (!current()) return;
        const [styles, css] = await inlining;
        if (!current()) return;
        // The links are in place and settled: no second wait for them.
        applied = await applyThemeStyles({ styles }, css, { slot, scopeCss, timeoutMs: 0 });
      }
      // A newer apply (or the unmount, which disposed the slot) owns the styles now.
      if (!current()) return;
      appliedChainRef.current = chain;
      const fontsLoaded = await waitForFonts({ root: canvasElement() });
      if (!current() || !mountedRef.current) return;
      setCanvasReady(editor, true, chain.theme);
      scheduleRepaginate(kind);
      emitStatus({ state: 'ready', theme: chain.theme, chain, failed: applied.failed, failedImports, fontsLoaded });
    };
    run().catch((error: unknown) => {
      if (!current()) return;
      setCanvasReady(editor, true);
      emitStatus({ state: 'error', theme: chain.theme, message: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [editor, chain, userCss, slot, theme]);

  // 4. Late font loads (a font first used after the gate, user CSS fonts) re-check every page.
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts || !editor) return;
    let frame = 0;
    const onLoadingDone = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (isCanvasReady(editor)) repaginate('fonts');
      });
    };
    fonts.addEventListener('loadingdone', onLoadingDone);
    return () => {
      fonts.removeEventListener('loadingdone', onLoadingDone);
      cancelAnimationFrame(frame);
    };
  }, [editor]);

  return status;
}
