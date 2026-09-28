// P8.2, presentation: reflow at 320 px and at 200 % zoom (WCAG 1.4.10, 1.4.4), reduced motion
// (2.3.3) and forced colours (a visible focus in Windows contrast themes, 2.4.7). The pages
// themselves are a two-dimensional layout (fixed-size sheets): they may scroll sideways inside the
// canvas at any width, which 1.4.10 allows; the app chrome may not. The API is the in-memory fake.
//   E2E_PORT=5376 pnpm exec playwright test e2e/a11y/layout.spec.ts
import { expect, type Page, test } from '@playwright/test';
import { richDoc } from './docs';
import { ALICE, installFakeApi } from './fakeApi';
import { activeElement, openEditor, waitForEditor, waitForPage } from './helpers';

/** What sticks out sideways: the document, <main>, the header, and chrome controls off screen. */
function overflow(page: Page) {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const main = document.querySelector('main')!;
    const header = document.querySelector('header')!;
    const offScreen = [...document.querySelectorAll<HTMLElement>('header button, header a, [role=toolbar] button, [role=toolbar] input, main h1, main button, main a, main input')]
      .filter((el) => !el.closest('.hb-canvas') && el.getClientRects().length > 0)
      .filter((el) => {
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || el.closest('[hidden], [inert]')) return false;
        const r = el.getBoundingClientRect();
        // Visually hidden elements (1×1 clipped) don't count.
        if (r.width <= 1 && r.height <= 1) return false;
        return r.left < -1 || r.right > width + 1;
      })
      .map((el) => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`);
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      main: main.scrollWidth - main.clientWidth,
      header: header.scrollWidth - header.clientWidth,
      offScreen,
    };
  });
}

/** Walks a roving toolbar from its first item with ArrowRight; returns the items that were off screen. */
async function walkToolbar(page: Page, testId: string): Promise<{ count: number; offScreen: string[] }> {
  const offScreen: string[] = [];
  let count = 0;
  const seen = new Set<string>();
  await page.keyboard.press('Home');
  for (let i = 0; i < 80; i++) {
    const item = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const r = el.getBoundingClientRect();
      return {
        key: `${el.getAttribute('data-testid') ?? ''}|${el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''}|${Math.round(r.left)},${Math.round(r.top)}`,
        name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
        inside: r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1,
        inToolbar: el.closest('[role=toolbar]')?.getAttribute('data-testid') ?? null,
        input: el instanceof HTMLInputElement,
      };
    });
    if (item.inToolbar !== testId || seen.has(item.key)) break;
    seen.add(item.key);
    count += 1;
    if (!item.inside) offScreen.push(item.name);
    // A text box keeps its arrow keys: ArrowRight at its end moves on.
    if (item.input) await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight');
  }
  return { count, offScreen };
}

const ROUTES: { name: string; path: (own: string, theirs: string) => string; editor: boolean }[] = [
  { name: 'home', path: () => '/', editor: true },
  { name: 'new brew', path: () => '/new', editor: true },
  { name: 'edit page', path: (own) => `/edit/${own}`, editor: true },
  { name: 'share page', path: (_own, theirs) => `/share/${theirs}`, editor: true },
  { name: 'account', path: () => '/account', editor: false },
  { name: 'sign in', path: () => '/login', editor: false },
  { name: 'not found', path: () => '/no/such/page', editor: false },
];

const VIEWPORTS: [string, { width: number; height: number }][] = [
  ['320 px wide', { width: 320, height: 640 }],
  ['200 % zoom (1280 × 800)', { width: 640, height: 400 }],
];

for (const [label, viewport] of VIEWPORTS) {
  test.describe(label, () => {
    test.use({ viewport });

    for (const route of ROUTES) {
      test(`no page-level sideways scrolling: ${route.name}`, async ({ page }) => {
        const api = await installFakeApi(page, { me: ALICE });
        const own = api.add({ doc: richDoc, title: 'A brew with a rather long title for a small screen' });
        const theirs = api.add({ doc: richDoc, title: 'Their brew', owner: 'bob' });
        await page.goto(route.path(own.editId, theirs.shareId), { waitUntil: 'domcontentloaded' });
        if (route.editor) await waitForEditor(page);
        else await waitForPage(page);
        const result = await overflow(page);
        expect(result, `${route.name} at ${label}`).toEqual({ document: 0, main: 0, header: 0, offScreen: [] });
        if (route.editor) {
          // The pages keep a usable share of the screen under the chrome.
          const canvas = await page.locator('[data-canvas-theme]').first().evaluate((el) => el.getBoundingClientRect().height);
          expect(canvas, `${route.name}: the pages' viewport height at ${label}`).toBeGreaterThanOrEqual(viewport.height >= 600 ? 200 : 120);
        }
      });
    }

    test('every toolbar control is reachable on screen from the keyboard', async ({ page }) => {
      await openEditor(page, { doc: richDoc });
      await page.keyboard.press('Alt+F10');
      await expect.poll(async () => (await activeElement(page)).testId === 'editor-toolbar' || (await page.getByTestId('editor-toolbar').evaluate((el) => el.contains(document.activeElement)))).toBe(true);
      const editing = await walkToolbar(page, 'editor-toolbar');
      expect(editing.count, 'items of the editing toolbar').toBeGreaterThan(15);
      expect(editing.offScreen, 'editing toolbar items off screen').toEqual([]);
      await page.keyboard.press('Escape');
      // The brew toolbar comes right before the text in the Tab order.
      await page.keyboard.press('Shift+Tab');
      await expect.poll(async () => page.getByTestId('editor-app-bar').evaluate((el) => el.contains(document.activeElement))).toBe(true);
      const brew = await walkToolbar(page, 'editor-app-bar');
      expect(brew.count, 'items of the brew toolbar').toBeGreaterThan(5);
      expect(brew.offScreen, 'brew toolbar items off screen').toEqual([]);
    });
  });
}

