import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Peek and pins around tabs:
// 1. "Open in a new tab" from the peek closes the peek itself — the panel
//    was opened to glance, and the tab takes over.
// 2. Opening a link while a tab is pinned never navigates the pin in place:
//    a new tab opens right after it (covers the inline-mention path, which
//    navigates outside navigate()).
await withFixture(async ({ page, api, base, workspace, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();
  const mk = (title) => api('POST', '/api/pages', { title, workspaceId: workspace.id });
  const alpha = await mk('Tab Alpha');
  const beta = await mk('Tab Beta');
  const tabs = page.locator('.tab-bar .tab');
  const tabTitles = () => tabs.locator('.tab-title').allTextContents();

  // --- 1. peek closes when its page moves to a tab ---
  await page.goto(`${base}/p/${collectionId}`);
  const rows = await api('GET', `/api/collections/${collectionId}/rows?limit=100`);
  const firstId = rows.rows.find((r) => r.title === 'First row').id;
  await page.evaluate(
    (id) => window.dispatchEvent(new CustomEvent('salt:peek', { detail: { id }, cancelable: true })),
    firstId,
  );
  await page.locator('.peek-panel').waitFor();
  await page.locator('.peek-open-wrap').hover();
  await page.locator('.peek-open-menu').waitFor();
  await page.getByRole('button', { name: 'Open in a new tab', exact: true }).click();
  await eventually(async () => (await page.locator('.peek-panel').count()) === 0);
  await eventually(async () => (await tabTitles()).includes('First row'));
  assert.equal(await page.locator('.tab-bar .tab.active .tab-title').innerText(), 'First row');

  // --- 2. pinned tab survives a link opened from content ---
  await page.goto(`${base}/p/${beta.id}`);
  await tabs.filter({ hasText: 'Tab Beta' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Pin tab', exact: true }).click();
  await eventually(async () => (await page.locator('.tab-bar .tab.pinned').count()) === 1);
  await tabs.filter({ hasText: 'Tab Beta' }).click();
  await page.evaluate(
    (id) => window.dispatchEvent(new CustomEvent('salt:navigate', { detail: { id } })),
    alpha.id,
  );
  await eventually(async () => (await tabTitles()).includes('Tab Alpha'));
  {
    const titles = await tabTitles();
    assert.equal(titles[titles.indexOf('Tab Beta') + 1], 'Tab Alpha');
  }
  assert.equal(await page.locator('.tab-bar .tab.pinned .tab-title').innerText(), 'Tab Beta');
  assert.equal(await page.locator('.tab-bar .tab.active .tab-title').innerText(), 'Tab Alpha');
});
