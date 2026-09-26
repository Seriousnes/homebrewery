// Helpers for the accessibility specs (web/e2e/a11y, P8.2): axe with the WCAG 2.1 A/AA rules,
// opening the app's pages over the fake API, and focus probes for the keyboard walkthrough.
import AxeBuilder from '@axe-core/playwright';
import type { Editor } from '@tiptap/core';
import { type Browser, expect, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { type FakeAccount, type FakeApi, type FakeBrew, type FakeNotice, installFakeApi } from './fakeApi';

/** From the end of a navigation to the editor ready and paginated, or a page's main heading: a few seconds. */
export const LOAD_TIMEOUT = { timeout: 10_000 };

/** The WCAG 2.1 level A and AA rule tags (axe also runs its best practices only when asked). */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Where the author's brew content is: its colours and heading levels are the theme's and the author's. */
export const BREW_CONTENT = '.hb-canvas .ProseMirror > .page';

export interface AxeFinding {
  id: string;
  impact: string;
  help: string;
  targets: string[];
}

export interface ScanOptions {
  /** Limit the scan to these selectors. */
  include?: string[];
  /** Leave these out (default: the brew's own pages, see BREW_CONTENT). */
  exclude?: string[];
}

/**
 * Waits until every running CSS transition and finite animation has ended (a menu or dialog
 * fading in has colours axe would read mid-way). Endless ones (spinners) are left alone.
 */
export async function animationsDone(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** Every WCAG 2.1 A/AA violation on the page (the brew content excluded unless `exclude` says otherwise). */
export async function scan(page: Page, { include, exclude = [BREW_CONTENT] }: ScanOptions = {}): Promise<AxeFinding[]> {
  await animationsDone(page);
  // Legacy mode: axe.run in the page itself. The default mode finishes every run in a new blank
  // page, which in Firefox on a loaded machine took minutes or never came back; the app has no
  // iframes, so the results are the same.
  let builder = new AxeBuilder({ page }).setLegacyMode(true).withTags(WCAG_TAGS);
  for (const selector of include ?? []) builder = builder.include(selector);
  for (const selector of exclude) builder = builder.exclude(selector);
  const results = await builder.analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? 'unknown',
    help: v.help,
    targets: v.nodes.map((n) => n.target.join(' ')),
  }));
}

export const isSerious = (f: AxeFinding) => f.impact === 'serious' || f.impact === 'critical';
export const describe = (f: AxeFinding) => `${f.id} (${f.impact}): ${f.targets.join(', ')}`;

/**
 * Asserts that axe finds no serious or critical violation; the moderate and minor ones are
 * returned (and attached to the report) for the notes.
 */
export async function expectNoSerious(page: Page, state: string, options?: ScanOptions): Promise<string[]> {
  const findings = await scan(page, options);
  const minor = findings.filter((f) => !isSerious(f)).map(describe);
  expect(findings.filter(isSerious).map(describe), `serious axe violations: ${state}`).toEqual([]);
  if (minor.length) console.log(`[a11y] ${state}: minor findings: ${minor.join(' | ')}`);
  return minor;
}

/**
 * Like expectNoSerious, but a soft assertion: every state of a walk is scanned and reported, and
 * the test fails at its end. Minor findings go to the test's annotations ('a11y-minor').
 */
export async function audit(page: Page, state: string, options?: ScanOptions): Promise<void> {
  const findings = await scan(page, options);
  expect.soft(findings.filter(isSerious).map(describe), `serious axe violations: ${state}`).toEqual([]);
  for (const f of findings.filter((x) => !isSerious(x))) {
    test.info().annotations.push({ type: 'a11y-minor', description: `${state}: ${describe(f)}` });
  }
}

/** The shared portal root: menus, popovers, dialogs, listboxes and toasts render inside it. */
export const PORTAL = '[data-hb-portal-root]';

const LAYERS = `${PORTAL} :is([role=menu], [role=listbox], [role=dialog], [role=alertdialog], [role=group][data-testid$=-panel], [data-testid$=-popover])`;

/** Presses Escape until no menu, listbox, popover or dialog is open (at most `max` times). */
export async function closeLayers(page: Page, max = 4): Promise<void> {
  // Shown ones only: some listboxes stay in the DOM, hidden.
  const open = (selector: string) => Array.from(document.querySelectorAll(selector)).filter((el) => el.checkVisibility()).length;
  for (let i = 0; i < max; i++) {
    const before = await page.evaluate(open, LAYERS);
    if (before === 0) return;
    await page.keyboard.press('Escape');
    // One layer closes per Escape (at once, or after a short closing transition).
    await page
      .waitForFunction(
        ([selector, n]) => Array.from(document.querySelectorAll(selector)).filter((el) => el.checkVisibility()).length < n,
        [LAYERS, before] as const,
        { timeout: 1_000 },
      )
      .catch(() => undefined);
  }
}

