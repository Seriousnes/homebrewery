// P3.2 PageView and P3.3 EditorCanvas against /dev/canvas with real theme CSS: the DOM shape of
// the CSS contract, page chrome (covers, page-number counters, even/odd mirroring), live theme
// and CSS switching with the REPAGINATE meta, CSS scoping, zoom, spreads and print styles.
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { expect, type Page } from '@playwright/test';
import { newSharedPage, openCanvas, READY_TIMEOUT, test } from './helpers';

test.use({ viewport: { width: 1400, height: 1300 } });

/** Records the REPAGINATE meta of every transaction from now on. */
async function recordRepaginate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __repaginateMeta: unknown[] };
    w.__repaginateMeta = [];
    window.__editor!.on('transaction', ({ transaction }) => {
      const meta: unknown = transaction.getMeta('hbRepaginate');
      if (meta !== undefined) w.__repaginateMeta.push(meta);
    });
  });
}
const repaginateMeta = (page: Page) => page.evaluate(() => (window as unknown as { __repaginateMeta: unknown[] }).__repaginateMeta);

/**
 * Waits until the zoom sizer has the canvas's scaled size: useCanvasZoom resizes it in the frame
 * after the canvas's size changes (the theme's page height, once applied).
 */
async function sizerFollows(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLElement>('.hb-canvas')!.getBoundingClientRect();
        const sizer = document.querySelector<HTMLElement>('.hb-canvas')!.parentElement!.getBoundingClientRect();
        const sizes = { sizer: [sizer.width, sizer.height], canvas: [canvas.width, canvas.height] };
        // (The sizer's size is rounded up to whole pixels, and it is at least as wide as the viewport.)
        return Math.abs(sizer.width - canvas.width) < 2 && Math.abs(sizer.height - canvas.height) < 2 ? 'follows' : JSON.stringify(sizes);
      }),
    )
    .toBe('follows');
}

/** Whether two screenshots have the same pixels. */
function samePixels(a: Buffer, b: Buffer): boolean {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  return pa.width === pb.width && pa.height === pb.height && pa.data.equals(pb.data);
}

/** Requests held back until release(): the page waits for them as for a slow network. */
interface HeldRequests {
  /** Resolves when the first request is held. */
  arrived: Promise<void>;
  release: () => void;
}

async function holdRequests(page: Page, url: RegExp): Promise<HeldRequests> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  await page.route(url, async (route) => {
    arrive();
    await released;
    await route.continue().catch(() => undefined); // the page closed meanwhile
  });
  return { arrived, release };
}

/**
 * Stops the page's clock (Date, performance, timers, animation frames; page.clock.install() before
 * the page loads): from now on only page.clock.runFor() fires timers, so a timeout can't decide
 * the outcome.
 */
async function pauseClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1_000);
}

/** The state of the canvas's theme styles at one moment. */
interface ThemeSnapshot {
  /** Theme links that apply (not inert), by theme folder. */
  links: string[];
  /** A user theme's CSS text is adopted. */
  userTheme: boolean;
  /** A face of the new theme's text font is loaded (document.fonts). */
  font: boolean;
  /**
   * Once the new theme applies: the laid-out width of the first words of the first paragraph (the
   * new theme's text font), compared with the width once everything has loaded; before, null.
   */
  textWidth: number | null;
  /** Once the new theme applies: whether each of its textures has been decoded; before, null. */
  textures: boolean[] | null;
}

/**
 * Records the canvas's theme styles now and at every change of the theme links in <head> (a
 * MutationObserver: a link switched in, a stale link removed; the switch does both, and adopts
 * user CSS, in one task). Textures count as decoded once an image of theirs resolved decode()
 * (how the page loads images ahead; no engine tells synchronously whether an image is cached).
 */
