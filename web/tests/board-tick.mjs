import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// A checkbox on a board card is something you tick, not something you read
// (from #74). Ticking it writes once and leaves the card closed; a click
// anywhere else on the card still opens the row.
await withFixture(async ({ page, api, base, path }) => {
  page.setDefaultTimeout(15000);
  const config = await api('GET', path);
  await api('PUT', path, { schema: [...config.schema, { id: 'ok', name: 'Approved', type: 'checkbox' }] });
  const collectionId = path.split('/').pop();
  const listed = await api('GET', `${path}/rows`);
  const first = (listed.rows ?? listed).find((r) => r.title === 'First row');
  // Ticked to begin with: a box nobody touched is blank, and a blank fact
  // does not show on a card.
  await api('PATCH', `/api/pages/${first.id}`, { props: { ...first.props, ok: true } });
  const approved = async () => (await api('GET', `/api/pages/${first.id}`)).props.ok;

  const writes = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes(`/api/pages/${first.id}`)) writes.push(r.url());
  });
  await page.goto(`${base}/p/${collectionId}`);
  await page.locator('.view-tab', { hasText: 'Board' }).click();
  const card = page.locator('.board-card', { hasText: 'First row' });
  const box = card.locator('.card-fact input[type="checkbox"]');
  await box.waitFor();
  const board = page.url();

  await box.click();
  await eventually(async () => (await approved()) === false);
  assert.equal(writes.length, 1, `one write per tick, saw ${writes.length}`);
  await box.click();
  await eventually(async () => (await approved()) === true);
  assert.equal(page.url(), board, 'ticking must not open the card');

  // Dragging a card must not select the text around it (#142). The drag
  // threshold is crossed before anything moves, and by then the browser has
  // already begun a selection, so the card keeps the pointerdown from the
  // browser for a mouse.
  const title = await card.locator('.board-card-title').boundingBox();
  const boardBox = await page.locator('.board').boundingBox();
  assert(title && boardBox);
  await page.mouse.move(title.x + 12, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(title.x + 40, boardBox.y - 70, { steps: 16 });
  await page.locator('.board-drag-ghost').waitFor();
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '', 'a card drag selected the text around it');
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '');
  assert.equal(page.url(), board);
  // The rest of the page still selects: the guard is on the card, not the app.
  const heading = await page.locator('textarea.page-title').boundingBox();
  assert(heading);
  await page.mouse.move(heading.x + 3, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.move(heading.x + 100, heading.y + heading.height / 2, { steps: 10 });
  await page.mouse.up();
  assert(await page.locator('textarea.page-title').evaluate((input) => input.selectionEnd > input.selectionStart));

  // The card opens in the side peek, so the board (and its URL) stays put.
  await card.getByText('First row', { exact: true }).click();
  await eventually(async () => (await page.locator('.peek-panel').count()) === 1);
  assert.equal(page.url(), board, 'opening the card must not navigate away from the board');

  console.log('Board tick: a box on a card ticks in one write and leaves the card closed.');
});