/**
 * Puts the caret into the text `needle` (at `offset` characters into it) and focuses the editor.
 * Programmatic: for the axe walks only (the keyboard spec never does this).
 */
export async function caretIn(page: Page, needle: string, offset = 2): Promise<void> {
  await page.evaluate(
    ([t, o]: readonly [string, number]) => {
      const editor = (window as unknown as { __hbEditorApp: { editor: Editor } }).__hbEditorApp.editor;
      let target = -1;
      editor.state.doc.descendants((node, pos) => {
        if (target >= 0) return false;
        if (node.isText && node.text!.includes(t)) target = pos + node.text!.indexOf(t) + o;
        return true;
      });
      if (target < 0) throw new Error(`no text "${t}" in the document`);
      editor.view.focus();
      editor.commands.setTextSelection(target);
    },
    [needle, offset] as const,
  );
}

export type ColorScheme = 'light' | 'dark';

export async function useScheme(page: Page, scheme: ColorScheme): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
}

/**
 * A page for a group of tests that walk the states of one loaded editor: the group opens it once,
 * in beforeAll (with `test.describe.configure({ mode: 'default' })` its tests run in order in one
 * worker; after a failure the next worker runs beforeAll again). Same base URL and action and
 * navigation timeouts as the page fixture.
 */
export async function newSharedPage(browser: Browser, testInfo: TestInfo, scheme: ColorScheme, viewport = { width: 1400, height: 900 }): Promise<Page> {
  const { baseURL, actionTimeout, navigationTimeout } = testInfo.project.use;
  const page = await browser.newPage({ baseURL, viewport, colorScheme: scheme });
  if (actionTimeout) page.setDefaultTimeout(actionTimeout);
  if (navigationTimeout) page.setDefaultNavigationTimeout(navigationTimeout);
  return page;
}

/** The brew toolbar's panel toggles (outline, style, inspector …) and whether each is open. */
export function panelToggles(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll('[data-testid=editor-app-bar] [data-testid^="toggle-"][aria-expanded]')).map((el) => [
        el.getAttribute('data-testid')!,
        el.getAttribute('aria-expanded') === 'true',
      ]),
    ),
  );
}

/** Opens or closes panels until each toggle is as in `states` (from panelToggles). */
export async function restorePanels(page: Page, states: Record<string, boolean>): Promise<void> {
  const now = await panelToggles(page);
  for (const [testId, open] of Object.entries(states)) {
    if (now[testId] === undefined || now[testId] === open) continue;
    await page.getByTestId(testId).click();
    await expect(page.getByTestId(testId)).toHaveAttribute('aria-expanded', String(open));
  }
}

/** Waits until a page without an editor shows its main heading and has stopped loading (route, data). */
export async function waitForPage(page: Page): Promise<void> {
  await expect(page.locator('main h1').first()).toBeVisible(LOAD_TIMEOUT);
  await expect(page.locator('main[aria-busy="true"], [data-testid=page-loading]')).toHaveCount(0);
}

/** Waits until the page's editor is mounted, its canvas ready and pagination settled. */
export async function waitForEditor(page: Page): Promise<void> {
  await expect(page.locator('[data-canvas-status="ready"]').first()).toBeVisible(LOAD_TIMEOUT);
  await page.waitForFunction(() => (window as unknown as { __hbEditorApp?: { settled(): boolean } }).__hbEditorApp?.settled() === true, undefined, LOAD_TIMEOUT);
}

export interface OpenedEditor {
  api: FakeApi;
  brew: FakeBrew;
}

/** A fake-API brew opened in the editor (/edit/:editId), signed in as its owner. */
export async function openEditor(
  page: Page,
  brew: Partial<FakeBrew> & { doc: unknown },
  options: { me?: FakeAccount | null; notices?: FakeNotice[]; query?: string } = {},
): Promise<OpenedEditor> {
  const api = await installFakeApi(page, options);
  const stored = api.add(brew);
  await page.goto(`/edit/${stored.editId}${options.query ?? ''}`, { waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  return { api, brew: stored };
}

/** The editor element (ProseMirror root). */
export const editorRoot = (page: Page): Locator => page.locator('.hb-canvas .ProseMirror');

/** What has the focus: a short description for assertions and failure messages. */
export function activeElement(page: Page): Promise<{ tag: string; role: string | null; name: string; testId: string | null; editor: boolean; inPortal: boolean }> {
  return page.evaluate(() => {
    // The app has no iframes or shadow roots: the active element is enough.
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: 'none', role: null, name: '', testId: null, editor: false, inPortal: false };
    const labelled = el.getAttribute('aria-labelledby');
    const name =
      el.getAttribute('aria-label') ??
      (labelled ? labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : null) ??
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? (el.labels?.[0]?.textContent ?? '') : null) ??
      (el.textContent ?? '').trim().slice(0, 80);
    const testId = el.getAttribute('data-testid') ?? el.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      name: name.trim(),
      testId,
      editor: el.classList.contains('ProseMirror'),
      inPortal: el.closest('[data-hb-portal-root]') !== null,
    };
  });
}

