// /dev/ui-kit (UI kit, plan §5 and §9): keyboard operation of the primitives in real browsers, the
// persisted UI store, and axe scans. No API is needed.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * A /dev page is ready when its content is: the navigation's budget (10 s) covers it. Every /dev page
 * loads every dev harness (about 520 modules from the dev server), which takes about 7 s in Firefox
 * under parallel load, so waiting for the 'load' event and then the default 5 s would be too tight.
 */
const PAGE_READY = { timeout: 10_000 };

async function openKit(page: Page): Promise<void> {
  await page.goto('/dev/ui-kit', { waitUntil: 'domcontentloaded' });
  await waitForKit(page);
}

async function waitForKit(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'UI kit' })).toBeVisible(PAGE_READY);
}

async function reloadKit(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForKit(page);
}

/**
 * Axe in legacy mode: axe.run in the page itself. The default mode finishes every analyze() in a new
 * blank page, which took seconds to minutes in Firefox (docs/implementation-notes.md, a11y lane). The
 * kit has no iframes, so the results are the same.
 */
async function axeViolations(page: Page) {
  return (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations;
}

/** Axe violations with impact serious or critical (all rules; the kit aims for zero overall). */
async function seriousViolations(page: Page): Promise<string[]> {
  return (await axeViolations(page))
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

async function allViolations(page: Page): Promise<string[]> {
  return (await axeViolations(page)).map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

function activeInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => Boolean(document.querySelector(sel)?.contains(document.activeElement)), selector);
}

function isInert(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => el.closest('[inert]') !== null);
}

// Each test runs in a fresh browser context, so localStorage (hb-ui) starts empty.

