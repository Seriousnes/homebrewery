// P8.2, the axe audit (plan §11): every route and every dialog, panel and menu state of the editor,
// in the light and the dark colour scheme (Chromium and Firefox run it through the projects). The
// rules are WCAG 2.1 A and AA; a serious or critical violation fails the test, the moderate and
// minor ones are listed as 'a11y-minor' annotations. The brew's own pages are left out (their
// colours and heading levels belong to the theme and the author).
//
// Each state is set up with the pointer where that is quicker (keyboard.spec.ts covers the
// keyboard), then scanned: the whole page for a route or an idle editor, else the part that
// changed (the portal layer with the menu or dialog, or the panel), which keeps Firefox's scans
// short. The editor's states share one loaded brew per scheme (a page load per state would cost
// more than its scans); each of those tests starts from the editor as it opened. The API is the
// in-memory fake (fakeApi.ts): no API server is needed.
//   E2E_PORT=5376 npx playwright test e2e/a11y/axe.spec.ts
import { expect, type Locator, type Page, test } from '@playwright/test';
import { waitForDraft } from '../flows/helpers';
import { oversizeDoc, richDoc, TEXTS } from './docs';
import { ADMIN, ALICE, docOf, type FakeAccount, type FakeApi, type FakeNotice, installFakeApi } from './fakeApi';
import {
  activeElement,
  audit,
  caretIn,
  closeLayers,
  type ColorScheme,
  newSharedPage,
  openEditor,
  panelToggles,
  PORTAL,
  restorePanels,
  useScheme,
  waitForEditor,
  waitForPage,
} from './helpers';

const NOTICE: FakeNotice = {
  id: 'n1',
  dismissKey: 'n1',
  title: 'Maintenance tonight',
  body: 'Saving may pause for a few minutes.',
  startsAt: '2026-01-01T00:00:00Z',
  stopsAt: '2099-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
};

const LOCK = { code: 455, message: 'This brew copies a copyrighted book.', applied: '2026-09-01T00:00:00Z', reviewRequested: null };

const TOOLBAR = '[data-testid=editor-toolbar]';
const APP_BAR = '[data-testid=editor-app-bar]';
const OBJECT_LAYER = '[data-hb-object-layer]';
const INSPECTOR = '[data-testid=inspector-panel]';

/** Opens a toolbar menu button and waits for its menu. */
async function openMenu(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await expect(page.locator(`${PORTAL} [role=menu]`)).toBeVisible();
}

/** Opens a panel from its toggle in the brew toolbar (if it isn't open yet). */
async function openPanel(page: Page, panel: 'outline' | 'style' | 'inspector'): Promise<void> {
  const toggle = page.getByTestId(`toggle-${panel}`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId(`${panel}-panel`)).toBeVisible();
}

/** Waits until a combobox shows its list of suggestions (the list it controls, with options). */
async function expectSuggestions(page: Page, combobox: Locator): Promise<void> {
  await expect(combobox).toHaveAttribute('aria-controls', /.+/);
  const list = await combobox.getAttribute('aria-controls');
  await expect(page.locator(`[id="${list}"] [role=option]`).first()).toBeVisible();
}

interface Ids {
  own: string;
  ownShare: string;
  theirs: string;
  theirsEdit: string;
  locked: string;
}

interface Route {
  name: string;
  path: (ids: Ids) => string;
  me: FakeAccount | null;
  editor: boolean;
  notice?: boolean;
}

const ROUTES: Route[] = [
  { name: 'home, signed out (with a site notice)', path: () => '/', me: null, editor: true, notice: true },
  { name: 'new brew, signed out', path: () => '/new', me: null, editor: true },
  { name: 'share page, signed out', path: (i) => `/share/${i.theirs}`, me: null, editor: true },
  { name: 'locked share page (423)', path: (i) => `/share/${i.locked}`, me: null, editor: false },
  { name: 'missing share page (404)', path: () => '/share/nosuchbrew12', me: null, editor: false },
  { name: 'sign in', path: () => '/login', me: null, editor: false },
  { name: 'register', path: () => '/register', me: null, editor: false },
  { name: 'account, signed out (sign-in form)', path: () => '/account', me: null, editor: false },
  { name: 'edit page, signed out (sign-in form)', path: (i) => `/edit/${i.theirsEdit}`, me: null, editor: false },
  { name: 'unknown route (404)', path: () => '/no/such/page', me: null, editor: false },
  { name: 'home, signed in', path: () => '/', me: ALICE, editor: true },
  { name: 'new brew, signed in', path: () => '/new', me: ALICE, editor: true },
  { name: 'account, signed in', path: () => '/account', me: ALICE, editor: false },
  { name: 'edit page', path: (i) => `/edit/${i.own}`, me: ALICE, editor: true },
  { name: 'share page of my brew (Edit)', path: (i) => `/share/${i.ownShare}`, me: ALICE, editor: true },
  { name: 'share page of another brew (Clone)', path: (i) => `/share/${i.theirs}`, me: ALICE, editor: true },
  { name: 'missing edit page (404)', path: () => '/edit/nosuchbrew12', me: ALICE, editor: false },
  // Pages other lanes own (reported to them, not fixed here).
  { name: 'user page', path: () => '/user/bob', me: null, editor: false },
  { name: 'own user page', path: () => `/user/${ALICE.handle}`, me: ALICE, editor: false },
  { name: 'vault', path: () => '/vault', me: null, editor: false },
  { name: 'import', path: () => '/import', me: ALICE, editor: false },
  { name: 'admin, not an admin (403)', path: () => '/admin', me: ALICE, editor: false },
  { name: 'admin', path: () => '/admin', me: ADMIN, editor: false },
];

