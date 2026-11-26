import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// The phone shell, at 390×844 with touch.
//
// Below 769px three things change that the desktop tests cannot see: the tab
// strip is replaced by a dock of four destinations, the page menus come up as
// sheets instead of hanging off a corner, and search takes the whole screen.
// All three are CSS-and-DOM only — the same components render on both sides of
// the breakpoint — so the last section checks that the desktop did not move.
await withFixture(async ({ page, context, api, base, workspace, collection }) => {
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

  // The tabs slot answers "how many" without being opened. The count is a
  // chip of its own, hidden from the accessible name so the slot still reads
  // as "Tabs".
  const badge = slots.nth(1).locator('.dock-badge');
  assert.equal(await badge.count(), 1);
  assert.equal(await badge.getAttribute('aria-hidden'), 'true');
  assert(Number(await badge.innerText()) >= 1);

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
  // A new page focuses its title, and a focused field sends the dock away
  // (the keyboard owns that edge). Leave the field before using the dock.
  await p.evaluate(() => document.activeElement?.blur?.());
  await eventually(async () => (await p.locator('.mobile-dock').isVisible()) === true);
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

  // Drag reordering: the same moveTabTo the desktop strip uses. Drop the
  // first card on the second and the order flips in storage.
  const beforeDrag = await p.evaluate(() => JSON.parse(localStorage.getItem('salt-tabs') ?? '[]'));
  const cardA = await sheetCard('Phone A').boundingBox();
  const cardB = await sheetCard('Phone B').boundingBox();
  await p.mouse.move(cardA.x + cardA.width / 2, cardA.y + cardA.height / 2);
  await p.mouse.down();
  await p.mouse.move(cardB.x + cardB.width / 2, cardB.y + cardB.height / 2, { steps: 10 });
  await p.waitForTimeout(120);
  await p.mouse.up();
  await eventually(async () => {
    const now = await p.evaluate(() => JSON.parse(localStorage.getItem('salt-tabs') ?? '[]'));
    return now[0] === beforeDrag[1] && now[1] === beforeDrag[0];
  });

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
  // The group is a plaque above the grid and starts closed: the tabs that are
  // actually open keep the room, and the count says whether to open it.
  await eventually(async () => (await p.locator('.tabs-sheet-unused-bar').count()) === 1);
  assert.equal(await p.locator('.tabs-sheet-unused-list').count(), 0);
  assert.equal(await p.locator('.tabs-sheet-unused-count').innerText(), '1');
  const plaque = await p.locator('.tabs-sheet-unused-bar').boundingBox();
  const grid = await p.locator('.tabs-sheet-grid').boundingBox();
  assert(plaque.y + plaque.height <= grid.y, 'the unused plaque sits above the grid');
  await p.locator('.tabs-sheet-unused-toggle').click();
  await eventually(async () => (await p.locator('.tabs-sheet-unused-list .tabs-sheet-archive-row').count()) === 1);
  assert.equal(await p.locator('.tabs-sheet-unused').innerText().then((s) => s.includes('Phone B')), true);
  assert.equal(
    await p.locator('.tabs-sheet-unused').innerText().then((s) => s.includes('Phone A')),
    false,
    'a pinned tab never joins the unused group',
  );
  assert.equal(await p.locator('.tabs-sheet-card:not(.tabs-sheet-new)').count(), 1);
  assert.equal(await sheetCard('Phone A').evaluate((el) => el.classList.contains('pinned')), true);

  // "Close all" throws the unused tabs away: they were the ones nobody
  // wanted, so they do not reappear under "Recently closed".
  await p.locator('.tabs-sheet-group-close').click();
  await eventually(async () => (await p.locator('.tabs-sheet-unused').count()) === 0);
  assert.equal(await p.locator('.tabs-sheet-archive-row').count(), 0);
  assert.equal(await p.locator('.tabs-sheet-card:not(.tabs-sheet-new)').count(), 1);
  await p.locator('.tabs-sheet-dismiss').click();
  await eventually(async () => (await p.locator('.tabs-sheet').count()) === 0);

  // --- every menu is a thumb-sized menu ------------------------------------
  // Reported from a real phone: the tree row's ⋯ menu was 184px wide with
  // 13px rows. It is the same .menu component in a dozen places, so the
  // measurement is what keeps all of them honest.
  await slots.nth(0).click();
  await eventually(async () => (await p.locator('.sidebar.open').count()) === 1);
  // Thumb reach decides the drawer's two ends: the account — and every setting
  // behind it — is at the top, the workspace switcher at the bottom.
  // A row is not a native HTML5 draggable on a phone: Chrome Android starts
  // its own touch drag on a long press, and that cancels the pointer stream
  // the hold-to-carry gesture runs on.
  assert.equal(await p.locator('.tree-item').first().getAttribute('draggable'), 'false');
  assert.equal(await p.locator('.sidebar-header .user-menu').count(), 1);
  assert.equal(await p.locator('.sidebar-footer .ws-switcher').count(), 1);
  const accountBtn = await p.locator('.sidebar-header .user-menu-btn').boundingBox();
  assert(accountBtn && accountBtn.y < 80, 'the account sits at the top of the drawer');
  const wsBtn = await p.locator('.sidebar-footer .ws-btn').boundingBox();
  assert(wsBtn && wsBtn.y > 844 * 0.85, 'the workspace switcher sits under the thumb');
  await p.locator('.tree-item', { hasText: 'Phone A' }).first().hover();
  // No preview in the drawer: the card used to land under the thumb that had
  // just opened the row, covering the list. It is still on for links and
  // breadcrumbs, where it answers a question instead of blocking one.
  await p.waitForTimeout(800);
  assert.equal(await p.locator('.page-hover-card').count(), 0, 'the drawer has no hover previews');
  const rowActions = p.locator('.tree-item', { hasText: 'Phone A' }).first().locator('.tree-actions button').last();
  await rowActions.click();
  await eventually(async () => (await p.locator('.tree-actions .menu').count()) === 1);
  const menuBox = await p.locator('.tree-actions .menu').first().boundingBox();
  assert(menuBox && menuBox.width >= 232, 'a phone menu is wide enough for its longest row');
  const rowBox = await p.locator('.tree-actions .menu button').first().boundingBox();
  assert(rowBox && rowBox.height >= 44, 'a phone menu row is a thumb-sized target');
  await p.keyboard.press('Escape');
  await eventually(async () => (await p.locator('.tree-actions .menu').count()) === 0);
  // The workspace menu has no room under the footer, so it opens upward.
  await p.locator('.sidebar-footer .ws-btn').click();
  await eventually(async () => (await p.locator('.sidebar-footer .ws-menu').count()) === 1);
  const wsMenu = await p.locator('.sidebar-footer .ws-menu').boundingBox();
  assert(wsMenu && wsMenu.y + wsMenu.height <= wsBtn.y + 2, 'the workspace menu opens over the tree');
  await p.locator('.sidebar-footer .ws-btn').click();
  await eventually(async () => (await p.locator('.sidebar-footer .ws-menu').count()) === 0);
  // The theme switch left the footer for the trash; the appearance choice is
  // one row further in, behind the account.
  assert.equal(await p.locator('.sidebar-footer .theme-switch').count(), 0);
  assert.equal(await p.locator('.trash-fab').count(), 1);
  await p.locator('.trash-fab').click();
  await eventually(async () => (await p.locator('.trash-dialog').count()) === 1);
  const trashSheet = await p.locator('.trash-dialog').boundingBox();
  assert(trashSheet && trashSheet.y > 60, 'the trash opens over the page, not as a new screen');
  assert.equal(await p.locator('.trash-dialog .trash-empty').innerText(), 'The trash is empty.');
  await p.keyboard.press('Escape');
  await eventually(async () => (await p.locator('.trash-dialog').count()) === 0);
  await p.locator('.sidebar-account .user-menu-btn').click();
  await eventually(async () => (await p.locator('.user-menu-popup').count()) === 1);
  assert.equal(await p.locator('.user-menu-popup .user-menu-theme .theme-switch').count(), 1);
  await p.locator('.sidebar-account .user-menu-btn').click();
  await eventually(async () => (await p.locator('.user-menu-popup').count()) === 0);

  await p.locator('.sidebar-account .user-menu-btn').click();
  await eventually(async () => (await p.locator('.user-menu-popup').count()) === 1);
  // The account page is a page: on a phone it takes the screen and closes by
  // its own button, not a sheet that leaves a strip of the page behind.
  await p.getByRole('button', { name: 'Account page' }).click();
  await eventually(async () => (await p.locator('.person-page').count()) === 1);
  const personBox = await p.locator('.person-page').boundingBox();
  assert(personBox && personBox.width === 390, `the account page spans the phone (${personBox?.width})`);
  assert(personBox.height >= 840, `and takes its height (${personBox?.height})`);
  // The two actions are one bar: the same square each, and the label is an
  // icon on a phone.
  const editBox = await p.locator('.person-edit').boundingBox();
  const closeBox = await p.locator('.person-close').boundingBox();
  assert(
    editBox && closeBox && editBox.width === closeBox.width && editBox.height === closeBox.height,
    'the edit and close buttons are the same size',
  );
  assert.equal(await p.locator('.person-edit-label').isVisible(), false);
  await p.locator('.person-close').click();
  await eventually(async () => (await p.locator('.person-page').count()) === 0);
  // A modal opening folds the drawer away on purpose; back to it for the drag.
  await slots.nth(0).click();
  await eventually(async () => (await p.locator('.sidebar.open').count()) === 1);
  await p.waitForTimeout(320); // the drawer slides in before its rows can be hit

  // --- carrying a row with a finger ---------------------------------------
  // HTML5 drag never starts on a phone, so the same move is a hold: the row
  // lifts after ~300 ms, follows the finger and lands by the same rules the
  // mouse uses. Phone B goes onto the middle of Phone A — inside it.
  const rowA = p.locator('.tree-item', { hasText: 'Phone A' }).first();
  const rowB = p.locator('.tree-item', { hasText: 'Phone B' }).first();
  const aBox = await rowA.boundingBox();
  const bBox = await rowB.boundingBox();
  assert(aBox && bBox, 'both rows are on screen');
  const cdp = await phone.newCDPSession(p);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    });
  const from = { x: bBox.x + 40, y: bBox.y + bBox.height / 2 };
  const to = { x: aBox.x + 40, y: aBox.y + aBox.height / 2 };
  await touch('touchStart', from.x, from.y);
  await p.waitForTimeout(420);
  await touch('touchMove', from.x, from.y - 10);
  await eventually(async () => (await p.locator('.tree-drag-ghost').count()) === 1);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
    await p.waitForTimeout(30);
  }
  await eventually(async () => (await p.locator('.tree-item.drop-inside').count()) === 1);
  await touch('touchEnd');
  await eventually(async () => {
    const moved = await api('GET', `/api/pages/${docB.id}`);
    return moved.parentId === docA.id;
  });
  assert.equal(await p.locator('.tree-drag-ghost').count(), 0, 'the carried card goes away');
  assert(
    p.url().includes(docA.id) && !p.url().includes(docB.id),
    'the click that ends the drag does not open the page',
  );

  // The drawer covers the left two thirds of the screen, so the tap that closes
  // it has to be on the part of the backdrop its own edges leave free.
  // The drawer gives a long page title room for more than two words, and still
  // leaves a strip of the page to tap it shut.
  const drawer = await p.locator('.sidebar.open').boundingBox();
  assert(drawer && drawer.width > 330, `the drawer uses the width (${drawer?.width})`);
  assert(drawer.width < 390 - 24, 'a strip of the page stays tappable');
  await p.locator('.sidebar-backdrop').click({ position: { x: 370, y: 400 } });
  await eventually(async () => (await p.locator('.sidebar.open').count()) === 0);

  // --- the AI side of the drawer -------------------------------------------
  // Choosing Home or Chat ends the drawer's job: the choice is made and the
  // destination is behind it. In chats the dock offers a new chat where search
  // used to be — searching is not what one wants from inside a conversation.
  await slots.nth(0).click();
  await eventually(async () => (await p.locator('.sidebar.open').count()) === 1);
  await p.locator('.ai-side-tab', { hasText: 'Chat' }).click();
  await eventually(async () => (await p.locator('.sidebar.open').count()) === 0);
  await eventually(async () => (await p.locator('.ai-chat-root').count()) === 1);
  assert.deepEqual(
    await slots.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label'))),
    ['Menu', 'Tabs', 'New chat'],
  );

  // Typing in the composer sends the dock away; leaving the field brings it
  // back. The keyboard needs the bottom edge, and the dock is in its way.
  const composer = p.locator('.ai-composer textarea').first();
  await composer.waitFor();
  await composer.focus();
  await eventually(async () => (await p.locator('.mobile-dock').isVisible()) === false);
  await composer.blur();
  await eventually(async () => (await p.locator('.mobile-dock').isVisible()) === true);

  // The Chat side has no trash: the footer button is Archived, and it opens
  // the archived conversations in the same sheet the trash uses.
  await slots.nth(0).click();
  await eventually(async () => (await p.locator('.sidebar.open').count()) === 1);
  assert.equal(await p.locator('.trash-fab').getAttribute('title'), 'Archived');
  await p.locator('.trash-fab').click();
  await eventually(async () => (await p.locator('.trash-dialog').count()) === 1);
  assert.match(await p.locator('.trash-dialog h2').innerText(), /Archived/);
  await p.keyboard.press('Escape');
  await eventually(async () => (await p.locator('.trash-dialog').count()) === 0);

  // Back to the notes side: the drawer closes by the same rule, and the dock
  // returns to its four destinations.
  await p.locator('.ai-side-tab', { hasText: 'Home' }).click();
  await eventually(async () => (await p.locator('.sidebar.open').count()) === 0);
  await eventually(async () => (await p.locator('.mobile-dock .dock-btn').count()) === 4);

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

  // The structure panel is a sheet here too, and a sheet appears rather than
  // sliding in from the side the way the desktop rail does.
  await p.locator('.topbar button[title="More"]').click();
  await eventually(async () => (await p.locator('.overflow-menu').count()) === 1);
  await p.getByRole('button', { name: /Show structure/ }).last().click();
  await eventually(async () => (await p.locator('.structure-panel').count()) === 1);
  assert.equal(
    await p.locator('.structure-panel').evaluate((el) => getComputedStyle(el).animationName),
    'none',
    'the structure sheet appears without the desktop slide',
  );
  await p.locator('.structure-backdrop').click({ position: { x: 195, y: 60 } });
  await eventually(async () => (await p.locator('.structure-panel').count()) === 0);

  // The share dialog is a .menu hanging off topbar buttons that are hidden on
  // a phone, so its anchor is a zero-width box at the right edge: the desktop
  // 400px panel used to hang off the screen with half the form unreachable.
  await p.locator('.topbar button[title="More"]').click();
  await eventually(async () => (await p.locator('.overflow-menu').count()) === 1);
  await p.getByRole('button', { name: 'Share to web (read-only link)', exact: true }).click();
  await eventually(async () => (await p.locator('.share-dialog').count()) === 1);
  const shareBox = await p.locator('.share-dialog').boundingBox();
  assert(shareBox && shareBox.x === 0 && shareBox.width > 380, `the share dialog spans the screen (${shareBox?.width})`);
  assert.equal(
    await p.locator('.share-dialog').evaluate((el) => getComputedStyle(el).backdropFilter),
    'none',
    'no glass blur over the page',
  );
  // Its own veil, so the first tap closes the sheet instead of landing on
  // the board underneath.
  assert.equal(await p.locator('.share-backdrop').count(), 1);
  await p.locator('.share-backdrop').click({ position: { x: 200, y: 80 } });
  await eventually(async () => (await p.locator('.share-dialog').count()) === 0);

  // --- dialogs are sheets, their actions always under the thumb -------------
  await p.goto(`${base}/p/${collection.id}`);
  const propsButton = p.locator('button.btn-sm').filter({ hasText: /^\s*Properties\s*$/ });
  await eventually(async () => (await propsButton.count()) === 1);
  await propsButton.click();
  await eventually(async () => (await p.locator('.dialog.wide').count()) === 1);
  const dialogBox = await p.locator('.dialog.wide').boundingBox();
  assert(dialogBox && dialogBox.height < 844 - 60, `a dialog is a sheet, not the whole screen (${dialogBox?.height})`);
  const actions = p.locator('.dialog.wide .dialog-buttons').first();
  assert.equal(await actions.evaluate((el) => getComputedStyle(el).position), 'sticky');
  assert.equal(await actions.evaluate((el) => getComputedStyle(el).flexDirection), 'row');
  // Scrolled to the top of a long schema, the actions are still on screen.
  await p.locator('.dialog.wide').evaluate((el) => { el.scrollTop = 0; });
  await p.waitForTimeout(200);
  const actionsBox = await actions.boundingBox();
  assert(actionsBox && actionsBox.y + actionsBox.height <= 844, 'the actions bar stays pinned to the bottom');
  // Flush with the dialog's bottom edge (no strip of content underneath) and
  // sharing the width between the actions.
  assert(
    Math.abs(actionsBox.y + actionsBox.height - (dialogBox.y + dialogBox.height)) <= 1,
    'the actions bar reaches the bottom edge',
  );
  const cancelW = (await actions.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()).width;
  const saveW = (await actions.getByRole('button', { name: 'Save', exact: true }).boundingBox()).width;
  assert(Math.abs(cancelW - saveW) <= 1 && cancelW > dialogBox.width * 0.35, 'the actions share the bar');
  await actions.getByRole('button', { name: 'Cancel', exact: true }).click();
  await eventually(async () => (await p.locator('.dialog').count()) === 0);

  // --- the desktop is untouched --------------------------------------------
  await page.goto(`${base}/p/${docA.id}`);
  await eventually(async () => (await page.locator('.topbar').count()) === 1);
  assert.equal(await page.locator('.mobile-dock').isVisible(), false);
  assert.equal(await page.locator('.tab-bar').isVisible(), true);
  // The drawer keeps its desk arrangement: workspace in the header, account
  // in the footer, neither traded for the other.
  assert.equal(await page.locator('.sidebar-header .ws-switcher').count(), 1);
  assert.equal(await page.locator('.sidebar-footer .user-menu').count(), 1);
  assert.equal(await page.locator('.ai-fab').isVisible(), true);
  await page.locator('.topbar button[title="More"]').click();
  await eventually(async () => (await page.locator('.overflow-menu').count()) === 1);
  const wideMenu = await page.locator('.overflow-menu').boundingBox();
  assert(wideMenu && wideMenu.y < 200, 'on a desktop the menu still hangs off its button');
  // Rendered but not shown: the veil is the phone's grammar only.
  assert.equal(await page.locator('.sheet-backdrop').isVisible(), false);

  await phone.close();
});
