// Review UI-8: an imported {{toc,wide …}} lists what upstream's generator listed. Upstream had no
// depth limit: the theme's --TOC decides (Blank leaves h4–h6 out; .tocDepthH4 … and
// .tocIncludeH4 … bring them back). Imports the markdown through hbfmToDoc into /dev/snippets
// (live toc with the theme's exclusions, pagination) and reads the rendered entries.
import { expect } from '@playwright/test';
import { openSnippets, stubNetwork, waitSettled } from '../snippets/helpers';
import { test } from './helpers';

test('an imported toc lists h4 headings the theme re-includes (.tocDepthH4, .tocIncludeH4)', async ({ page }) => {
  await stubNetwork(page);
  await openSnippets(page, { theme: '5ePHB', doc: 'empty' });
  const markdown = [
    '{{toc,wide',
    '# Contents',
    '}}',
    '\\page',
    '## Section',
    '',
    '#### Left out',
    '',
    '{{tocDepthH4',
    '#### Depth four',
    '}}',
    '',
    '{{tocIncludeH4',
    '#### Included',
    '}}',
  ].join('\n');
  await page.evaluate((md) => window.__hbSnippets!.loadMarkdown(md), markdown);
  await waitSettled(page);
  const toc = page.locator('.hb-canvas div.block.toc');
  await expect(toc).toHaveAttribute('data-depth', '6');
  // A plain h4 stays out (Blank: h4 { --TOC: exclude }); the re-included ones are listed under
  // the h2, as upstream's generator nested them.
  await expect
    .poll(() => page.evaluate(() => (window.__hbSnippets!.tocRows()[0] ?? []).map(([text, number]) => `${text} ${number}`)))
    .toEqual(['Section 2', 'Depth four 2', 'Included 2']);
  await expect(toc.locator(':scope > ul > li > ul > li > h4')).toHaveCount(2);
});
