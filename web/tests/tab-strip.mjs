import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Document tabs: pinning, moving, bulk close, and workspace switching that
// opens the returning page after the current tab instead of replacing it.
await withFixture(async ({ page, api, base, workspace, path }) => {
  page.setDefaultTimeout(15000);

  const collectionId = path.split('/').pop();
  const tabs = page.locator('.tab-bar .tab');
  const tabTitles = () => tabs.locator('.tab-title').allTextContents();
  const mk = (title, ws) => api('POST', '/api/pages', { title, workspaceId: ws });
  const openInNewTab = async (title) => {
    await page.locator('.tree-item', { hasText: title }).click({ button: 'right' });
    await page.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  };
  const tabMenu = async (title, entry) => {
    await tabs.filter({ hasText: title }).click({ button: 'right' });
    await page.getByRole('button', { name: entry, exact: true }).click();
  };

  await mk('Tab Alpha', workspace.id);
  await mk('Tab Beta', workspace.id);
  await mk('Tab Gamma', workspace.id);

  // From the collection, open three tabs, then drop the landing tab: three
  // document tabs, each new one right after the active one.
  await page.goto(`${base}/p/${collectionId}`);
  await openInNewTab('Tab Alpha');
  await openInNewTab('Tab Beta');
  await openInNewTab('Tab Gamma');
  await eventually(async () => (await tabs.count()) === 4);
  await tabs.filter({ hasText: 'Option editing test' }).locator('.tab-close').click();
  await eventually(async () => (await tabs.count()) === 3);
  assert.deepEqual(await tabTitles(), ['Tab Alpha', 'Tab Beta', 'Tab Gamma']);

  // Pin Beta from the tab's own menu: it leads the strip and shows the pin.
  await tabMenu('Tab Beta', 'Pin tab');
  await eventually(async () => (await tabTitles()).join('|') === 'Tab Beta|Tab Alpha|Tab Gamma');
  assert.equal(await page.locator('.tab-bar .tab.pinned').count(), 1);

  // Pins and order survive a reload.
  await page.reload();
  await eventually(async () => (await tabs.count()) === 3);
  assert.deepEqual(await tabTitles(), ['Tab Beta', 'Tab Alpha', 'Tab Gamma']);
  assert.equal(await page.locator('.tab-bar .tab.pinned').count(), 1);

  // Move Gamma left with the keyboard: past Alpha, but never past the pins.
  await tabs.filter({ hasText: 'Tab Gamma' }).click();
  await page.keyboard.press('Control+Alt+Shift+ArrowLeft');
  await eventually(async () => (await tabTitles()).join('|') === 'Tab Beta|Tab Gamma|Tab Alpha');
  await page.keyboard.press('Control+Alt+Shift+ArrowLeft');
  await page.waitForTimeout(300);
  assert.deepEqual(await tabTitles(), ['Tab Beta', 'Tab Gamma', 'Tab Alpha']);

  // Close others from Gamma: the pin survives beside it.
  await tabMenu('Tab Gamma', 'Close other tabs');
  await eventually(async () => (await tabs.count()) === 2);
  assert.deepEqual(await tabTitles(), ['Tab Beta', 'Tab Gamma']);

  // Close to the right drops what follows and keeps the pin and the tab.
  await openInNewTab('Tab Alpha');
  await eventually(async () => (await tabs.count()) === 3);
  assert.deepEqual(await tabTitles(), ['Tab Beta', 'Tab Gamma', 'Tab Alpha']);
  await tabMenu('Tab Gamma', 'Close tabs to the right');
  await eventually(async () => (await tabs.count()) === 2);
  assert.deepEqual(await tabTitles(), ['Tab Beta', 'Tab Gamma']);

  // Workspace switching: the other side opens after the current tab, and
  // coming back focuses the tab you were on without touching the order.
  const ws2 = await api('POST', '/api/workspaces', { name: 'Second space' });
  await mk('Tab Delta', ws2.id);
  await page.reload(); // let the new workspace and page arrive
  await eventually(async () => (await tabs.count()) === 2);
  await page.locator('.ws-btn').click();
  await page.locator('.ws-menu-item', { hasText: 'Second space' }).click();
  await eventually(async () => (await tabs.count()) === 3);
  assert.deepEqual(await tabTitles(), ['Tab Beta', 'Tab Gamma', 'Tab Delta']);
  await page.locator('.ws-btn').click();
  await page.locator('.ws-menu-item', { hasText: workspace.name }).click();
  await eventually(async () => ((await tabs.filter({ hasText: 'Tab Gamma' }).getAttribute('class')) ?? '').includes('active'));
  assert.deepEqual(await tabTitles(), ['Tab Beta', 'Tab Gamma', 'Tab Delta']);

  // Drag Delta onto Beta: it lands right after the pin block, never inside it.
  await page.dragAndDrop('.tab-bar .tab >> nth=2', '.tab-bar .tab >> nth=0');
  await eventually(async () => (await tabTitles()).join('|') === 'Tab Beta|Tab Delta|Tab Gamma');
});
