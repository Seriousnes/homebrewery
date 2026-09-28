// Accessibility of the "Edit source" dialog (T5): no serious axe finding with the dialog open and
// with its parse report, in both colour schemes; the code area is named and focused first, and Tab
// leaves it (no keyboard trap: CodeMirror leaves Tab to the browser here).
import { expect, test } from '@playwright/test';
import { richDoc, TEXTS } from './docs';
import { activeElement, caretIn, type ColorScheme, expectNoSerious, openEditor, PORTAL, useScheme } from './helpers';

for (const scheme of ['light', 'dark'] as ColorScheme[]) {
  test(`${scheme} scheme: the source dialog and its report`, async ({ page }) => {
    await useScheme(page, scheme);
    await openEditor(page, { doc: richDoc });
    await caretIn(page, TEXTS.intro);
    await page.getByTestId('open-source').click();
    const dialog = page.getByRole('dialog', { name: 'Edit source' });
    await expect(dialog).toBeVisible();
    const code = dialog.getByRole('textbox', { name: 'Source: Selection' });
    await expect(code).toBeFocused();
    await expectNoSerious(page, 'source dialog', { include: [PORTAL] });

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('<p onclick="x()">x</p>');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expectNoSerious(page, 'source dialog with its report', { include: [PORTAL] });

    await code.focus();
    await page.keyboard.press('Tab');
    const next = await activeElement(page);
    expect(next.inPortal, JSON.stringify(next)).toBe(true);
    expect(next.testId).not.toBe('source-code');
  });
}