test.describe('reduced motion', () => {
  /** Running animations and transitions, spinners and the route-loading bar left out (they show progress). */
  const running = (page: Page) =>
    page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .filter((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
          return !target?.closest('[role=progressbar], [class*=spinner], [class*=Spinner], [class*=progress]');
        })
        .map((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
          const name = a instanceof CSSTransition ? `transition ${a.transitionProperty}` : a instanceof CSSAnimation ? `animation ${a.animationName}` : 'animation';
          return `${name} on ${target?.tagName.toLowerCase()}.${target?.className}`;
        }),
    );

  async function exercise(page: Page): Promise<string[]> {
    const seen = new Set<string>();
    const sample = async () => (await running(page)).forEach((a) => seen.add(a));
    // Hover and focus toolbar buttons, open a menu, a drawer and a navbar panel, raise a toast.
    await page.getByTestId('mark-bold').hover();
    await sample();
    await page.getByTestId('toggle-outline').hover();
    await sample();
    await page.getByTestId('block-type').click();
    await sample();
    await page.keyboard.press('Escape');
    await page.getByTestId('toggle-outline').click();
    await sample();
    await page.getByTestId('nav-new').click();
    await sample();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+s');
    await sample();
    return [...seen];
  }

  test('with reduced motion the chrome neither fades nor turns', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installFakeApi(page, { me: ALICE });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForEditor(page);
    expect(await exercise(page)).toEqual([]);
  });

  test('without it, the same steps do animate (the check above can see them)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installFakeApi(page, { me: ALICE });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForEditor(page);
    expect((await exercise(page)).length).toBeGreaterThan(0);
  });
});

test.describe('forced colours', () => {
  test('the focused control shows an outline; unfocused buttons don’t', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await openEditor(page, { doc: richDoc });
    test.skip(!(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)), 'this browser does not emulate forced colours');

    const outlineOf = (testId: string | null) =>
      page.evaluate((id) => {
        const el = (id ? document.querySelector(`[data-testid="${id}"]`) : document.activeElement) as HTMLElement;
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? '' };
      }, testId);

    // Stops of the editing toolbar, the brew toolbar and the navbar.
    const missing: string[] = [];
    await page.keyboard.press('Alt+F10');
    for (let i = 0; i < 6; i++) {
      const o = await outlineOf(null);
      if (o.style === 'none' || o.width < 1) missing.push(o.name);
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Tab');
    for (let i = 0; i < 4; i++) {
      const o = await outlineOf(null);
      if (o.style === 'none' || o.width < 1) missing.push(o.name);
      await page.keyboard.press('ArrowRight');
    }
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+Tab');
      const o = await outlineOf(null);
      if (o.style === 'none' || o.width < 1) missing.push(o.name);
    }
    expect(missing, 'focused controls without an outline').toEqual([]);

    // A button that doesn't have the focus draws no outline (else the focused one wouldn't stand out).
    expect((await outlineOf('print')).style).toBe('none');
  });

  test('list pages (user page, vault): only the focused control draws an outline', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    const api = await installFakeApi(page, { me: ALICE });
    api.add({ doc: richDoc, title: 'Forced colours brew' });
    await page.goto(`/user/${ALICE.handle}`, { waitUntil: 'domcontentloaded' });
    test.skip(!(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)), 'this browser does not emulate forced colours');
    const item = page.getByTestId('brew-item').first();
    await expect(item).toBeVisible();

    /** Outline style of every sort button, group toggle, brew title link and brew action (focused or not). */
    const outlines = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="list-sort"] button, [data-testid^="list-group-"] button, [data-testid="brew-item"] a, [data-testid="brew-item"] button')].map((el) => ({
          name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? '',
          focused: el === document.activeElement,
          outline: getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) >= 1,
        })),
      );
    const before = await outlines();
    expect(before.length).toBeGreaterThan(3);
    expect(before.filter((o) => o.outline).map((o) => o.name), 'unfocused controls with an outline').toEqual([]);

    // Tab through them: the focused one, and only it, draws an outline.
    await page.locator('[data-testid="list-sort"] button').first().focus();
    await page.keyboard.press('Shift+Tab');
    const seen = new Set<string>();
    for (let i = 0; i < before.length + 4; i++) {
      await page.keyboard.press('Tab');
      const now = await outlines();
      const focused = now.find((o) => o.focused);
      if (focused) seen.add(focused.name);
      expect(now.filter((o) => o.outline).map((o) => o.name), `focus on ${focused?.name ?? 'another control'}`).toEqual(focused ? [focused.name] : []);
    }
    expect(seen.size).toBeGreaterThan(3);

    // The vault's result list uses the same brew items.
    await page.goto('/vault', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('brew-item').first()).toBeVisible();
    const vault = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('main a, main button')].filter((el) => el !== document.activeElement && getComputedStyle(el).outlineStyle !== 'none').map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30)),
    );
    expect(vault, 'unfocused vault controls with an outline').toEqual([]);
  });
});