test.describe('axe', () => {
  test('the page has no serious violations in light and dark, forced or system', async ({ page }) => {
    await openKit(page);
    // One scan: no violation of any impact (serious ones included) on the idle kit.
    expect(await allViolations(page)).toEqual([]);

    await page.getByTestId('scheme-select').selectOption('dark');
    // Let the colour transitions finish (axe would measure contrast halfway through them).
    await page.waitForFunction(() => !document.getAnimations().some((a) => a instanceof CSSTransition && a.playState === 'running'));
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('system dark scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openKit(page);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('open menu, dialog, popover, tooltip and toasts have no serious violations', async ({ page }) => {
    await openKit(page);
    await page.getByTestId('toast-info').click();
    await page.getByTestId('toast-error').click();
    await page.getByTestId('insert-menu').click();
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByTestId('popover-trigger').click();
    await expect(page.getByTestId('popover')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByTestId('tooltip-trigger').hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByTestId('open-dialog').click();
    await expect(page.getByRole('dialog', { name: 'Brew properties' })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByTestId('open-confirm').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test.describe('Menu', () => {
  test('keyboard: open, move, jump, typeahead, activate, close', async ({ page }) => {
    await openKit(page);
    const trigger = page.getByTestId('insert-menu');
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: 'Insert' });
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const item = (name: string | RegExp) => menu.getByRole('menuitem', { name, exact: typeof name === 'string' });
    await expect(item('Table')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(/^Image/)).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitemradio', { name: 'Right' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item('Table')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('menuitemradio', { name: 'Right' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item('Table')).toBeFocused();

    // Typeahead: c → Column break, c again → Center (the disabled "Table of contents" is skipped by t).
    await page.keyboard.press('c');
    await expect(item('Column break')).toBeFocused();
    await page.keyboard.press('c');
    await expect(menu.getByRole('menuitemradio', { name: 'Center' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId('menu-align')).toHaveText('center');

    // Checkbox item with closeOnSelect false: Space toggles and the menu stays.
    await page.keyboard.press('Enter');
    await expect(item('Table')).toBeFocused();
    await page.waitForTimeout(600); // the typeahead buffer clears after 500 ms (TYPEAHEAD_TIMEOUT_MS)
    await page.keyboard.press('w');
    const wide = menu.getByRole('menuitemcheckbox', { name: 'Wide' });
    await expect(wide).toBeFocused();
    await page.keyboard.press(' ');
    await expect(wide).toHaveAttribute('aria-checked', 'true');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('menu-wide')).toHaveText('true');

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('menuitemradio', { name: 'Right' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('last-action')).toHaveText('insert image');
  });

  test('pointer: click opens, hover moves focus, outside click closes; the menu stays in the viewport', async ({ page }) => {
    await openKit(page);
    const trigger = page.getByTestId('insert-menu');
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Insert' });
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    await menu.getByRole('menuitem', { name: 'Page break', exact: false }).hover();
    await expect(menu.getByRole('menuitem', { name: /^Page break/ })).toBeFocused();
    await page.getByRole('heading', { name: 'Dialog' }).click();
    await expect(menu).toBeHidden();
  });
});

test.describe('Dialog', () => {
  test('focus moves in, Tab is trapped both ways, Escape closes and returns focus', async ({ page }) => {
    await openKit(page);
    const opener = page.getByTestId('open-dialog');
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Brew properties' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByLabel('Title')).toBeFocused();
    expect(await isInert(page.locator('main'))).toBe(true);

    // Title → Theme → Language → Notify → Cancel → Save → Close → Title.
    const order = [
      dialog.getByLabel('Theme'),
      dialog.getByRole('button', { name: 'Language' }),
      dialog.getByRole('button', { name: 'Notify' }),
      dialog.getByRole('button', { name: 'Cancel' }),
      dialog.getByRole('button', { name: 'Save' }),
      dialog.getByRole('button', { name: 'Close' }),
      dialog.getByLabel('Title'),
    ];
    for (const target of order) {
      await page.keyboard.press('Tab');
      await expect(target).toBeFocused();
      expect(await activeInside(page, '[role="dialog"]')).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(await isInert(page.locator('main'))).toBe(false);
  });

  test('Escape closes a menu inside the dialog first; the overlay click closes; toasts stay usable', async ({ page }) => {
    await openKit(page);
    await page.getByTestId('open-dialog').click();
    const dialog = page.getByRole('dialog', { name: 'Brew properties' });
    const language = dialog.getByRole('button', { name: 'Language' });
    await language.click();
    await expect(page.getByRole('menu', { name: 'Language' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(language).toBeFocused();

    // A toast raised while the modal is open is above it and not inert.
    await dialog.getByRole('button', { name: 'Notify' }).click();
    const toasts = page.getByRole('region', { name: /Notifications/ });
    await expect(toasts).toContainText('Raised from the dialog');
    expect(await isInert(toasts)).toBe(false);
    await toasts.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('last-action')).toHaveText('undo from toast');
    await expect(dialog).toBeVisible();

    await page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();
  });

  test('ConfirmDialog focuses Cancel for a destructive action and reports the choice', async ({ page }) => {
    await openKit(page);
    const opener = page.getByTestId('open-confirm');
    await opener.click();
    const alert = page.getByRole('alertdialog', { name: 'Delete this brew?' });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(alert).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.getByTestId('last-action')).toHaveText('delete cancelled');
    await page.keyboard.press('Enter');
    await alert.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('last-action')).toHaveText('deleted');
  });
});

test.describe('Toasts', () => {
  test('are announced through live regions, keep Retry reachable, and time out', async ({ page }) => {
    await openKit(page);
    const polite = page.getByTestId('toast-live-polite');
    const assertive = page.getByTestId('toast-live-assertive');
    await expect(polite).toHaveAttribute('aria-live', 'polite');
    await expect(assertive).toHaveAttribute('aria-live', 'assertive');

    await page.getByTestId('toast-info').click();
    await expect(polite).toContainText('Brew saved. Version 1');
    const region = page.getByRole('region', { name: /Notifications/ });
    await expect(region).toContainText('Brew saved');

    await page.getByTestId('toast-error').click();
    await expect(assertive).toContainText("Couldn't save the brew. Could not reach the server.");

    // F8 jumps to the toasts; Retry is reachable by keyboard.
    await page.keyboard.press('F8');
    await expect(region).toBeFocused();
    const retry = region.getByRole('button', { name: 'Retry' });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(region).not.toContainText("Couldn't save the brew");
    await expect(polite).toContainText('Retried');

    await page.getByTestId('toast-short').click();
    await expect(polite).toContainText('Heads up. A short one.');
    await expect(region.getByText('Heads up')).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(region.getByText('Heads up')).toBeHidden(); // a 1.2 s toast
  });
});

test.describe('Toolbar and Tabs', () => {
  test('the toolbar is one tab stop with arrow-key roving focus', async ({ page }) => {
    await openKit(page);
    const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
    await page.getByTestId('scheme-select').focus();
    await page.keyboard.press('Tab');
    const undo = toolbar.getByRole('button', { name: 'Undo' });
    await expect(undo).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(toolbar.getByRole('button', { name: 'Redo' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('block-type')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const bold = toolbar.getByRole('button', { name: 'Bold' });
    await expect(bold).toBeFocused();
    await page.keyboard.press('Space');
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight'); // Underline is disabled: skipped
    await expect(toolbar.getByRole('button', { name: 'Zoom out' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('spread-menu')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(undo).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('spread-menu')).toBeFocused();

    // One tab stop: Tab leaves the toolbar, Shift+Tab returns to the last used item.
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('insert-menu')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('spread-menu')).toBeFocused();

    // A menu button in the toolbar opens with ArrowDown; the choice updates the UI store.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemradio', { name: 'Single page' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('spread')).toHaveText('facing');
  });

  test('tabs move with arrow keys, skip disabled tabs, and the choice persists', async ({ page }) => {
    await openKit(page);
    const tabs = page.getByRole('tablist', { name: 'Inspector' });
    await tabs.getByRole('tab', { name: 'Node' }).click();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Page' })).toBeFocused();
    await expect(page.getByRole('tabpanel', { name: 'Page' })).toContainText('Section settings');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Help' })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');
    await reloadKit(page);
    await expect(page.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Tooltip and Popover', () => {
  test('a tooltip shows on keyboard focus and hover, and Escape hides it', async ({ page }) => {
    await openKit(page);
    const trigger = page.getByTestId('tooltip-trigger');
    await page.getByRole('button', { name: 'Delete', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('Tooltips show on hover and keyboard focus');
    await expect(trigger).toHaveAccessibleDescription('Tooltips show on hover and keyboard focus (Esc hides)');
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await expect(trigger).toBeFocused();
    // Mouse clicks don't show it; hovering does.
    await page.getByRole('heading', { name: 'Buttons' }).click();
    await trigger.hover();
    await expect(tooltip).toBeVisible();
    const tip = (await tooltip.boundingBox())!;
    const button = (await trigger.boundingBox())!;
    expect(tip.y + tip.height).toBeLessThanOrEqual(button.y);
  });

  test('the popover sits under its trigger, Escape returns focus, Tab continues after the trigger', async ({ page }) => {
    await openKit(page);
    const trigger = page.getByTestId('popover-trigger');
    const popover = page.getByRole('dialog', { name: 'Link' });

    // Room below: it opens below, aligned with the trigger's left edge. Under load the kit can still
    // be laying out (dev CSS, fonts) after its heading shows, pushing the trigger back down after one
    // scroll (it then flipped above): scroll until the trigger stays at the top.
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(async () => {
        await trigger.evaluate((el) => el.scrollIntoView({ block: 'start' }));
        return (await trigger.boundingBox())!.y;
      })
      .toBeLessThan(50);
    await trigger.click();
    await expect(popover).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    let p = (await popover.boundingBox())!;
    let t = (await trigger.boundingBox())!;
    expect(p.y).toBeGreaterThanOrEqual(t.y + t.height);
    expect(Math.abs(p.x - t.x)).toBeLessThanOrEqual(1);
    await expect(popover.getByLabel('URL')).toBeFocused();
    await page.keyboard.press('Escape');

    // No room below: it flips above.
    await trigger.evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await trigger.click();
    await expect(popover).toBeVisible();
    p = (await popover.boundingBox())!;
    t = (await trigger.boundingBox())!;
    expect(p.y + p.height).toBeLessThanOrEqual(t.y);
    await expect(popover.getByLabel('URL')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(popover.getByLabel('URL')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(popover.getByRole('button', { name: 'Apply' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(popover).toBeHidden();
    await expect(page.getByRole('button', { name: 'After popover' })).toBeFocused();
  });
});

test.describe('Drawers and the UI store', () => {
  test('drawers resize by keyboard and pointer, close back to their toggle, and persist', async ({ page }) => {
    await openKit(page);
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    const outline = page.getByRole('complementary', { name: 'Outline' });
    await expect(outline).toBeVisible();
    const handle = page.getByRole('separator', { name: 'Resize outline' });
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '272');
    expect((await outline.boundingBox())!.width).toBeCloseTo(272, 0);

    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    const inspectorHandle = page.getByRole('separator', { name: 'Resize inspector' });
    const hb = (await inspectorHandle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 - 50, hb.y + hb.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(inspectorHandle).toHaveAttribute('aria-valuenow', '350');
    expect((await inspector.boundingBox())!.width).toBeCloseTo(350, 0);

    await outline.getByRole('button', { name: 'Close outline' }).click();
    await expect(outline).toBeHidden();
    await expect(page.getByRole('button', { name: 'Outline', exact: true })).toBeFocused();

    await reloadKit(page);
    await expect(page.getByRole('complementary', { name: 'Outline' })).toBeHidden();
    await expect(page.getByRole('separator', { name: 'Resize inspector' })).toHaveAttribute('aria-valuenow', '350');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('hb-ui') ?? 'null') as { version: number; state: unknown });
    expect(stored.version).toBe(1);
    expect(stored.state).toMatchObject({ panels: { outline: { open: false, size: 272 }, inspector: { open: true, size: 350 } } });
  });

  test('zoom persists across reloads', async ({ page }) => {
    await openKit(page);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByTestId('zoom')).toHaveText('1.25');
    await reloadKit(page);
    await expect(page.getByTestId('zoom')).toHaveText('1.25');
    await expect(page.getByTestId('zoom-menu')).toHaveText('125%');
  });

  test('corrupt storage falls back to defaults', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hb-ui', '{not json'));
    await openKit(page);
    await expect(page.getByTestId('zoom')).toHaveText('1');
    await expect(page.getByTestId('zoom-menu')).toHaveText('100%');
  });
});
