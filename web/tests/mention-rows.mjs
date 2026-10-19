import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Linking to collection rows: the @/[[ picker completes rows (with their
// collection as subtext), and Cmd+K annotates every hit with its workspace
// and, for rows, its collection. Rows never enter the client page list, so
// the picker takes them from the server search.
await withFixture(async ({ page, api, base, workspace, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();
  const wsName = (await api('GET', '/api/workspaces')).find((w) => w.id === workspace.id).name;
  const doc = await api('POST', '/api/pages', { title: 'Mention Doc', workspaceId: workspace.id });

  // --- 1. @ completes a row, names its collection, inserts a durable link ---
  await page.goto(`${base}/p/${doc.id}`);
  await page.locator('.bn-inline-content').first().click();
  await page.keyboard.type('@First');
  const menu = page.locator('.bn-suggestion-menu');
  await menu.waitFor();
  const rowItem = menu.locator('.bn-suggestion-menu-item', { hasText: 'First row' });
  await eventually(async () => (await rowItem.count()) === 1);
  assert.match(await rowItem.innerText(), /in Option editing test/);
  await rowItem.click();
  const chip = page.locator('.page-link', { hasText: 'First row' });
  await eventually(async () => (await chip.count()) === 1);
  // The link survives a reload: it stores the row id, not a name.
  await page.reload();
  await eventually(async () => (await page.locator('.page-link', { hasText: 'First row' }).count()) === 1);

  // --- 2. Cmd+K annotates workspace and collection ---
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press('Control+k');
  const palette = page.locator('.search-results');
  await palette.waitFor();
  await page.keyboard.type('First row');
  const hit = palette.locator('.search-result', { hasText: 'First row' }).first();
  await eventually(async () => (await hit.count()) === 1);
  const context = await hit.locator('.result-context').innerText();
  assert.match(context, new RegExp(wsName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(context, /Option editing test/);

  console.log('Mentions complete collection rows; Cmd+K annotates workspace and collection.');
});