async function recordThemeSwitch(page: Page, font: string, textures: string[]): Promise<void> {
  await page.evaluate(
    ([family, urls]) => {
      const w = window as unknown as { __themeSnapshots: ThemeSnapshot[]; __textWidth: () => number; __themeReloads: string[] };
      // A theme link that loads again once applied: its sheet was dropped and re-created (what
      // changing a link's media attribute does in Firefox), so for a moment neither theme applied.
      w.__themeReloads = [];
      document.head.addEventListener(
        'load',
        (e) => {
          const l = e.target;
          if (l instanceof HTMLLinkElement && l.hasAttribute('data-hb-theme-applied')) w.__themeReloads.push(l.getAttribute('data-hb-theme-href')!);
        },
        true,
      );
      const decoded = new Set<string>();
      const decode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode')!.value as (this: HTMLImageElement) => Promise<void>;
      HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
        const src = this.src;
        return decode.call(this).then(() => void decoded.add(src));
      };
      // Layout reads bring the page up to date: the font a face is chosen from is the one set now.
      w.__textWidth = () => {
        const text = document.querySelector('.page p')!.firstChild!;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, Math.min(40, text.textContent!.length));
        return range.getBoundingClientRect().width;
      };
      const snapshot = (): ThemeSnapshot => {
        const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[data-hb-theme-href]'))
          .filter((l) => l.sheet && l.hasAttribute('data-hb-theme-applied'))
          .map((l) => l.getAttribute('data-hb-theme-href')!.split('/')[3]!);
        const userTheme = document.adoptedStyleSheets.some((s) => Array.from(s.cssRules).some((r) => r.cssText.includes('HB User Theme')));
        const applied = links.includes('Journal') || userTheme;
        return {
          links,
          userTheme,
          font: Array.from(document.fonts).some((f) => f.family.replace(/"/g, '') === family && f.status === 'loaded'),
          textWidth: applied ? w.__textWidth() : null,
          textures: applied ? urls.map((url) => decoded.has(new URL(url, location.href).href)) : null,
        };
      };
      w.__themeSnapshots = [snapshot()];
      new MutationObserver(() => w.__themeSnapshots.push(snapshot())).observe(document.head, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['media', 'data-hb-theme-applied'],
      });
    },
    [font, textures] as const,
  );
}

const themeReloads = (page: Page) => page.evaluate(() => (window as unknown as { __themeReloads: string[] }).__themeReloads);
const themeSnapshots = (page: Page) => page.evaluate(() => (window as unknown as { __themeSnapshots: ThemeSnapshot[] }).__themeSnapshots);
/** The width recordThemeSwitch's snapshots read, now. */
const textWidth = (page: Page) => page.evaluate(() => (window as unknown as { __textWidth: () => number }).__textWidth());

/** The theme styles that apply, e.g. "Blank+5ePHB" or "Blank+user". */
const stylesOf = (s: ThemeSnapshot) => [...s.links, ...(s.userTheme ? ['user'] : [])].join('+');

/** The theme styles the snapshots show, each once, in order. */
const distinct = (snapshots: ThemeSnapshot[]) => [...new Set(snapshots.map(stylesOf))];
const statesOf = async (page: Page) => distinct(await themeSnapshots(page));

