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
  const dragTo = async (dy) => {
    // Re-measured every time: the sheet rises into place when it opens, and a
    // box taken before that lands on the cards instead of the handle.
    const now = await p.locator('.tabs-sheet .sheet-grab').boundingBox();
    const from = { x: now.x + now.width / 2, y: now.y + now.height / 2 };
    // Released inside the viewport, clear of the dock: a pointerup over the
    // dock's own tabs slot would reopen the sheet the drag just closed.
    const to = { x: from.x, y: Math.min(from.y + dy, 844 - 90) };
    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await p.mouse.move(to.x, to.y, { steps: 12 });
    // A finger pauses before letting go; without this the twelve synthetic
    // moves arrive inside one frame and the gesture is not what a person does.
    await p.waitForTimeout(80);
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

  // --- pinned tabs, and the group of unused ones ---------------------------
  // A strip with a known shape: two documents, nothing pinned, nobody has
  // looked at either of them yet.
  const openSheet = async () => {
    await slots.nth(1).click();
    await eventually(async () => (await p.locator('.tabs-sheet').count()) === 1);
  };
  const sheetCard = (title) =>
    p.locator('.tabs-sheet-card:not(.tabs-sheet-new)').filter({ hasText: title }).first();
  const setStrip = async () => {
    await p.evaluate(
      ([a, b]) => {
        localStorage.setItem('salt-tabs', JSON.stringify([a, b]));
        localStorage.setItem('salt-pinned-tabs', '[]');
        localStorage.setItem('salt-tab-used', '{}');
        localStorage.setItem('salt-tab-archive', '[]');
      },
      [docA.id, docB.id],
    );
    await p.reload();
    await eventually(async () => (await p.locator('.mobile-dock').count()) === 1);
  };
  await p.goto(`${base}/p/${docA.id}`);
  await setStrip();
  await openSheet();
  assert.equal(await p.locator('.tabs-sheet-card:not(.tabs-sheet-new)').count(), 2);

  // Every card carries the pin. Pinning marks it — the card moves to the head
  // of the strip and reports its own state for a screen reader too.
  const pinButton = (title) => sheetCard(title).locator('.tabs-sheet-card-pin');
  assert.equal(await pinButton('Phone A').getAttribute('aria-label'), 'Pin tab');
  await pinButton('Phone A').click();
  await eventually(async () => (await pinButton('Phone A').getAttribute('aria-label')) === 'Unpin tab');
  assert.equal(await sheetCard('Phone A').evaluate((el) => el.classList.contains('pinned')), true);
  await pinButton('Phone A').click();
  await eventually(async () => (await pinButton('Phone A').getAttribute('aria-label')) === 'Pin tab');
  assert.equal(await sheetCard('Phone A').evaluate((el) => el.classList.contains('pinned')), false);

  // Closing by hand is not deleting: the tab lands in "Recently closed" and
  // one tap brings it back.
  await sheetCard('Phone B').locator('.tabs-sheet-card-close').click();
  await eventually(async () => (await p.locator('.tabs-sheet-card-archive-row, .tabs-sheet-archive-row').count()) === 1);
  assert.equal(await p.locator('.tabs-sheet-archive-name').first().innerText(), 'Phone B');
  await p.locator('.tabs-sheet-archive-row').filter({ hasText: 'Phone B' }).click();
  await eventually(async () => (await p.locator('.tabs-sheet').count()) === 0);
  await openSheet();
  assert.equal(await p.locator('.tabs-sheet-card:not(.tabs-sheet-new)').count(), 2);
  assert.equal(await p.locator('.tabs-sheet-archive-row').count(), 0);

  // A week without a visit moves a tab out of the grid into the unused group.
  // A pinned tab is exempt — that is the whole reason to pin one.
  await pinButton('Phone A').click();
  await eventually(async () => (await pinButton('Phone A').getAttribute('aria-label')) === 'Unpin tab');
  // Both stamps go back a week, then the app comes back on the pinned tab:
  // reading a tab is what keeps it fresh, and the pinned one is the only tab
  // allowed to be the one the app opens on here.
  await p.evaluate(
    ([a, b]) => {
      const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
      localStorage.setItem('salt-tab-used', JSON.stringify({ [a]: old, [b]: old }));
    },
    [docA.id, docB.id],
  );
  await p.goto(`${base}/p/${docA.id}`);
  await eventually(async () => (await p.locator('.mobile-dock').count()) === 1);
  await openSheet();
  await eventually(async () => (await p.locator('.tabs-sheet-group').count()) === 1);
  assert.equal(await p.locator('.tabs-sheet-group .tabs-sheet-archive-row').count(), 1);
  assert.equal(await p.locator('.tabs-sheet-group').innerText().then((s) => s.includes('Phone B')), true);
  assert.equal(
    await p.locator('.tabs-sheet-group').innerText().then((s) => s.includes('Phone A')),
    false,
    'a pinned tab never joins the unused group',
  );
  assert.equal(await p.locator('.tabs-sheet-card:not(.tabs-sheet-new)').count(), 1);
  assert.equal(await sheetCard('Phone A').evaluate((el) => el.classList.contains('pinned')), true);

  // "Close all" empties the group into the archive beneath it.
  await p.locator('.tabs-sheet-group-close').click();
  await eventually(async () => (await p.locator('.tabs-sheet-group').count()) === 0);
  await eventually(async () => (await p.locator('.tabs-sheet-archive-row').count()) === 1);
  assert.equal(await p.locator('.tabs-sheet-archive-name').first().innerText(), 'Phone B');
  await p.locator('.tabs-sheet-dismiss').click();
  await eventually(async () => (await p.locator('.tabs-sheet').count()) === 0);

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
  // The drawer gives a long page title room for more than two words, and still
  // leaves a strip of the page to tap it shut.
  const drawer = await p.locator('.sidebar.open').boundingBox();
  assert(drawer && drawer.width > 330, `the drawer uses the width (${drawer?.width})`);
  assert(drawer.width < 390 - 24, 'a strip of the page stays tappable');
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
