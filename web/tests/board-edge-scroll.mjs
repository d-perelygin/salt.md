import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Dragging a card into a column that is off-screen. The board used to keep
// still while the card was held at its edge, so a card could only reach the
// columns already in view — on a phone that is one and a half of them.
//
// The narrow viewport is the point: the fixture's 320px columns cannot both fit
// in 520px, so the board really has somewhere to scroll to.
await withFixture(async ({ page }) => {
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 520, height: 840 });

  await page.locator('.view-tab', { hasText: 'Board' }).click();
  const card = page.locator('.board-card', { hasText: 'First row' });
  await card.waitFor();
  const board = page.locator('.board');
  const sizes = await board.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  assert(sizes.sw > sizes.cw, 'the fixture board has somewhere to scroll to');
  const before = await board.evaluate((el) => el.scrollLeft);

  const cardBox = await card.boundingBox();
  const boardBox = await board.boundingBox();
  await page.mouse.move(cardBox.x + 20, cardBox.y + 20);
  await page.mouse.down();
  // Into the right edge zone, then HOLD: a finger at the edge produces no more
  // pointer moves, so the scrolling has to come from a frame loop rather than
  // from the move handler.
  await page.mouse.move(boardBox.x + boardBox.width - 12, cardBox.y + 24, { steps: 12 });
  await page.waitForTimeout(700);
  const after = await board.evaluate((el) => el.scrollLeft);
  assert(after > before, `the board scrolls under a held card (${before} → ${after})`);

  await page.mouse.up();
  // Snapping comes back afterwards; the card is still one card and still here.
  await eventually(async () => (await page.locator('.board-card', { hasText: 'First row' }).count()) === 1);
  assert.equal(await board.evaluate((el) => el.style.scrollSnapType), '', 'the snap override is cleared');
});
