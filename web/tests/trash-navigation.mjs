import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// A row and a child document both ask "where does deleting leave me?".
// A board card opens in the side peek now, so the trashing happens from the
// peek's own menu; the board underneath stays where it was.
await withFixture(async ({ page, api, base, workspace, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').at(-1);
  const unrelated = await api('POST', '/api/pages', { title: 'Unrelated page', workspaceId: workspace.id });
  await page.goto(`${base}/p/${unrelated.id}`);
  await page.goto(`${base}/p/${collectionId}`);
  await page.locator('.view-tab', { hasText: 'Board' }).click();
  const card = page.locator('.board-card', { hasText: 'First row' });
  const rowId = await card.getAttribute('data-row');
  assert(rowId, 'the card carries its row id');

  await card.click();
  await page.locator('.peek-panel').waitFor();
  assert.equal(new URL(page.url()).pathname.endsWith(collectionId), true, 'the peek does not leave the board');
  await page.locator('.peek-panel .topbar button[title="More"]').click();
  await eventually(async () => (await page.locator('.overflow-menu').count()) === 1);
  await page.locator('.overflow-menu').getByRole('button', { name: 'Move to trash', exact: true }).click();
  await eventually(async () => (await page.locator('.peek-panel').count()) === 0);
  assert.equal((await api('GET', `/api/pages/${rowId}`)).trashed, true);
  assert.equal(new URL(page.url()).pathname.endsWith(collectionId), true, 'the board is still open');
  assert.equal(await page.locator('.board').count(), 1);
  assert.equal(await page.locator('.tab-bar .tab', { hasText: 'First row' }).count(), 0);

  const parent = await api('POST', '/api/pages', { title: 'Parent document', workspaceId: workspace.id });
  const child = await api('POST', '/api/pages', { title: 'Child document', parentId: parent.id });
  await page.goto(`${base}/p/${child.id}`);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await eventually(async () => new URL(page.url()).pathname.endsWith(parent.id));
  console.log('Trash navigation: a row leaves from the peek and the board stays; a child document returns to its parent.');
});
