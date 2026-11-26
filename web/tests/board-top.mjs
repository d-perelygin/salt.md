import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// A board with no sort stands in manual order, and a card that lands in a
// column without being put somewhere goes on top of it: a fresh +, a drop
// onto the column, a group value picked in the card. An explicit between-cards
// drop keeps its spot. The + used to append at the bottom of the collection,
// so every new card arrived under the fold.
await withFixture(async ({ page, api, path }) => {
  page.setDefaultTimeout(15000);

  await page.locator('.view-tab', { hasText: 'Board' }).click();
  await page.locator('.board-card', { hasText: 'First row' }).waitFor();

  const titles = (col) =>
    page.locator(`.board-col[data-col=${col}] .board-card-title`).allTextContents();

  // The To do column holds First row; a + there lands above it, not below.
  await page.locator('.board-col[data-col=todo] .board-add').click();
  await page.keyboard.press('Escape');
  await eventually(async () => (await titles('todo')).length === 2);
  assert.match((await titles('todo'))[0], /Untitled/);
  assert.match((await titles('todo'))[1], /First row/);

  // The order is a position, not a render accident: the new row stands below
  // the column's old minimum, and a reload keeps it on top.
  const { rows } = await api('GET', `${path}/rows`);
  const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
  assert.ok(byTitle['Untitled'].position < byTitle['First row'].position);
  await page.reload();
  await page.locator('.view-tab', { hasText: 'Board' }).click();
  await eventually(async () => (await titles('todo')).length === 2);
  assert.match((await titles('todo'))[0], /Untitled/);

  // An empty column takes the card without anything to be above: the Third
  // column's + neither fails nor moves anything else.
  await page.locator('.board-col[data-col=third] .board-add').click();
  await page.keyboard.press('Escape');
  await eventually(async () => (await titles('third')).length === 1);
  assert.match((await titles('third'))[0], /Untitled/);
  assert.match((await titles('todo'))[0], /Untitled/);

  // "Move to the top/bottom of the column" appears only when there is an
  // order worth changing: a column of two swaps either way, and one card has
  // nowhere to go.
  const cardMenu = async () => {
    await page.locator('.board-col[data-col=todo] .card-move-btn').first().click();
    const menu = page.locator('.card-move-menu');
    await menu.waitFor();
    return {
      top: menu.getByRole('button', { name: 'Move to the top of the column', exact: true }).count(),
      bottom: menu.getByRole('button', { name: 'Move to the bottom of the column', exact: true }).count(),
    };
  };
  let order = await cardMenu();
  assert.equal(await order.top, 0, 'two cards need no top entry');
  assert.equal(await order.bottom, 0);
  await page.keyboard.press('Escape');
  await page.locator('.board-col[data-col=todo] .board-add').click();
  await page.keyboard.press('Escape');
  await eventually(async () => (await titles('todo')).length === 3);
  order = await cardMenu();
  assert.equal(await order.top, 1, 'three cards get the top entry');
  assert.equal(await order.bottom, 1);
  await page.keyboard.press('Escape');

  // The move button fades in over the card's corner; the marks (faces) slide
  // aside so the two never sit on top of each other. At rest they stay put.
  const card = page.locator('.board-card').first();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  assert.equal(
    await card.locator('.card-marks').evaluate((el) => getComputedStyle(el).transform),
    'none',
    'the marks rest in the corner',
  );
  await card.hover();
  await page.waitForTimeout(250);
  assert.notEqual(
    await card.locator('.card-marks').evaluate((el) => getComputedStyle(el).transform),
    'none',
    'the marks make room for the move button',
  );
});
