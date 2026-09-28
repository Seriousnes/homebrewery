// P5.3 page objects on /dev/objects: select, drag, resize, nudge, edit text in place, z-order,
// delete, inline image ⇄ object, and a cover page built from scratch without the inspector.
// Every change is one undo step; objects never make pagination move content.
// E2E_PORT=5328 pnpm exec playwright test e2e/objects
import { expect, type Page } from '@playwright/test';
import {
  test,
  blockMenu,
  caretAfter,
  center,
  clickObject,
  drag,
  frame,
  markersOf,
  objectEl,
  objectsOf,
  objectToolbar,
  openObjects,
  pageCount,
  pageEl,
  pageTexts,
  px,
  selected,
  settle,
  styleProp,
  undo,
} from './helpers';

const SVG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="#693"/></svg>')}`;

async function frameMatchesObject(page: Page, pageIndex: number, id: string) {
  const f = (await frame(page).boundingBox())!;
  const o = (await objectEl(page, pageIndex, id).boundingBox())!;
  expect(Math.abs(f.x - o.x)).toBeLessThan(1.5);
  expect(Math.abs(f.y - o.y)).toBeLessThan(1.5);
  expect(Math.abs(f.width - o.width)).toBeLessThan(1.5);
  expect(Math.abs(f.height - o.height)).toBeLessThan(1.5);
}

test('a cover page is built from scratch without the inspector', async ({ page }) => {
  await openObjects(page, { doc: 'blank' });
  expect(await pageCount(page)).toBe(1);

  // 1. Page break at the end of the text: a new manual page (a new section).
  await caretAfter(page, 'A second paragraph.');
  await blockMenu(page, 'Page break (new section)');
  await settle(page);
  expect(await pageCount(page)).toBe(2);

  // 2. The new page becomes a front cover (block menu, page group).
  await blockMenu(page, 'Front cover', 'menuitemradio');
  await expect.poll(() => markersOf(page, 1)).toEqual(['frontCover']);
  await expect(pageEl(page, 1).locator('> span.frontCover')).toHaveCount(1);
  // The theme's cover layout applies (5ePHB: .page:has(.frontCover)).
  const coverColumns = await pageEl(page, 1).evaluate((el) => getComputedStyle(el.querySelector(':scope > .columnWrapper')!).columnCount);
  expect(coverColumns).toBe('1');

  // 3. An image object from a URL: placed, selected, focused.
  await blockMenu(page, 'Add image object…');
  await page.getByTestId('image-object-url').fill(SVG);
  await page.getByTestId('image-object-submit').click();
  await expect.poll(async () => (await objectsOf(page, 1)).length).toBe(1);
  const [image] = await objectsOf(page, 1);
  expect(image).toMatchObject({ kind: 'image', src: SVG });
  await expect(frame(page)).toBeVisible();
  await expect(frame(page)).toBeFocused();
  await frameMatchesObject(page, 1, image!.id);

  // 4. Drag it: left/top move by the pointer delta (zoom 100%), one undo step.
  const start = await objectsOf(page, 1);
  await drag(page, await center(frame(page)), 120, 80);
  const moved = (await objectsOf(page, 1))[0]!;
  expect(px(styleProp(moved, 'left')) - px(styleProp(start[0], 'left'))).toBeCloseTo(120, -0.5);
  expect(px(styleProp(moved, 'top')) - px(styleProp(start[0], 'top'))).toBeCloseTo(80, -0.5);
  await frameMatchesObject(page, 1, image!.id);

  // 5. Resize with the bottom-right handle: an image keeps its aspect ratio.
  const before = (await objectEl(page, 1, image!.id).boundingBox())!;
  const handle = frame(page).locator('[data-handle="se"]');
  await drag(page, await center(handle), 60, 5);
  const after = (await objectEl(page, 1, image!.id).boundingBox())!;
  expect(after.width - before.width).toBeCloseTo(60, -0.5);
  expect(after.width / after.height).toBeCloseTo(before.width / before.height, 1);
  const resized = (await objectsOf(page, 1))[0]!;
  expect(styleProp(resized, 'width')).toMatch(/px$/);
  expect(styleProp(resized, 'height')).toMatch(/px$/);

  // 6. A text object, edited in place.
  await blockMenu(page, 'Add text object');
  await expect.poll(async () => (await objectsOf(page, 1)).length).toBe(2);
  const text = (await objectsOf(page, 1))[1]!;
  const textEl = objectEl(page, 1, text.id);
  await expect(textEl).toBeFocused(); // editing right away, its text selected
  await page.keyboard.type('The Wandering Inn');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await objectsOf(page, 1))[1]?.text).toBe('The Wandering Inn');
  await expect(frame(page)).toBeFocused();

  // Move the title with the keyboard.
  const t0 = (await objectsOf(page, 1))[1]!;
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('ArrowRight');
  const t1 = (await objectsOf(page, 1))[1]!;
  expect(px(styleProp(t1, 'top'))).toBe(px(styleProp(t0, 'top')) + 10);
  expect(px(styleProp(t1, 'left'))).toBe(px(styleProp(t0, 'left')) + 1);

  // The page is a cover with both objects; page 1 was never touched.
  expect(await markersOf(page, 1)).toEqual(['frontCover']);
  expect(await markersOf(page, 0)).toEqual([]);
  expect(await objectsOf(page, 0)).toEqual([]);
  await expect(pageEl(page, 1).locator('> [data-object-id]')).toHaveCount(2);
  // No inspector on this page.
  await expect(page.getByRole('complementary', { name: /inspector/i })).toHaveCount(0);
});

