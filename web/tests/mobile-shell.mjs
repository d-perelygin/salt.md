import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// The phone shell, at 390×844 with touch.
//
// Below 769px three things change that the desktop tests cannot see: the tab
// strip is replaced by a dock of four destinations, the page menus come up as
// sheets instead of hanging off a corner, and search takes the whole screen.
// All three are CSS-and-DOM only — the same components render on both sides of
// the breakpoint — so the last section checks that the desktop did not move.
await withFixture(async ({ page, context, api, base, workspace }) => {
  page.setDefaultTimeout(15000);

  const docA = await api('POST', '/api/pages', { title: 'Phone A', type: 'doc', workspaceId: workspace.id });
  const docB = await api('POST', '/api/pages', { title: 'Phone B', type: 'doc', workspaceId: workspace.id });

  const phone = await context.browser().newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'en-US',
    // The account the fixture just made, and the session it established.
    storageState: await context.storageState(),
  });
  const p = await phone.newPage();
  p.setDefaultTimeout(15000);
  await p.goto(`${base}/p/${docA.id}`);
  await eventually(async () => (await p.locator('.mobile-dock').count()) === 1);

  // --- the dock -------------------------------------------------------------
  // Four destinations, in the order the thumb expects them: the drawer first,
  // where writing starts, then the open documents, search and the AI.
  const slots = p.locator('.mobile-dock .dock-btn');
  assert.equal(await slots.count(), 4);
  // By accessible name, not by text: the tabs slot also draws its count.
  assert.deepEqual(
    await slots.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label'))),
    ['Menu', 'Tabs', 'Search', 'AI'],
  );
  for (let i = 0; i < 4; i++) {
    const box = await slots.nth(i).boundingBox();
    assert(box && box.height >= 44, `dock slot ${i} is a thumb-sized target`);
    assert(box.y > 844 * 0.9, `dock slot ${i} sits at the bottom of the screen`);
  }

  // The strip it replaced is gone, not merely scrolled away.
  assert.equal(await p.locator('.tab-bar').isVisible(), false);
  // And the floating AI button, which was the second bottom-right corner.
  assert.equal(await p.locator('.ai-fab').isVisible(), false);

  // --- the tabs sheet -------------------------------------------------------
  await slots.nth(1).click();
  await eventually(async () => (await p.locator('.tabs-sheet').count()) === 1);

  // Swipe down on the handle: a short pull springs back, a long one closes.
  const grab = await p.locator('.tabs-sheet .sheet-grab').boundingBox();
  const dragTo = async (dy) => {
    await p.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
    await p.mouse.down();
    await p.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2 + dy, { steps: 12 });
    await p.mouse.up();
    await p.waitForTimeout(320);
  };
  await dragTo(40);
  assert.equal(await p.locator('.tabs-sheet').count(), 1, 'a short pull springs back');
  await dragTo(280);
  await eventually(async () => (await p.locator('.tabs-sheet').count()) === 0, 3000);
  // Reopen for the assertions below.
  await slots.nth(1).click();
  await eventually(async () => (await p.locator('.tabs-sheet').count()) === 1);
  assert.equal(await p.locator('.tabs-sheet-arrow').count(), 2);
  // Nothing was navigated yet, so there is nowhere to go back to.
  assert.equal(await p.locator('.tabs-sheet-arrow').first().isDisabled(), true);
  assert.equal(await p.locator('.tabs-sheet-card.active').count(), 1);
  await p.locator('.tabs-sheet-dismiss').click();
  await eventually(async () => (await p.locator('.tabs-sheet').count()) === 0);

  // --- back, from a sheet, in an app with no browser chrome -----------------
  await slots.nth(0).click();
  await eventually(async () => (await p.locator('.sidebar.open').count()) === 1);
  await p.getByText('Phone B', { exact: true }).click();
  await eventually(async () => p.url().includes(docB.id));
  await slots.nth(1).click();
  await eventually(async () => !(await p.locator('.tabs-sheet-arrow').first().isDisabled()));
  await p.locator('.tabs-sheet-arrow').first().click();
  await eventually(async () => p.url().includes(docA.id));
  await p.locator('.tabs-sheet-dismiss').click();

  // --- "New page" in the sheet opens a tab, does not replace one -----------
  // Reported from use: asking for a new page FROM the list of open documents
  // means "and show me it", not "and throw away what I am reading".
  await slots.nth(1).click();
  await eventually(async () => (await p.locator('.tabs-sheet-card').count()) > 0);
  const before = await p.locator('.tabs-sheet-card:not(.tabs-sheet-new)').count();
  await p.locator('.tabs-sheet-new').click();
  await eventually(async () => (await p.locator('.tabs-sheet').count()) === 0);
  await eventually(async () => !p.url().includes(docA.id));
  await slots.nth(1).click();
  await eventually(
    async () => (await p.locator('.tabs-sheet-card:not(.tabs-sheet-new)').count()) === before + 1,
  );
  await p.locator('.tabs-sheet-dismiss').click();

  // --- every menu is a thumb-sized menu ------------------------------------
  // Reported from a real phone: the tree row's ⋯ menu was 184px wide with
  // 13px rows. It is the same .menu component in a dozen places, so the
  // measurement is what keeps all of them honest.
  await slots.nth(0).click();
  await eventually(async () => (await p.locator('.sidebar.open').count()) === 1);
  await p.locator('.tree-item', { hasText: 'Phone A' }).first().hover();
  const rowActions = p.locator('.tree-item', { hasText: 'Phone A' }).first().locator('.tree-actions button').last();
  await rowActions.click();
  await eventually(async () => (await p.locator('.tree-actions .menu').count()) === 1);
  const menuBox = await p.locator('.tree-actions .menu').first().boundingBox();
  assert(menuBox && menuBox.width >= 232, 'a phone menu is wide enough for its longest row');
  const rowBox = await p.locator('.tree-actions .menu button').first().boundingBox();
  assert(rowBox && rowBox.height >= 44, 'a phone menu row is a thumb-sized target');
  await p.keyboard.press('Escape');
  await eventually(async () => (await p.locator('.tree-actions .menu').count()) === 0);
  // The drawer covers the left two thirds of the screen, so the tap that closes
  // it has to be on the part of the backdrop its own edges leave free.
  await p.locator('.sidebar-backdrop').click({ position: { x: 370, y: 400 } });
  await eventually(async () => (await p.locator('.sidebar.open').count()) === 0);

  // --- search fills the screen ---------------------------------------------
  await slots.nth(2).click();
  await eventually(async () => (await p.locator('.search-modal').count()) === 1);
  const search = await p.locator('.search-modal').boundingBox();
  assert(search && search.height >= 300, 'search is a sheet, not a dialog');
  assert(search.y > 844 * 0.12, 'the search sheet starts below the top edge');
  const field = await p.locator('.search-input').boundingBox();
  assert(field && field.y > 844 * 0.12, 'the field sits where a thumb can reach it');
  assert.equal(await p.locator('.search-cancel').isVisible(), true);
  // ⌘⇧N printed beside a command is a promise the device cannot keep.
  if (await p.locator('.search-modal .result-keys').count()) {
    assert.equal(await p.locator('.search-modal .result-keys').first().isVisible(), false);
  }
  await p.locator('.search-cancel').click();
  await eventually(async () => (await p.locator('.search-modal').count()) === 0);

  // --- page menus are sheets at the bottom ---------------------------------
  await p.locator('.topbar button[title="More"]').click();
  await eventually(async () => (await p.locator('.overflow-menu').count()) === 1);
  const menu = await p.locator('.overflow-menu').boundingBox();
  assert(menu && menu.y > 844 * 0.2, 'the page menu opens as a sheet, not in the corner');
  assert(menu.width >= 380, 'the sheet spans the screen');
  // The veil that keeps the first tap from landing on the page underneath.
  assert.equal(await p.locator('.sheet-backdrop').count(), 1);
  // The separators that group the menu survived the move to a taller sheet.
  const sep = p.locator('.overflow-menu .menu-sep').first();
  if (await sep.count()) assert((await sep.boundingBox()).height >= 1);
  await p.locator('.sheet-backdrop').click({ position: { x: 195, y: 60 } });
  await eventually(async () => (await p.locator('.overflow-menu').count()) === 0);

  // --- the desktop is untouched --------------------------------------------
  await page.goto(`${base}/p/${docA.id}`);
  await eventually(async () => (await page.locator('.topbar').count()) === 1);
  assert.equal(await page.locator('.mobile-dock').isVisible(), false);
  assert.equal(await page.locator('.tab-bar').isVisible(), true);
  assert.equal(await page.locator('.ai-fab').isVisible(), true);
  await page.locator('.topbar button[title="More"]').click();
  await eventually(async () => (await page.locator('.overflow-menu').count()) === 1);
  const wideMenu = await page.locator('.overflow-menu').boundingBox();
  assert(wideMenu && wideMenu.y < 200, 'on a desktop the menu still hangs off its button');
  // Rendered but not shown: the veil is the phone's grammar only.
  assert.equal(await page.locator('.sheet-backdrop').isVisible(), false);

  await phone.close();
});