for (const scheme of ['light', 'dark'] as ColorScheme[]) {
  // The editor's menus, pickers, dialogs and panels on one loaded brew (see the top).
  test.describe(`${scheme} scheme: editor states`, () => {
    test.describe.configure({ mode: 'default' });
    let page: Page;
    let api: FakeApi;
    let panels: Record<string, boolean>;
    test.beforeAll(async ({ browser }, testInfo) => {
      page = await newSharedPage(browser, testInfo, scheme);
      ({ api } = await openEditor(page, { doc: richDoc }));
      panels = await panelToggles(page);
    });
    test.afterAll(async () => {
      await page?.close();
    });
    // No menu, dialog or popover open, and the panels as the editor opened with them.
    test.beforeEach(async () => {
      await closeLayers(page);
      await restorePanels(page, panels);
    });

    test('editor: idle', async () => {
      await audit(page, 'edit idle');
    });

    test('editor: block type, classes, zoom, spread and blocks menus', async () => {
      await caretIn(page, TEXTS.intro);
      const menus: [string, string, string[]][] = [
        ['block-type', 'block type menu', [PORTAL, TOOLBAR]],
        ['classes-menu', 'classes menu', [PORTAL]],
        ['zoom-menu', 'zoom menu', [PORTAL]],
        ['spread-menu', 'spread menu', [PORTAL]],
        ['block-menu', 'block menu', [PORTAL]],
      ];
      for (const [testId, state, include] of menus) {
        await openMenu(page, testId);
        await audit(page, state, { include });
        await closeLayers(page);
      }
    });

    test('editor: the table menu and the column width dialog', async () => {
      await caretIn(page, TEXTS.cell);
      await openMenu(page, 'table-menu');
      await audit(page, 'table menu (in a table)', { include: [PORTAL] });
      await page.getByRole('menuitem', { name: /Column width/ }).click();
      await expect(page.getByTestId('column-width-dialog')).toBeVisible();
      await audit(page, 'column width dialog', { include: [PORTAL] });
    });

    test('editor: insert menu (results and none) and the icon picker', async () => {
      await caretIn(page, TEXTS.intro);
      await page.getByTestId('insert-menu').click();
      await expect(page.getByTestId('insert-menu-popover')).toBeVisible();
      const snippets = page.locator(`${PORTAL} [role=option]`);
      await expect(snippets.first()).toBeVisible();
      await audit(page, 'insert menu', { include: [PORTAL] });
      await page.keyboard.type('zzzz-no-such-snippet');
      await expect(snippets).toHaveCount(0);
      await audit(page, 'insert menu, no results', { include: [PORTAL] });
      await closeLayers(page);

      await caretIn(page, TEXTS.intro);
      await page.getByTestId('insert-icon').click();
      const icons = page.locator('[data-testid=icon-results] [role=option]');
      await expect(icons.first()).toBeVisible();
      await audit(page, 'icon picker', { include: [PORTAL] });
      await page.keyboard.type('sword');
      await expect(page.getByTestId('icon-search')).toHaveValue('sword');
      await expect(icons.first()).toBeVisible();
      await audit(page, 'icon picker, searched', { include: [PORTAL] });
    });

    test('editor: link dialog and class picker', async () => {
      await caretIn(page, TEXTS.intro);
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByTestId('link-dialog')).toBeVisible();
      await audit(page, 'link dialog', { include: [PORTAL] });
      await page.getByTestId('link-dialog-href').fill('javascript:alert(1)');
      await page.getByTestId('link-dialog-apply').click();
      await expect(page.getByTestId('link-dialog-href')).toHaveAttribute('aria-invalid', 'true');
      await audit(page, 'link dialog, refused address', { include: [PORTAL] });
      await closeLayers(page);

      await caretIn(page, TEXTS.intro);
      await page.keyboard.press('ControlOrMeta+m');
      await expect(page.getByTestId('class-picker')).toBeVisible();
      await page.keyboard.type('no');
      await expect(page.locator('[data-testid=class-picker-options] [role=option]').first()).toBeVisible();
      await audit(page, 'class picker with suggestions', { include: [PORTAL] });
    });

    test('editor: outline and style drawers', async () => {
      await openPanel(page, 'outline');
      await audit(page, 'outline panel', { include: ['[data-testid=outline-panel]', APP_BAR] });

      await openPanel(page, 'style');
      const css = page.getByTestId('style-panel').locator('.cm-content');
      await expect(css).toBeVisible();
      await audit(page, 'style drawer', { include: ['[data-testid=style-panel]'] });
      await css.click();
      await page.keyboard.type('.no'); // the theme's class names: note, …
      await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
      await audit(page, 'style drawer, completion', { include: ['[data-testid=style-panel]', PORTAL] });
      await page.keyboard.press('Escape');
      await page.getByTestId('style-snippets').click();
      await expect(page.getByTestId('style-snippets-popover')).toBeVisible();
      await audit(page, 'style snippets', { include: [PORTAL] });
      await closeLayers(page);
      await audit(page, 'editor with the outline and style drawers open');
    });

    test('editor: inspector, element tab', async () => {
      // The inspector on the note block: a class chip, suggestions, a refused class.
      await caretIn(page, TEXTS.note);
      await openPanel(page, 'inspector');
      const inspector = page.getByTestId('inspector-panel');
      await inspector.getByRole('tab', { name: 'Element' }).click();
      await audit(page, 'inspector, element tab', { include: [INSPECTOR] });
      const addClass = inspector.getByRole('combobox', { name: 'Add class' });
      await addClass.fill('no');
      await expectSuggestions(page, addClass);
      await audit(page, 'inspector, class suggestions', { include: [INSPECTOR, PORTAL] });
      await addClass.fill('a:b');
      await page.keyboard.press('Enter');
      await expect(addClass).toHaveAttribute('aria-invalid', 'true');
      await audit(page, 'inspector, refused class', { include: [INSPECTOR] });
      await page.keyboard.press('Escape');
    });

    test('editor: inspector, page tab and page objects', async () => {
      await caretIn(page, TEXTS.intro);
      await openPanel(page, 'inspector');
      await page.getByTestId('inspector-panel').getByRole('tab', { name: 'Page' }).click();
      await audit(page, 'inspector, page tab', { include: [INSPECTOR] });

      // An object selected from the inspector's list: the frame, its toolbar and the object fields.
      await page.getByTestId('inspector-objects').getByRole('button').first().click();
      await expect(page.getByTestId('object-frame')).toBeVisible();
      await audit(page, 'object selected', { include: [OBJECT_LAYER, INSPECTOR] });

      // The text object edited in place.
      await caretIn(page, TEXTS.intro);
      await openMenu(page, 'block-menu');
      await page.getByRole('menuitem', { name: /^Select .*Art: inn sketch/ }).click();
      await expect(page.getByTestId('object-frame')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await activeElement(page)).name).toBe('Text object');
      await audit(page, 'object text editing', { include: [OBJECT_LAYER] });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      await audit(page, 'editor with the inspector open');
    });

    test('editor: properties and the delete confirmation', async () => {
      await page.getByTestId('open-properties').click();
      const dialog = page.getByTestId('metadata-dialog');
      await expect(dialog).toBeVisible();
      await audit(page, 'properties dialog', { include: [PORTAL] });

      await dialog.getByRole('combobox', { name: 'Theme' }).click();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('listbox', { name: 'Theme' })).toBeVisible();
      await audit(page, 'properties, theme list', { include: [PORTAL] });
      await page.keyboard.press('Escape');

      const tags = dialog.getByRole('combobox', { name: 'Tags' });
      await tags.fill('fant');
      await expectSuggestions(page, tags);
      await audit(page, 'properties, tag suggestions', { include: [PORTAL] });
      await page.keyboard.press('Escape');

      await dialog.getByRole('textbox', { name: 'Title' }).fill('x'.repeat(120));
      const thumbnail = dialog.getByRole('textbox', { name: 'Thumbnail' });
      await thumbnail.fill('not a url');
      await dialog.getByRole('textbox', { name: 'Description' }).focus();
      await expect(thumbnail).toHaveAttribute('aria-invalid', 'true');
      await audit(page, 'properties, field errors', { include: [PORTAL] });

      await page.getByTestId('delete-brew').click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await audit(page, 'delete confirmation', { include: [PORTAL] });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('metadata-dialog')).toBeHidden();
    });

    test('editor: local history and the Share and New panels', async () => {
      await page.getByTestId('open-local-history').click();
      await expect(page.getByTestId('local-history')).toBeVisible();
      await audit(page, 'local history', { include: [PORTAL] });
      await closeLayers(page);
      for (const item of ['nav-share', 'nav-new']) {
        await page.getByTestId(item).click();
        await expect(page.getByTestId(`${item}-panel`)).toBeVisible();
        await audit(page, `navbar ${item} panel`, { include: [PORTAL, 'header'] });
        await page.keyboard.press('Escape');
      }
    });

    test('editor: the Recent, Help and Account panels and a toast', async () => {
      for (const item of ['nav-recent', 'nav-help', 'nav-account']) {
        await page.getByTestId(item).click();
        await expect(page.getByTestId(`${item}-panel`)).toBeVisible();
        await audit(page, `navbar ${item} panel`, { include: [PORTAL, 'header'] });
        await page.keyboard.press('Escape');
      }
      // A toast (the share link copied, or the copy refused).
      await page.getByTestId('nav-share').click();
      await page.getByTestId('nav-share-copy').click();
      await expect(page.locator(`${PORTAL} [role=region] li, ${PORTAL} [data-testid^=toast]`).first()).toBeVisible();
      await audit(page, 'toast', { include: [PORTAL] });
      expect(api.log.length).toBeGreaterThan(0);
    });

    // Last: it types into the brew.
    test('editor: theme block controls and icon suggestions', async () => {
      await caretIn(page, TEXTS.note);
      await expect(page.getByTestId('theme-block-controls')).toBeVisible();
      await audit(page, 'theme block controls', { include: ['[data-testid=theme-block-controls]'] });

      await caretIn(page, TEXTS.intro, TEXTS.intro.length);
      await page.keyboard.type(' :swo');
      await expect(page.getByTestId('icon-suggestions')).toBeVisible();
      await audit(page, 'icon suggestions', { include: [PORTAL] });
    });
  });

  test.describe(`${scheme} scheme`, () => {
    test.beforeEach(async ({ page }) => {
      await useScheme(page, scheme);
      await page.setViewportSize({ width: 1400, height: 900 });
    });

    test('editor: layout warnings', async ({ page }) => {
      await openEditor(page, { doc: oversizeDoc, title: 'Tall' });
      await expect(page.getByTestId('layout-warnings')).toBeVisible();
      await audit(page, 'layout warnings');
      await page.getByTestId('layout-warnings').click();
      await expect(page.getByTestId('layout-warnings-popover')).toBeVisible();
      await audit(page, 'layout warnings popover', { include: [PORTAL] });
    });

    test('editor: save states and the conflict dialog', async ({ page }) => {
      // Unsaved, failing (the server answers 500 from here on), conflicting.
      const { api, brew } = await openEditor(page, { doc: docOf('Saving goes wrong here.'), title: 'Saves' });
      api.failSaves = true;
      await caretIn(page, 'Saving goes wrong here.', 3);
      await page.keyboard.type('x');
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'dirty');
      await audit(page, 'save status: unsaved', { include: [TOOLBAR] });
      await page.keyboard.press('ControlOrMeta+s');
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-tone', 'error');
      await audit(page, 'save status: failed', { include: [TOOLBAR] });
      api.failSaves = false;
      api.conflictNext.add(brew.editId);
      await page.getByTestId('save-status').getByRole('button', { name: 'Retry' }).click();
      await expect(page.getByTestId('conflict-dialog')).toBeVisible();
      await audit(page, 'conflict dialog', { include: [PORTAL] });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'conflict');
      await audit(page, 'save status: conflict', { include: [TOOLBAR] });
    });

    test('editor: lock banner', async ({ page }) => {
      // A locked brew: the banner, and the lock section of the properties.
      await openEditor(page, { doc: docOf('Locked text.'), lock: LOCK, title: 'Locked' });
      await expect(page.getByTestId('lock-banner')).toBeVisible();
      await audit(page, 'lock banner');
      await page.getByTestId('open-properties').click();
      await expect(page.getByTestId('lock-info')).toBeVisible();
      await audit(page, 'properties of a locked brew', { include: [PORTAL] });
    });

    test('editor: the unsaved-changes offer', async ({ page, context }) => {
      // Two editor page loads: the tab that leaves the draft, and the next one.
      test.setTimeout(30_000);
      // Unsaved changes of a tab closed before they were saved: the offer to restore them.
      const firstOpen = await openEditor(page, { doc: docOf('Draft text.'), title: 'Drafted' });
      firstOpen.api.failSaves = true;
      await caretIn(page, 'Draft text.', 5);
      await page.keyboard.type('unsaved ');
      await waitForDraft(page, firstOpen.brew.editId, 'unsaved');
      await page.close();
      const second = await context.newPage();
      await useScheme(second, scheme);
      const secondApi = await installFakeApi(second);
      secondApi.add({ ...firstOpen.brew });
      await second.goto(`/edit/${firstOpen.brew.editId}`, { waitUntil: 'domcontentloaded' });
      await waitForEditor(second);
      await expect(second.getByTestId('draft-offer')).toBeVisible();
      await audit(second, 'unsaved changes offer');
      await second.close();
    });

    // (The page itself: "route: share page of another brew (Clone)".)
    test('share page (read-only editor): zoom menu and outline', async ({ page }) => {
      const api = await installFakeApi(page, { me: ALICE });
      const brew = api.add({ doc: richDoc, title: 'Shared brew', owner: 'bob' });
      await page.goto(`/share/${brew.shareId}`, { waitUntil: 'domcontentloaded' });
      await waitForEditor(page);
      await page.getByTestId('zoom-menu').click();
      await expect(page.locator(`${PORTAL} [role=menu]`)).toBeVisible();
      await audit(page, 'share page, zoom menu', { include: [PORTAL] });
      await closeLayers(page);
      await openPanel(page, 'outline');
      await audit(page, 'share page, outline', { include: ['[data-testid=outline-panel]', APP_BAR] });
    });

    // Every route, one test each: who is signed in, the brews the fake API holds, whether the page
    // shows an editor, and whether another lane owns the page (P7.3/P7.4: user, vault, import and
    // admin are audited here too).
    for (const route of ROUTES) {
      test(`route: ${route.name}`, async ({ page }) => {
        const api = await installFakeApi(page, { me: route.me, notices: route.notice ? [NOTICE] : [] });
        const own = api.add({ doc: richDoc, title: 'My brew', owner: ALICE.handle });
        const theirs = api.add({ doc: richDoc, title: 'Their brew', owner: 'bob' });
        const locked = api.add({ doc: docOf('x'), title: 'Locked', owner: 'bob', lock: LOCK });
        await page.goto(route.path({ own: own.editId, ownShare: own.shareId, theirs: theirs.shareId, theirsEdit: theirs.editId, locked: locked.shareId }), {
          waitUntil: 'domcontentloaded',
        });
        if (route.editor) await waitForEditor(page);
        else await waitForPage(page);
        if (route.notice) await expect(page.getByText(NOTICE.title)).toBeVisible();
        await audit(page, route.name);
      });
    }

    test('sign-in dialog', async ({ page }) => {
      await installFakeApi(page, { me: null });
      await page.goto('/new', { waitUntil: 'domcontentloaded' });
      await waitForEditor(page);
      await page.getByTestId('new-sign-in').click();
      const prompt = page.getByTestId('sign-in-prompt');
      await expect(prompt).toBeVisible();
      await audit(page, 'sign-in dialog', { include: [PORTAL] });
      await prompt.getByRole('button', { name: /^Sign in$/ }).click();
      await expect(prompt.locator('[aria-invalid="true"]').first()).toBeVisible();
      await audit(page, 'sign-in dialog, empty fields', { include: [PORTAL] });
    });

    test('390 px: the editor, and the outline and inspector as sheets', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 780 });
      await openEditor(page, { doc: richDoc });
      await audit(page, 'editor at 390 px');
      // The sheets and their toggles (the rest of the page is the scan above).
      await openPanel(page, 'outline');
      await audit(page, 'outline sheet at 390 px', { include: ['[data-testid=outline-panel]', APP_BAR] });
      await openPanel(page, 'inspector');
      await audit(page, 'inspector sheet at 390 px', { include: [INSPECTOR, APP_BAR] });
    });

    test('320 px: home and the account panel', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await installFakeApi(page);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await waitForEditor(page);
      await audit(page, 'home at 320 px');
      await page.getByTestId('nav-account').click();
      await expect(page.getByTestId('nav-account-panel')).toBeVisible();
      await audit(page, 'account panel at 320 px', { include: [PORTAL, 'header'] });
    });
  });
}
