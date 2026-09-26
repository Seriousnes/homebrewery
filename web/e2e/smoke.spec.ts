import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

interface ThemeCatalog {
  themes: { key: string; renderer: string; style: string; scopedStyle: string }[];
}

test('the app shell renders on /', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'The Homebrewery', exact: true })).toBeVisible();

  // The page is the welcome brew in the editor: its pages are brew content (upstream's welcome
  // text skips heading levels), so axe checks the app around them. Legacy mode runs axe in the page
  // itself: the default mode finishes in a new blank page, which Firefox can take minutes to open
  // (e2e/a11y/helpers.ts). The app has no iframes, so the results are the same.
  const results = await new AxeBuilder({ page }).setLegacyMode(true).exclude('.hb-canvas .ProseMirror > .page').analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test('scoped 5ePHB theme CSS is served', { tag: '@smoke' }, async ({ request }) => {
  const response = await request.get('/themes/V3/5ePHB/style.scoped.css');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/css');
  expect(await response.text()).toContain('.hb-canvas');
});

test('every V3 theme in themes.json has both stylesheets', { tag: '@smoke' }, async ({ request }) => {
  const response = await request.get('/themes/themes.json');
  expect(response.status()).toBe(200);
  const catalog = (await response.json()) as ThemeCatalog;
  expect(catalog.themes.map((theme) => theme.key)).toEqual(
    expect.arrayContaining(['Blank', '5ePHB', '5eDMG', 'Journal', 'UnearthedArcana']),
  );
  for (const theme of catalog.themes) {
    expect(theme.renderer).toBe('V3');
    for (const url of [theme.style, theme.scopedStyle]) {
      const css = await request.get(url);
      expect(css.status(), url).toBe(200);
    }
  }
});

test('fonts and assets referenced by theme CSS are served', { tag: '@smoke' }, async ({ request }) => {
  // Blank declares the fonts (relative ../../../fonts/… URLs); 5ePHB uses images (absolute
  // /assets/… URLs). Each reference is resolved against its stylesheet, as a browser does.
  const references = [
    { css: '/themes/V3/Blank/style.css', pattern: /url\((['"]?)(\.\.\/\.\.\/\.\.\/fonts\/[^'")]+\.woff2)\1\)/ },
    { css: '/themes/V3/5ePHB/style.css', pattern: /url\((['"]?)(\/assets\/[^'")]+\.(?:png|jpg|svg|webp))\1\)/ },
  ];
  for (const { css, pattern } of references) {
    const text = await (await request.get(css)).text();
    const ref = pattern.exec(text)?.[2];
    expect(ref, css).toBeDefined();
    const url = new URL(ref ?? '', new URL(css, 'http://localhost')).pathname;
    const response = await request.get(url);
    expect(response.status(), url).toBe(200);
    expect(response.headers()['content-type'], url).toMatch(/^(font|image)\//);
  }
});