/** The focused element: the part of the page it is in, a short key, and whether its focus shows. */
export interface FocusStop {
  /** 'skip link', 'navbar', 'toolbar <label>', 'editor', 'brew' (brew content), 'panel <label>', 'main' or 'other <tag>'. */
  region: string;
  key: string;
  visible: boolean;
}

/**
 * Where the focus is and whether it shows a visible focus indicator (WCAG 2.4.7), in one round
 * trip (Tab walks call it at every stop); null when nothing in the page has the focus. Visible: an
 * outline or a box-shadow ring on the element (or on a :focus-within wrapper up to three levels
 * up), a pseudo element that draws a ring or a filled strip, or a caret (an editable text field or
 * the editor itself).
 */
export function focusStop(page: Page): Promise<FocusStop | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const toolbar = el.closest('[role=toolbar]');
    const aside = el.closest('aside');
    const region = el.classList.contains('ProseMirror')
      ? 'editor'
      : el.closest('.hb-canvas')
        ? 'brew'
        : el.closest('nav[aria-label="Main"]')
          ? 'navbar'
          : toolbar
            ? `toolbar ${toolbar.getAttribute('aria-label')}`
            : aside
              ? `panel ${aside.getAttribute('aria-label') ?? aside.querySelector('h2')?.textContent}`
              : el.closest('main')
                ? 'main'
                : (el.textContent ?? '').trim() === 'Skip to main content'
                  ? 'skip link'
                  : `other ${el.tagName.toLowerCase()}`;
    const key = `${el.tagName}|${el.getAttribute('data-testid')}|${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20)}`;
    const visible = (() => {
      // Read the focused look, not a frame of a colour transition towards it.
      for (const a of document.getAnimations()) if (a instanceof CSSTransition) a.finish();
      const ring = (s: CSSStyleDeclaration) => (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow !== 'none' && s.boxShadow !== '');
      if (ring(getComputedStyle(el))) return true;
      // Text entry shows a caret where the focus is.
      if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
      if (el instanceof HTMLInputElement && /^(text|search|email|password|url|tel|number)$/.test(el.type)) return true;
      // Some widgets draw the ring on a wrapper (:focus-within) or a pseudo element.
      for (let node: HTMLElement | null = el.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
        if (ring(getComputedStyle(node)) && node.matches(':focus-within')) return true;
      }
      for (const pseudo of ['::before', '::after']) {
        const s = getComputedStyle(el, pseudo);
        if (s.content === 'none' || s.content === 'normal') continue;
        if (ring(s)) return true;
        // A filled strip (e.g. a resize handle's line) of at least 2 px across.
        const filled = s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
        if (filled && Math.min(parseFloat(s.width) || 0, parseFloat(s.height) || 0) >= 2) return true;
      }
      return false;
    })();
    return { region, key, visible };
  });
}

/** Whether the focused element shows a visible focus indicator (see focusStop). */
export async function focusIsVisible(page: Page): Promise<boolean> {
  return (await focusStop(page))?.visible ?? false;
}

/** Focuses the first element matching `predicate`: the focused one, else by pressing Tab. */
export async function focusOn(
  page: Page,
  predicate: (active: Awaited<ReturnType<typeof activeElement>>) => boolean,
  options: { max?: number; shift?: boolean } = {},
): Promise<Awaited<ReturnType<typeof activeElement>>> {
  const active = await activeElement(page);
  return predicate(active) ? active : tabUntil(page, predicate, options);
}

/** Presses Tab until `predicate` holds for the focused element (at most `max` presses). */
export async function tabUntil(
  page: Page,
  predicate: (active: Awaited<ReturnType<typeof activeElement>>) => boolean,
  { max = 40, shift = false }: { max?: number; shift?: boolean } = {},
): Promise<Awaited<ReturnType<typeof activeElement>>> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    const active = await activeElement(page);
    if (predicate(active)) return active;
    seen.push(`${active.tag}${active.role ? `[${active.role}]` : ''} "${active.name}"${active.testId ? ` #${active.testId}` : ''}`);
  }
  throw new Error(`focus never reached the target after ${max} presses; went through: ${seen.join(' → ')}`);
}
