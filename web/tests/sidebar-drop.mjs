import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Sidebar tree drag and drop: the insertion point is a slim caret between
// rows, never an outline painted on a row's own edge.
await withFixture(async ({ page, api, base, workspace, path }) => {
  page.setDefaultTimeout(15000);

  const collectionId = path.split('/').pop();
  const mk = (title) => api('POST', '/api/pages', { title, workspaceId: workspace.id });
  await mk('Drop AAA');
  await mk('Drop BBB');
  await page.goto(`${base}/p/${collectionId}`);

  const rowA = page.locator('.tree-item', { hasText: 'Drop AAA' });
  const rowB = page.locator('.tree-item', { hasText: 'Drop BBB' });
  await rowA.waitFor();
  await rowB.waitFor();

  // Carry BBB onto the top of AAA: a caret line appears in the gap, and the
  // drop lands BBB before AAA.
  const src = await rowB.boundingBox();
  const dst = await rowA.boundingBox();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height * 0.12, { steps: 12 });
  await eventually(async () => (await page.locator('.tree-drop-line').count()) === 1);
  await page.mouse.up();

  const order = async () => page.locator('.tree-item .tree-title').allTextContents();
  await eventually(async () => {
    const titles = await order();
    return titles.indexOf('Drop BBB') !== -1 && titles.indexOf('Drop BBB') < titles.indexOf('Drop AAA');
  });
  // No row keeps an edge highlight after the drop.
  assert.equal(await page.locator('.tree-item.drop-inside, .tree-item.drop-before, .tree-item.drop-after').count(), 0);
});
