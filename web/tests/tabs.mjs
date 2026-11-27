import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// One server for two tab stories: a row's tab survives the switch back to its
// collection (the row is not in the page list), and the strip's own bookkeeping
// — pin, move, bulk close — keeps working. They ran as separate files, and each
// file pays for a server and a browser.
await withFixture(async ({ page, api, base, workspace, path }) => {
  page.setDefaultTimeout(15000);

  // --- a row's tab lives past the switch back ------------------------------
  {
    const tabs = page.locator('.tab-bar .tab');
    const firstRow = page.locator('.board-card', { hasText: 'First row' });
    const boardTab = page.locator('.view-tab', { hasText: 'Board' });

    await boardTab.click();
    await firstRow.waitFor();
    // One page needs no strip.
    assert.equal(await tabs.count(), 0);

    // ⌘-click a card: a second tab, titled with the row.
    await firstRow.click({ modifiers: ['Meta'] });
    await eventually(async () => (await tabs.count()) === 2);
    await eventually(async () => (await tabs.filter({ hasText: 'First row' }).count()) === 1);

    // Back to the collection: the row's tab stays. Dropping it here is the bug
    // — the row is not in the page list, and the tab strip must keep it anyway.
    // (The collection remounts on its first view, so the board has to be picked
    // again; that is beside the point of the assertion.)
    await tabs.filter({ hasText: 'Option editing test' }).click();
    await boardTab.waitFor();
    assert.equal(await tabs.count(), 2);
    assert.equal(await tabs.filter({ hasText: 'First row' }).count(), 1);

    // The card's ⋯ menu carries the visible entry, the way the sidebar's does.
    await boardTab.click();
    await firstRow.waitFor();
    // The card's own ⋯ opens that menu; a right-click on the card does not.
    await firstRow.locator('.card-move-btn').click();
    await page.getByRole('button', { name: 'Open in new tab', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.card-move-menu').waitFor({ state: 'detached' }).catch(() => {});

    // An ordinary click opens the row in the side peek and leaves the tabs
    // alone: since the row preview landed, a card is no longer a navigation.
    await page.locator('.board-card', { hasText: 'Second row' }).click();
    await page.locator('.peek-panel').waitFor();
    assert.equal(await tabs.count(), 2);
  }

  // --- pin, move, bulk close ------------------------------------------------
  // Start the second story from a clean strip over the same collection: the
  // tabs above are this fixture's, not the ones this part is about.
  await page.evaluate(() => {
    localStorage.removeItem('salt-tabs');
    localStorage.removeItem('salt-pinned-tabs');
  });
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

  // Pin Beta from the tab's own menu: it shows the pin and keeps its place.
  await tabMenu('Tab Beta', 'Pin tab');
  await eventually(async () => (await page.locator('.tab-bar .tab.pinned').count()) === 1);
  assert.deepEqual(await tabTitles(), ['Tab Alpha', 'Tab Beta', 'Tab Gamma']);

  // Pins and order survive a reload.
  await page.reload();
  await eventually(async () => (await tabs.count()) === 3);
  assert.deepEqual(await tabTitles(), ['Tab Alpha', 'Tab Beta', 'Tab Gamma']);
  assert.equal(await page.locator('.tab-bar .tab.pinned').count(), 1);

  // Move Gamma left with the keyboard: past the pin too — a pin is a mark,
  // not a block that other tabs cannot cross.
  await tabs.filter({ hasText: 'Tab Gamma' }).click();
  await page.keyboard.press('Control+Alt+Shift+ArrowLeft');
  await eventually(async () => (await tabTitles()).join('|') === 'Tab Alpha|Tab Gamma|Tab Beta');
  await page.keyboard.press('Control+Alt+Shift+ArrowLeft');
  await eventually(async () => (await tabTitles()).join('|') === 'Tab Gamma|Tab Alpha|Tab Beta');

  // Close others from Gamma: the pin survives beside it, in strip order.
  await tabMenu('Tab Gamma', 'Close other tabs');
  await eventually(async () => (await tabs.count()) === 2);
  assert.deepEqual(await tabTitles(), ['Tab Gamma', 'Tab Beta']);

  // Close to the right drops what follows and keeps the pin and the tab.
  await openInNewTab('Tab Alpha');
  await eventually(async () => (await tabs.count()) === 3);
  assert.deepEqual(await tabTitles(), ['Tab Gamma', 'Tab Alpha', 'Tab Beta']);
  await tabMenu('Tab Gamma', 'Close tabs to the right');
  await eventually(async () => (await tabs.count()) === 2);
  assert.deepEqual(await tabTitles(), ['Tab Gamma', 'Tab Beta']);

  // Workspace switching: the other side opens after the current tab, and
  // coming back focuses the tab you were on without touching the order.
  const ws2 = await api('POST', '/api/workspaces', { name: 'Second space' });
  await mk('Tab Delta', ws2.id);
  await page.reload(); // let the new workspace and page arrive
  await eventually(async () => (await tabs.count()) === 2);
  await page.locator('.ws-btn').click();
  await page.locator('.ws-menu-item', { hasText: 'Second space' }).click();
  await eventually(async () => (await tabs.count()) === 3);
  assert.deepEqual(await tabTitles(), ['Tab Gamma', 'Tab Delta', 'Tab Beta']);
  await page.locator('.ws-btn').click();
  await page.locator('.ws-menu-item', { hasText: workspace.name }).click();
  await eventually(async () => ((await tabs.filter({ hasText: 'Tab Gamma' }).getAttribute('class')) ?? '').includes('active'));
  assert.deepEqual(await tabTitles(), ['Tab Gamma', 'Tab Delta', 'Tab Beta']);

  // Drag Delta onto Gamma: it lands before it, across the strip, while the
  // pinned Beta stays at the end.
  await page.dragAndDrop('.tab-bar .tab >> nth=1', '.tab-bar .tab >> nth=0');
  await eventually(async () => (await tabTitles()).join('|') === 'Tab Delta|Tab Gamma|Tab Beta');

  console.log('Tabs: a row keeps its tab, and pins move, persist and survive bulk closes.');
});
