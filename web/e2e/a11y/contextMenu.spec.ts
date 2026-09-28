// Accessibility of the editor's right-click menu (T4): no serious axe finding with the menu and a
// submenu open, in both colour schemes; the menu is named, its hint is its description, and the
// submenu item says it has a popup and whether it is open.
import { expect, test } from '@playwright/test';
import { richDoc, TEXTS } from './docs';
import { caretIn, type ColorScheme, expectNoSerious, openEditor, PORTAL, useScheme } from './helpers';

for (const scheme of ['light', 'dark'] as ColorScheme[]) {
  test(`${scheme} scheme: the context menu and a submenu`, async ({ page }) => {
    await useScheme(page, scheme);
    await openEditor(page, { doc: richDoc });
    await caretIn(page, TEXTS.intro);
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu', { name: 'Editing' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAccessibleDescription(/Shift\+right-click/);
    await expectNoSerious(page, 'context menu', { include: [PORTAL] });

    const insert = menu.locator('[data-menu-item="insert"]');
    await expect(insert).toHaveAttribute('aria-haspopup', 'menu');
    await expect(insert).toHaveAttribute('aria-expanded', 'false');
    await insert.focus();
    await page.keyboard.press('ArrowRight');
    await expect(insert).toHaveAttribute('aria-expanded', 'true');
    const sub = page.getByRole('menu', { name: 'Insert' });
    await expect(sub).toBeVisible();
    await expectNoSerious(page, 'context menu with a submenu', { include: [PORTAL] });
  });
}
