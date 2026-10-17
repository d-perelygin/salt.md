import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Collapsing or expanding the sidebar must not dismiss the peek. Both
// buttons unmount themselves on click (the collapsed rail shows another
// one), so React redraws before the click reaches the document: e.target
// hangs detached, closest() answers null, and the peek used to close even
// though a button press keeps it open. The press position is now decided on
// pointerdown, while the DOM is still intact.
await withFixture(async ({ page }) => {
  page.setDefaultTimeout(15000);

  await page.locator('.db-table tbody .db-title-link', { hasText: 'First row' }).click();
  await page.locator('.peek-panel').waitFor();

  // Collapse: the sidebar goes away, the peek stays with its row.
  await page.locator('.sidebar .collapse-btn').click();
  await eventually(async () => (await page.locator('.app.sidebar-collapsed').count()) === 1);
  assert.equal(await page.locator('.peek-panel').count(), 1);

  // Expand (pin) back: the collapse click leaves the pointer over the
  // sidebar, and the hover-lock hides the rail until it leaves — so move
  // away first (like a hand would), then hover the hot edge to reveal it.
  await page.mouse.move(600, 450);
  await page.locator('.sidebar-hotzone').hover();
  await page.locator('.sidebar .collapse-btn').click();
  await eventually(async () => (await page.locator('.app.sidebar-collapsed').count()) === 0);
  assert.equal(await page.locator('.peek-panel').count(), 1);
});