test.describe('on a page with objects', () => {
  test.beforeEach(async ({ page }) => {
    await openObjects(page, { doc: 'objects' });
  });

  const ids = async (page: Page) => (await objectsOf(page, 0)).map((o) => o.id);

  test('click selects; drag moves in one undo step; pagination moves nothing', { tag: '@smoke' }, async ({ page }) => {
    const texts = await pageTexts(page);
    await clickObject(page, 0, 'img1');
    await expect.poll(() => selected(page)).toEqual({ pagePos: 0, id: 'img1' });
    await expect(frame(page)).toBeFocused();
    await expect(frame(page)).toHaveAttribute('aria-label', /Image object/);
    await frameMatchesObject(page, 0, 'img1');

    await drag(page, await center(frame(page)), -40, 60);
    const [img] = await objectsOf(page, 0);
    expect(px(styleProp(img, 'left'))).toBeCloseTo(60, -0.5);
    expect(px(styleProp(img, 'top'))).toBeCloseTo(660, -0.5);
    await frameMatchesObject(page, 0, 'img1');
    await settle(page);
    expect(await pageTexts(page)).toEqual(texts);

    await undo(page);
    expect(styleProp((await objectsOf(page, 0))[0], 'left')).toBe('100px');
    expect(styleProp((await objectsOf(page, 0))[0], 'top')).toBe('600px');
  });

  test('a click without movement changes nothing; a click in the text deselects', async ({ page }) => {
    const before = await objectsOf(page, 0);
    await clickObject(page, 0, 'img1');
    await frame(page).click();
    expect(await objectsOf(page, 0)).toEqual(before);
    expect(await undo(page)).toBe(false);
    await page.locator('.hb-canvas .page p').first().click();
    await expect.poll(() => selected(page)).toBeNull();
    await expect(frame(page)).toBeHidden();
  });

  test('an object behind the text is selected with Alt+click, not with a plain click', async ({ page }) => {
    await clickObject(page, 0, 'behind');
    expect(await selected(page)).toBeNull();
    await clickObject(page, 0, 'behind', ['Alt']);
    await expect.poll(() => selected(page)).toEqual({ pagePos: 0, id: 'behind' });
    await frameMatchesObject(page, 0, 'behind');
  });

  test('at 200% zoom the pointer delta is divided by the zoom', async ({ page }) => {
    await page.getByTestId('zoom-select').selectOption('2');
    await expect(page.locator('.hb-canvas[data-zoom="2"]')).toHaveCount(1);
    await settle(page);
    await objectEl(page, 0, 'img1').scrollIntoViewIfNeeded();
    await clickObject(page, 0, 'img1');
    await frameMatchesObject(page, 0, 'img1');
    await drag(page, await center(frame(page)), 100, 50);
    const [img] = await objectsOf(page, 0);
    expect(px(styleProp(img, 'left'))).toBeCloseTo(150, -0.5);
    expect(px(styleProp(img, 'top'))).toBeCloseTo(625, -0.5);
    await frameMatchesObject(page, 0, 'img1');
  });

  test('keyboard: nudge, resize, z-order and delete, one undo step each', async ({ page }) => {
    await clickObject(page, 0, 'img1');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowUp');
    let [img] = await objectsOf(page, 0);
    expect(styleProp(img, 'left')).toBe('102px');
    expect(styleProp(img, 'top')).toBe('590px');
    await expect(page.getByTestId('object-status')).toHaveText(/Moved to left 102, top 590/);

    const w0 = (await objectEl(page, 0, 'img1').boundingBox())!.width;
    await page.keyboard.press('Control+ArrowRight');
    expect((await objectEl(page, 0, 'img1').boundingBox())!.width).toBeCloseTo(w0 + 1, 0);

    // z-order: img1 is first (the back); Ctrl+] brings it forward.
    expect(await ids(page)).toEqual(['img1', 'txt1', 'behind']);
    await page.keyboard.press('Control+BracketRight');
    expect(await ids(page)).toEqual(['txt1', 'img1', 'behind']);
    await expect(frame(page)).toBeFocused();

    await page.keyboard.press('Delete');
    expect(await ids(page)).toEqual(['txt1', 'behind']);
    expect(await selected(page)).toBeNull();

    // Six actions, six undo steps back to the start.
    for (let i = 0; i < 6; i++) await undo(page);
    [img] = await objectsOf(page, 0);
    expect(img).toMatchObject({ id: 'img1', style: 'position: absolute; left: 100px; top: 600px; width: 200px;' });
    expect(await undo(page)).toBe(false);
  });

  test.describe('in a wide window', () => {
    test.use({ viewport: { width: 2200, height: 1000 } });

    test('an object dragged past the page edge keeps a strip on the page and can be clicked again (UI-9)', async ({ page }) => {
      const pageWidth = await pageEl(page, 0).evaluate((el) => el.clientWidth);
      await clickObject(page, 0, 'img1');
      await drag(page, await center(frame(page)), 1000, 0, 16);
      let [img] = await objectsOf(page, 0);
      expect(px(styleProp(img, 'left'))).toBeLessThanOrEqual(pageWidth - 16);
      expect(px(styleProp(img, 'left'))).toBeGreaterThan(pageWidth - 40);
      await expect(page.getByTestId('object-status')).toHaveText(/Kept on the page/);
      // The keyboard can't push it further either.
      await expect(frame(page)).toBeFocused();
      await page.keyboard.press('ArrowRight');
      [img] = await objectsOf(page, 0);
      expect(px(styleProp(img, 'left'))).toBeLessThanOrEqual(pageWidth - 16);

      // Back to the text, then a click on the visible strip selects it again.
      await page.keyboard.press('Escape');
      await expect.poll(() => selected(page)).toBeNull();
      const pageBox = (await pageEl(page, 0).boundingBox())!;
      const imgBox = (await objectEl(page, 0, 'img1').boundingBox())!;
      await page.mouse.click(pageBox.x + pageBox.width - 6, imgBox.y + imgBox.height / 2);
      await expect.poll(() => selected(page)).toEqual({ pagePos: 0, id: 'img1' });
    });
  });

  test('the object toolbar is one tab stop with arrow keys; Escape goes back to the frame, then the text', async ({ page }) => {
    await clickObject(page, 0, 'img1'); // first object: "Send backward" is disabled
    await page.keyboard.press('Tab');
    const toolbar = objectToolbar(page);
    await expect(toolbar.getByRole('button', { name: 'Bring forward' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(toolbar.getByRole('button', { name: 'Put back in text' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    expect(await ids(page)).toEqual(['txt1', 'img1', 'behind']);
    await page.keyboard.press('Escape');
    await expect(frame(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect.poll(() => selected(page)).toBeNull();
    await expect(frame(page)).toBeHidden();
  });

  test('double-click edits a text object in place; Escape cancels, Enter commits', async ({ page }) => {
    await clickObject(page, 0, 'txt1');
    await frame(page).dblclick();
    const el = objectEl(page, 0, 'txt1');
    await expect(el).toBeFocused();
    await page.keyboard.type('Nope');
    await page.keyboard.press('Escape');
    await expect(el).toHaveText('A text object');
    expect((await objectsOf(page, 0))[1]!.text).toBe('A text object');
    await expect(frame(page)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(el).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' (edited)');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await objectsOf(page, 0))[1]!.text).toBe('A text object (edited)');
    // The document text (the flow) never saw the typing.
    expect((await pageTexts(page)).join('')).not.toContain('edited');
    await undo(page);
    expect((await objectsOf(page, 0))[1]!.text).toBe('A text object');
  });

  test("'Put back in text' and 'Place freely' convert between an object and an inline image", async ({ page }) => {
    await clickObject(page, 0, 'img1');
    await objectToolbar(page).getByRole('button', { name: 'Put back in text' }).click();
    expect(await ids(page)).toEqual(['txt1', 'behind']);
    const inline = pageEl(page, 0).locator('.columnWrapper img:not(.ProseMirror-separator)');
    await expect(inline).toHaveCount(1);
    await expect(inline).toHaveAttribute('style', /width: 200px/);
    // The inline image is node-selected: place it freely again.
    await blockMenu(page, 'Place freely (on the page)');
    await expect(inline).toHaveCount(0);
    const objects = await objectsOf(page, 0);
    expect(objects).toHaveLength(3);
    expect(objects[2]).toMatchObject({ kind: 'image', src: expect.stringContaining('data:image/svg+xml') });
    await expect(frame(page)).toBeFocused();
    // One undo step each way.
    await undo(page);
    await expect(inline).toHaveCount(1);
    await undo(page);
    expect(await ids(page)).toEqual(['img1', 'txt1', 'behind']);
  });

  test('objects are reachable from the block menu (also those behind the text)', async ({ page }) => {
    await caretAfter(page, 'Travelers');
    await blockMenu(page, /^Select Text/);
    await expect.poll(() => selected(page)).toEqual({ pagePos: 0, id: 'txt1' });
    await expect(frame(page)).toBeFocused();
    await blockMenu(page, 'Send backward');
    expect(await ids(page)).toEqual(['txt1', 'img1', 'behind']);
    await expect(frame(page)).toBeFocused();
    await blockMenu(page, 'Select Image 2');
    await expect.poll(() => selected(page)).toEqual({ pagePos: 0, id: 'behind' });
  });
});
