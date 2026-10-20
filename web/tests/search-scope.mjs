import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Cmd+K scope: with an empty query, ←/→ picks the search scope, one
// workspace at a time (Everywhere, then workspaces by name, wrapping).
// The fixture collection row 'First row' lives in the first workspace, so
// scoping to the second one hides it.
await withFixture(async ({ page, api, base, workspace, path }) => {
  page.setDefaultTimeout(15000);
  await api('POST', '/api/workspaces', { name: 'Second Space' });
  const firstName = (await api('GET', '/api/workspaces')).find((w) => w.id === workspace.id).name;

  await page.goto(`${base}/p/${path.split('/').pop()}`);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press('Control+k');
  const scopes = page.locator('.search-scopes');
  await scopes.waitFor();
  const onSingle = () => scopes.locator('.search-scope.is-on').allTextContents();

  // Initially scoped to the current workspace alone.
  assert.deepEqual(await onSingle(), [firstName]);

  // → from the last chip wraps to Everywhere: the row is found.
  await page.keyboard.press('ArrowRight');
  await eventually(async () => (await onSingle()).join() === 'Everywhere');
  await page.keyboard.type('First row');
  await eventually(async () => (await page.locator('.search-result', { hasText: 'First row' }).count()) >= 1);

  // Clear the query — arrows only steer on empty input — and step to the
  // second workspace: the row disappears.
  await page.locator('.search-input').fill('');
  await page.keyboard.press('ArrowRight');
  await eventually(async () => (await onSingle()).join() === 'Second Space');
  await page.keyboard.type('First row');
  await eventually(async () => (await page.locator('.search-empty').count()) === 1);

  // ← steps back to Everywhere.
  await page.locator('.search-input').fill('');
  await page.keyboard.press('ArrowLeft');
  await eventually(async () => (await onSingle()).join() === 'Everywhere');

  console.log('Cmd+K: empty-query ←/→ picks the search scope one workspace at a time.');
});