test.describe('P3.2 PageView (chrome doc: cover, counters, even/odd)', () => {
  // One page for the group: the tests read the document (the last one changes a page attribute).
  test.describe.configure({ mode: 'default' });
  let page: Page;
  test.beforeAll(async ({ browser }, testInfo) => {
    page = await newSharedPage(browser, testInfo);
    await openCanvas(page, { doc: 'chrome' });
  });
  test.afterAll(async () => {
    await page?.close();
  });

  test('DOM: .hb-canvas[lang] > .pages.ProseMirror > .page only; chrome outside the column wrapper', async () => {
    const shape = await page.evaluate(() => {
      const canvas = document.querySelector('.hb-canvas')!;
      const root = canvas.querySelector(':scope > .ProseMirror')!;
      return {
        lang: canvas.getAttribute('lang'),
        rootClasses: Array.from(root.classList),
        children: Array.from(root.children).map((c) => `${c.localName}.${c.classList[0] ?? ''}#${c.id}`),
        chrome: Array.from(root.children).map((p) =>
          Array.from(p.children)
            .filter((c) => !c.classList.contains('columnWrapper'))
            .map((c) => `${c.localName}.${Array.from(c.classList).join('.')}[${c.getAttribute('contenteditable')}]`),
        ),
        wrappers: Array.from(root.children).map((p) => p.querySelectorAll(':scope > .columnWrapper').length),
        tableWrappers: document.querySelectorAll('.tableWrapper').length,
      };
    });
    expect(shape.lang).toBe('en');
    expect(shape.rootClasses).toEqual(expect.arrayContaining(['ProseMirror', 'pages']));
    expect(shape.children).toEqual(['div.page#p1', 'div.page#p2', 'div.page#p3', 'div.page#p4', 'div.page#p5']);
    expect(shape.wrappers).toEqual([1, 1, 1, 1, 1]);
    expect(shape.chrome[0]).toEqual([
      'span.inline-block.frontCover[false]',
      'span.inline-block.banner[false]',
      'img.[false]',
      'span.inline-block.footnote[false]',
    ]);
    expect(shape.chrome[2]).toEqual([
      'span.inline-block.skipCounting[false]',
      'span.inline-block.footnote[false]',
      'span.inline-block.pageNumber.auto[false]',
    ]);
    expect(shape.tableWrappers).toBe(0);
  });

  test('front cover: the theme switches the page to its cover layout', async () => {
    const testInfo = test.info();
    const cover = await page.evaluate(() => {
      const p = document.querySelector<HTMLElement>('#p1')!;
      const banner = p.querySelector<HTMLElement>(':scope > .banner')!;
      const h1 = p.querySelector('h1')!;
      const cs = getComputedStyle(p);
      return {
        columns: getComputedStyle(p.querySelector(':scope > .columnWrapper')!).columnCount,
        textAlign: cs.textAlign,
        bannerPosition: getComputedStyle(banner).position,
        bannerBg: getComputedStyle(banner).backgroundImage,
        h1Font: getComputedStyle(h1).fontFamily,
        h1Color: getComputedStyle(h1).color,
        pageAfter: getComputedStyle(p, '::after').display,
      };
    });
    expect(cover.columns).toBe('1'); // .page:has(.frontCover) { columns: 1 }
    expect(cover.textAlign).toBe('center');
    expect(cover.bannerPosition).toBe('absolute');
    expect(cover.bannerBg).toContain('coverPageBanner.svg');
    expect(cover.h1Font).toContain('NodestoCapsCondensed');
    expect(cover.h1Color).toBe('rgb(255, 255, 255)');
    expect(cover.pageAfter).toBe('none'); // the footer accent is hidden on covers
    const coverPng = await page.locator('#p1').screenshot();
    writeFileSync(testInfo.outputPath('cover.png'), coverPng);
    await testInfo.attach('cover.png', { body: coverPng, contentType: 'image/png' });
  });

  test('page numbers: counters (skipCounting, resetCounting) and even/odd mirroring', async () => {
    const testInfo = test.info();
    const styles = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.pages > .page')).map((p) => {
        const cs = getComputedStyle(p);
        const number = p.querySelector<HTMLElement>(':scope > .pageNumber');
        const foot = p.querySelector<HTMLElement>(':scope > .footnote');
        const pr = p.getBoundingClientRect();
        return {
          increment: cs.counterIncrement,
          set: cs.counterSet,
          numberSide: number ? (number.getBoundingClientRect().left - pr.left < pr.width / 2 ? 'left' : 'right') : null,
          footSide: foot ? (foot.getBoundingClientRect().left - pr.left < pr.width / 2 - 100 ? 'left' : 'right') : null,
          content: number ? getComputedStyle(number, '::after').content : null,
        };
      }),
    );
    // Blank: .page:not(:has(.skipCounting)) { counter-increment }, :has(.resetCounting) { counter-set: 1 }
    expect(styles.map((s) => s.increment)).toEqual(['page-numbers 1', 'page-numbers 1', 'none', 'page-numbers 1', 'page-numbers 1']);
    expect(styles[3]!.set).toBe('page-numbers 1');
    expect(styles[1]!.content).toContain('counter(page-numbers)');
    // 5ePHB: odd pages number on the right, even pages (.page:nth-child(even)) on the left.
    expect(styles.map((s) => s.numberSide)).toEqual([null, 'left', 'right', 'left', 'right']);
    expect(styles.slice(1).map((s) => s.footSide)).toEqual(['left', 'right', 'left', 'right']);

    // The rendered numbers: pages 2, 3 (skipCounting) and 5 show "2"; page 4 (resetCounting)
    // shows "1". Number boxes on the same side of the same theme are drawn alike to the pixel
    // unless their digits differ (one browser, one run: nothing here depends on the host).
    const shot = async (n: number) => {
      const png = await page.locator(`#p${n} > .pageNumber`).screenshot({ animations: 'disabled', caret: 'hide' });
      writeFileSync(testInfo.outputPath(`page-number-p${n}.png`), png);
      await testInfo.attach(`page-number-p${n}.png`, { body: png, contentType: 'image/png' });
      return png;
    };
    const [n2, n3, n4, n5] = [await shot(2), await shot(3), await shot(4), await shot(5)];
    expect(samePixels(n3, n5), 'p3 and p5 both show 2').toBe(true);
    expect(samePixels(n2, n4), 'p2 shows 2, p4 shows 1').toBe(false);
  });

  test('oversized pages get the class and the badge', async () => {
    await page.evaluate(() => {
      const editor = window.__editor!;
      editor.view.dispatch(editor.state.tr.setNodeAttribute(editor.state.doc.child(0).nodeSize, 'oversized', true));
    });
    const badge = page.locator('#p2 > .hb-oversized-badge');
    await expect(badge).toBeVisible();
    await expect(page.locator('#p2')).toHaveClass(/hb-oversized/);
    expect(await badge.evaluate((b) => getComputedStyle(b).position)).toBe('absolute');
  });
});

test.describe('P3.3 EditorCanvas', () => {
  test('switching theme restyles live and dispatches the REPAGINATE meta', async ({ page }) => {
    await openCanvas(page);
    await recordRepaginate(page);
    const before = await page.evaluate(() => ({
      font: getComputedStyle(document.querySelector('.page p')!).fontFamily,
      links: Array.from(document.querySelectorAll('link[data-hb-theme-href]')).map((l) => l.getAttribute('data-hb-theme-href')),
    }));
    expect(before.font).toContain('BookInsanityRemake');
    expect(before.links.some((l) => l?.includes('/5ePHB/'))).toBe(true);

    await page.getByTestId('theme-select').selectOption('Blank');
    await expect(page.locator('[data-canvas-theme="Blank"][data-canvas-status="ready"]')).toBeVisible();
    await expect.poll(() => repaginateMeta(page)).toContain(0);
    const after = await page.evaluate(() => ({
      font: getComputedStyle(document.querySelector('.page p')!).fontFamily,
      links: Array.from(document.querySelectorAll('link[data-hb-theme-href]')).map((l) => l.getAttribute('data-hb-theme-href')),
      reasons: window.__hbCanvas!.repaginations.map((r) => r.reason),
      ready: (window.__editor!.storage as unknown as { hbCanvas: { ready: boolean } }).hbCanvas.ready,
      sameEditor: window.__editor === window.__hbCanvas!.editor,
    }));
    expect(after.font).not.toBe(before.font);
    expect(after.links.some((l) => l?.includes('/5ePHB/'))).toBe(false);
    expect(after.links.some((l) => l?.includes('/Blank/'))).toBe(true);
    expect(after.reasons).toContain('theme');
    expect(after.ready).toBe(true);
    expect(after.sameEditor).toBe(true); // restyled, not re-created
    // Blank sets no text font: pages inherit the canvas's Open Sans (served by EditorCanvas), as
    // they inherited it from upstream's app CSS.
    expect(after.font).toContain('Open Sans');
    await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Open Sans"'))).toBe(true);
  });

  // Theme switches (themeLoader.applyThemeStyles). The new theme's fonts and textures are held
  // back at the network and the page's clock is stopped, so what the switch waits for is decided
  // by the test alone: while they are held the previous theme stays; once they are released the
  // new theme applies, in one step, with its font loaded and its textures in the image cache.
  // Journal's fonts and textures are the ones the page hasn't loaded yet (it opens in 5ePHB).
  const JOURNAL_FILES = /\/(fonts|assets)\/Journal\//;
  const JOURNAL_TEXTURES = ['/assets/Journal/Background1.webp', '/assets/Journal/Background2.webp'];

  test('a theme switch is atomic: the previous theme stays until the new one applies with its fonts and textures', async ({ page }) => {
    await page.clock.install();
    await openCanvas(page);
    const held = await holdRequests(page, JOURNAL_FILES);
    await recordThemeSwitch(page, 'ReenieBeanie', JOURNAL_TEXTURES);
    await pauseClock(page); // the switch's 3 s fallback can't fire
    await page.getByTestId('theme-select').selectOption('Journal');
    await held.arrived; // Journal's stylesheet is in (inert) and its fonts and textures are loading
    const waiting = await page.evaluate(() => ({
      applied: Array.from(document.querySelectorAll('link[data-hb-theme-href*="/Journal/"]')).map((l) => l.hasAttribute('data-hb-theme-applied')),
      font: getComputedStyle(document.querySelector('.page p')!).fontFamily,
    }));
    expect(waiting.applied).toEqual([false]); // loaded inert
    expect(waiting.font).toContain('BookInsanityRemake');
    expect(await statesOf(page)).toEqual(['Blank+5ePHB']); // unchanged so far
    await expect(page.locator('[data-canvas-status]')).toHaveAttribute('data-canvas-status', 'loading');

    held.release();
    await expect(page.locator('[data-canvas-theme="Journal"][data-canvas-status="ready"]')).toBeVisible(READY_TIMEOUT);
    const snapshots = await themeSnapshots(page);
    expect(distinct(snapshots)).toEqual(['Blank+5ePHB', 'Blank+Journal']); // never neither, never both
    const flip = snapshots.find((s) => s.links.includes('Journal'))!;
    expect(flip.font, 'Journal’s font is loaded when Journal applies').toBe(true);
    expect(flip.textWidth, 'the text is laid out in Journal’s font from the switch on').toBe(await textWidth(page));
    expect(flip.textures, 'Journal’s page textures are loaded when Journal applies').toEqual([true, true]);
    expect(await themeReloads(page), 'no applied theme sheet was dropped and loaded again').toEqual([]);
  });

  test('a switch to a user theme (CSS text) waits for its fonts and textures too', async ({ page }) => {
    await page.clock.install();
    await openCanvas(page);
    // "Journal" answered by the API as a user theme: Blank, then CSS text with its own font and
    // page texture (a relative font URL, resolved against the theme's baseUrl).
    const css = [
      '@font-face { font-family: "HB User Theme"; src: url("../../fonts/Journal/PermanentMarker-Regular.woff2") format("woff2"); }',
      '.page { background-image: url("/assets/Journal/Background2.webp"); }',
      '.page p { font-family: "HB User Theme"; }',
    ].join('\n');
    const bundle = {
      name: 'User theme',
      author: null,
      styles: [
        { kind: 'url', href: '/themes/V3/Blank/style.scoped.css' },
        { kind: 'css', css, baseUrl: `${new URL(page.url()).origin}/themes/user/` },
      ],
      snippets: [],
    };
    await page.route('**/api/themes/Journal/bundle', (route) => route.fulfill({ json: bundle }));
    const held = await holdRequests(page, JOURNAL_FILES);
    await recordThemeSwitch(page, 'HB User Theme', ['/assets/Journal/Background2.webp']);
    await pauseClock(page);
    await page.getByTestId('theme-select').selectOption('Journal');
    await held.arrived;
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.page p')!).fontFamily)).toContain('BookInsanityRemake');
    expect(await statesOf(page)).toEqual(['Blank+5ePHB']);
    await expect(page.locator('[data-canvas-status]')).toHaveAttribute('data-canvas-status', 'loading');

    held.release();
    await expect(page.locator('[data-canvas-theme="Journal"][data-canvas-status="ready"]')).toBeVisible(READY_TIMEOUT);
    const snapshots = await themeSnapshots(page);
    expect(distinct(snapshots)).toEqual(['Blank+5ePHB', 'Blank+user']);
    const flip = snapshots.find((s) => s.userTheme)!;
    expect(flip.font, 'the user theme’s font is loaded when it applies').toBe(true);
    expect(flip.textWidth, 'the text is laid out in its font from the switch on').toBe(await textWidth(page));
    expect(flip.textures, 'its page texture is loaded when it applies').toEqual([true]);
  });

  test('a theme switch whose fonts and textures never arrive goes ahead after 3 s', async ({ page }) => {
    await page.clock.install();
    await openCanvas(page);
    const held = await holdRequests(page, JOURNAL_FILES);
    await recordThemeSwitch(page, 'ReenieBeanie', JOURNAL_TEXTURES);
    await pauseClock(page);
    await page.getByTestId('theme-select').selectOption('Journal');
    // The preload and its 3 s limit start in one task, before the first font or texture request.
    await held.arrived;
    await page.clock.runFor(2_999);
    expect(await statesOf(page)).toEqual(['Blank+5ePHB']);
    await page.clock.runFor(1);
    await expect.poll(() => statesOf(page)).toEqual(['Blank+5ePHB', 'Blank+Journal']);
    const flip = (await themeSnapshots(page)).at(-1)!;
    expect(flip.font, 'Journal applied without its font').toBe(false);
    held.release();
    await expect(page.locator('[data-canvas-theme="Journal"][data-canvas-status="ready"]')).toBeVisible(READY_TIMEOUT);
    expect(flip.textWidth, 'the text was laid out in a fallback font until the font came').not.toBe(await textWidth(page));
  });

  test('editing the brew CSS restyles live, stays inside the canvas and dispatches REPAGINATE', async ({ page }) => {
    await openCanvas(page);
    await recordRepaginate(page);
    const probeBefore = await page.getByTestId('leak-probe').evaluate((el) => getComputedStyle(el).color);
    await page
      .getByTestId('css-input')
      .fill('p { outline: 3px solid rgb(4, 5, 6); }\n.page p { color: rgb(1, 2, 3); }\n:root { --HB_Color_Accent: rgb(7, 8, 9); }');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.page p')!).color))
      .toBe('rgb(1, 2, 3)');
    // The restyle comes first (userCssDelayMs, 150 ms); the repagination 300 ms after the last edit.
    await expect.poll(() => page.evaluate(() => window.__hbCanvas!.repaginations.map((r) => r.reason))).toContain('css');
    const result = await page.evaluate(() => ({
      pageOutline: getComputedStyle(document.querySelector('.page p')!).outlineColor,
      accent: getComputedStyle(document.querySelector('.hb-canvas')!).getPropertyValue('--HB_Color_Accent').trim(),
      reasons: window.__hbCanvas!.repaginations.map((r) => r.reason),
    }));
    expect(result.pageOutline).toBe('rgb(4, 5, 6)');
    expect(result.accent).toBe('rgb(7, 8, 9)'); // :root → .hb-canvas
    const probe = await page
      .getByTestId('leak-probe')
      .evaluate((el) => ({ color: getComputedStyle(el).color, outline: getComputedStyle(el).outlineStyle }));
    expect(probe.color).toBe(probeBefore); // app chrome untouched
    expect(probe.outline).toBe('none');
    expect(result.reasons).toContain('css');
    expect(await repaginateMeta(page)).toContain(0);
  });

  test('brew CSS @import is fetched and scoped (constructed sheets ignore @import)', async ({ page }) => {
    const css = '@import url("data:text/css,.page%20h1%20%7B%20color%3A%20rgb(9%2C%208%2C%207)%20%7D");';
    await openCanvas(page, { css });
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.page h1')!).color))
      .toBe('rgb(9, 8, 7)');
  });

  test('cssScope in the browser: nesting, @layer, @container, @scope', async ({ page }) => {
    await openCanvas(page, { doc: 'blank' });
    const text = await page.evaluate(() =>
      window.__hbCanvas!.scopeCssText(
        '.note { color: red; & p { color: blue } } @layer brew { .x { color: red } } @container (min-width: 1px) { .y { color: red } } @scope (.monster) { p { color: red } } body.dark { color: white }',
      ),
    );
    // Nested rule left relative to its parent, its subject constrained to the canvas.
    expect(text).toMatch(/\.hb-canvas \.note \{[^]*& p:where\(\.hb-canvas, \.hb-canvas \*\) \{/);
    expect(text).toContain('.hb-canvas .x');
    expect(text).toContain('.hb-canvas .y');
    expect(text).toMatch(/@scope \(\.hb-canvas \.monster\)/);
    expect(text).toContain('.hb-canvas.dark');
    // RV-1 in the browser's own CSSOM: nested @scope roots, :not(&) and sibling selectors are
    // constrained, and nothing is dropped.
    const nested = await page.evaluate(() =>
      window.__hbCanvas!.scopeCssText('.page { @scope (:has(&)) { :scope { color: red } } :not(&)::before { content: "x" } } :root ~ p { color: red }'),
    );
    expect(nested).toMatch(/@scope \(:has\(&\):where\(\.hb-canvas, \.hb-canvas \*\)\)/);
    expect(nested).toMatch(/:not\(&\):where\(\.hb-canvas, \.hb-canvas \*\)::before/);
    expect(nested).toMatch(/\.hb-canvas ~ p:where\(\.hb-canvas, \.hb-canvas \*\)/);
  });

  // RV-1: `&` inside :not()/:has() (no implicit `& ` prefix) and sibling combinators after the
  // canvas used to style the app document (body, header, controls).
  test('nested and sibling selectors in brew CSS never reach the app', async ({ page }) => {
    await openCanvas(page);
    const read = () =>
      page.evaluate(() => {
        const elements = {
          html: document.documentElement,
          body: document.body,
          probe: document.querySelector('[data-testid="leak-probe"]')!,
          select: document.querySelector('[data-testid="theme-select"]')!,
          textarea: document.querySelector('[data-testid="css-input"]')!,
        };
        return Object.fromEntries(
          Object.entries(elements).map(([key, el]) => {
            const s = getComputedStyle(el);
            return [key, { outline: s.outlineStyle, background: s.backgroundColor, decoration: s.textDecorationLine, color: s.color }];
          }),
        );
      });
    const before = await read();
    await page
      .getByTestId('css-input')
      .fill(
        [
          '.page { :not(&) { outline: 5px solid rgb(255, 0, 0) !important } }',
          '.page { :has(&) { background: rgb(1, 2, 3) !important } }',
          '.x { @media screen { :not(&) { text-decoration: underline !important } } }',
          'body { & ~ * { color: rgb(9, 9, 9) !important } }',
          ':root ~ *, body + *, .hb-canvas ~ * { background: rgb(4, 4, 4) !important }',
          '.page p { color: rgb(1, 2, 4) }',
        ].join('\n'),
      );
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.page p')!).color))
      .toBe('rgb(1, 2, 4)');
    await page.getByTestId('css-input').blur(); // its own focus ring is not a leak
    expect(await read()).toEqual(before);
    // Inside the canvas the nested rules still apply.
    const inside = await page.evaluate(() => ({
      outline: getComputedStyle(document.querySelector('.page p')!).outlineStyle,
      pages: getComputedStyle(document.querySelector('.pages')!).backgroundColor,
      underline: getComputedStyle(document.querySelector('.page p')!).textDecorationLine,
    }));
    expect(inside).toEqual({ outline: 'solid', pages: 'rgb(1, 2, 3)', underline: 'underline' });
  });

  // RV-2: without an iframe, `position: fixed` in brew CSS (on :root/body → .hb-canvas, or on
  // page content once the theme's containment is overridden) covered the app UI.
  // One page load per case (a test each keeps them short).
  for (const [where, zoom, css] of [
    ['on body, zoom 50%', 0.5, 'body { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; background: rgb(250, 250, 250) !important }'],
    ['on page content without containment', 1, '.page, .columnWrapper { contain: none !important } .page h1 { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important }'],
  ] as const) {
    test(`brew CSS with position: fixed stays inside the canvas viewport (${where})`, async ({ page }) => {
      await openCanvas(page, { zoom, css });
      const hits = await page.evaluate(() =>
        ['theme-select', 'css-input', 'leak-probe'].map((id) => {
          const el = document.querySelector(`[data-testid="${id}"]`)!;
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return `${id}: ${hit === el || el.contains(hit) ? 'hit' : `covered by ${hit?.tagName}.${hit?.className}`}`;
        }),
      );
      expect(hits, css).toEqual(['theme-select: hit', 'css-input: hit', 'leak-probe: hit']);
    });
  }

  // RV-3: a brew @import from a host that never answers withheld the theme and the ready gate.
  test('a hanging brew @import holds back neither the theme nor (for long) the ready state', async ({ page }) => {
    let requested!: () => void;
    const importRequested = new Promise<void>((resolve) => (requested = resolve));
    await page.route('https://slow.example/**', () => requested()); // never answers
    await page.route('**/api/themes/*/bundle', (route) =>
      route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404}' }),
    );
    // The page's clock stands still from its start: only runFor() lets the import's 10 s pass.
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1_000);
    const css = '@import url("https://slow.example/font.css"); .page { background: rgb(230, 230, 250) }';
    await page.goto(`/dev/canvas?css=${encodeURIComponent(css)}`, { waitUntil: 'domcontentloaded' });
    await importRequested; // the app's import timeout starts with the request
    await expect.poll(() => page.evaluate(() => window.__editor !== undefined)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('link[data-hb-theme-slot]').length)).toBe(2);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.page')!).backgroundColor)).toBe('rgb(230, 230, 250)');
    await expect(page.locator('[data-canvas-status="loading"]')).toBeVisible(); // the import is still pending
    // Ready once the import times out, 10 s after it started: not held until the browser gives up on the host.
    await page.clock.runFor(9_999);
    await expect(page.locator('[data-canvas-status="loading"]')).toBeVisible();
    await page.clock.runFor(1);
    await expect(page.locator('[data-canvas-status="ready"]')).toBeVisible();
    const failedImports = await page.evaluate(() => {
      const last = window.__hbCanvas!.statuses.at(-1) as { failedImports?: string[] } | undefined;
      return last?.failedImports;
    });
    expect(failedImports).toEqual(['https://slow.example/font.css']);
  });

  // RV-16: the zoom anchor ignored that pages are re-centred in a canvas whose width changes with
  // the zoom, so zooming in jumped sideways.
  test('changing the zoom keeps the point at the viewport centre in place', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openCanvas(page);
    await sizerFollows(page);
    const centre = () =>
      page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('[data-canvas-status]')!;
        const p1 = document.querySelector<HTMLElement>('#p1')!;
        const vr = viewport.getBoundingClientRect();
        const pr = p1.getBoundingClientRect();
        const z = pr.width / p1.offsetWidth;
        return {
          x: (vr.left + viewport.clientWidth / 2 - pr.left) / z,
          y: (vr.top + viewport.clientHeight / 2 - pr.top) / z,
          scrollLeft: viewport.scrollLeft,
          maxScrollLeft: viewport.scrollWidth - viewport.clientWidth,
        };
      });
    await page.evaluate(() => {
      document.querySelector('[data-canvas-status]')!.scrollTop = 300;
    });
    const at1 = await centre();
    await page.getByTestId('zoom-select').selectOption('2');
    await expect(page.locator('.hb-canvas[data-zoom="2"]')).toBeVisible();
    await sizerFollows(page);
    const at2 = await centre();
    expect(at2.scrollLeft).toBeGreaterThan(0); // not clamped: the check below is meaningful
    expect(at2.scrollLeft).toBeLessThan(at2.maxScrollLeft);
    expect(Math.abs(at2.x - at1.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(at2.y - at1.y)).toBeLessThanOrEqual(2);
    await page.getByTestId('zoom-select').selectOption('0.75');
    await expect(page.locator('.hb-canvas[data-zoom="0.75"]')).toBeVisible();
    await sizerFollows(page);
    const at075 = await centre();
    expect(Math.abs(at075.x - at2.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(at075.y - at2.y)).toBeLessThanOrEqual(2);
  });

  for (const zoom of [0.5, 2]) {
    test(`zoom scales the canvas with a transform and sizes the scroll area (${zoom * 100}%)`, async ({ page }) => {
      await openCanvas(page, { zoom });
      await sizerFollows(page);
      const m = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLElement>('.hb-canvas')!;
        const viewport = canvas.parentElement!.parentElement!;
        const p1 = document.querySelector<HTMLElement>('#p1')!;
        return {
          transform: getComputedStyle(canvas).transform,
          zoomCss: getComputedStyle(canvas).zoom,
          pageWidth: p1.getBoundingClientRect().width,
          layoutWidth: p1.offsetWidth,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
          sizerHeight: canvas.parentElement!.getBoundingClientRect().height,
          canvasHeight: canvas.getBoundingClientRect().height,
          scrollWidth: viewport.scrollWidth,
          clientWidth: viewport.clientWidth,
        };
      });
      expect(m.zoomCss).toBe('1'); // never CSS zoom
      expect(m.transform).toBe(`matrix(${zoom}, 0, 0, ${zoom}, 0, 0)`);
      expect(m.layoutWidth).toBe(816); // layout is unscaled: page boundaries don't depend on zoom
      expect(m.pageWidth).toBeCloseTo(816 * zoom, 0);
      // The sizer carries the scaled height, so the scroll range is exactly the scaled pages.
      expect(Math.abs(m.sizerHeight - m.canvasHeight)).toBeLessThan(2);
      expect(Math.abs(m.scrollHeight - Math.max(m.clientHeight, m.sizerHeight))).toBeLessThan(2);
      if (zoom === 2) expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
      else expect(m.scrollWidth).toBe(m.clientWidth);
    });
  }

  test('spreads: facing puts page 1 on the right and pairs the rest; flow wraps pages', async ({ page }) => {
    await openCanvas(page, { doc: 'chrome', spread: 'facing', zoom: 0.5 });
    const facing = await page.evaluate(() => Array.from(document.querySelectorAll('.pages > .page')).map((p) => p.getBoundingClientRect()));
    expect(facing[1]!.top).toBeCloseTo(facing[2]!.top, 0);
    expect(facing[1]!.left).toBeLessThan(facing[2]!.left);
    expect(facing[0]!.left).toBeCloseTo(facing[2]!.left, 0); // recto: page 1 in the right column
    expect(facing[3]!.top).toBeGreaterThan(facing[1]!.bottom);

    await page.getByTestId('spread-select').selectOption('flow');
    await expect(page.locator('.hb-canvas[data-spread="flow"]')).toBeAttached();
    const flow = await page.evaluate(() => Array.from(document.querySelectorAll('.pages > .page')).map((p) => p.getBoundingClientRect()));
    // 1165px viewport / (408px pages + 5px gaps at 50%): two pages per row.
    expect(flow[0]!.top).toBeCloseTo(flow[1]!.top, 0);
    expect(flow[0]!.left).toBeLessThan(flow[1]!.left);
    expect(flow[2]!.top).toBeGreaterThan(flow[0]!.bottom);
  });

  test('print: only the pages, no zoom transform, no shadows or gaps', async ({ page }) => {
    await openCanvas(page, { zoom: 0.5 });
    await page.emulateMedia({ media: 'print' });
    const printed = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>('.hb-canvas')!;
      const p1 = document.querySelector<HTMLElement>('#p1')!;
      const p2 = document.querySelector<HTMLElement>('#p2')!;
      return {
        transform: getComputedStyle(canvas).transform,
        contain: getComputedStyle(canvas.closest('[data-canvas-status]')!).contain,
        toolbar: getComputedStyle(document.querySelector('[data-testid="theme-select"]')!.closest('header')!).display,
        cssInput: getComputedStyle(document.querySelector('[data-testid="css-input"]')!).display,
        shadow: getComputedStyle(p1).boxShadow,
        gap: p2.getBoundingClientRect().top - p1.getBoundingClientRect().bottom,
        pageTop: p1.getBoundingClientRect().top,
        width: p1.getBoundingClientRect().width,
      };
    });
    expect(printed.transform).toBe('none');
    expect(printed.contain).toBe('none'); // the viewport's containment (fixed-position boundary) is off
    expect(printed.toolbar).toBe('none');
    expect(printed.cssInput).toBe('none');
    expect(printed.shadow).toBe('none');
    expect(printed.gap).toBeCloseTo(0, 0);
    expect(printed.pageTop).toBeCloseTo(0, 0);
    expect(printed.width).toBeCloseTo(816, 0);
  });
});
