import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Timeline: rows outside the window keep their labels, the mode menu opens at
// its button, stretching a timed value keeps its time, and a click on a resize
// handle without dragging saves nothing.
await withFixture(async ({ page, api, base, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();
  const iso = (y, m, d, time = '') =>
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}${time}`;
  await api('PUT', path, {
    schema: [
      { id: 'start', name: 'Start', type: 'date' },
      { id: 'end', name: 'End', type: 'date' },
      { id: 'blocks', name: 'Blocks', type: 'relation', relationCollection: collectionId },
    ],
    views: [{
      id: 'timeline', name: 'Timeline', type: 'timeline',
      dateProp: 'start', endDateProp: 'end', depProp: 'blocks',
    }],
  });
  const winter = await api('POST', '/api/pages', {
    parentId: collectionId,
    title: 'Winter',
    props: { start: iso(2026, 1, 10), end: iso(2026, 1, 12) },
  });
  const timedPage = await api('POST', '/api/pages', {
    parentId: collectionId,
    title: 'Timed',
    props: { start: iso(2026, 6, 10, 'T14:30'), end: iso(2026, 6, 12, 'T14:30') },
  });
  // A row outside the window is listed only when an edge connects it to a row
  // inside: the timeline shows the work in view plus what it depends on, not
  // every row ever created. Winter blocks Timed, so it keeps a label.
  await api('PATCH', `/api/pages/${timedPage.id}`, { props: { ...timedPage.props, blocks: [winter.id] } });
  await api('POST', '/api/pages', {
    parentId: collectionId,
    title: 'Plain',
    props: { start: iso(2026, 6, 15), end: iso(2026, 6, 16) },
  });

  await page.goto(`${base}/p/${collectionId}`);
  const rows = page.locator('.tl-row');
  await eventually(async () => (await rows.count()) >= 3);

  // The window opens on the data, not on today. Winter sits five months
  // before it; because it blocks a row in view it keeps its label, and its
  // bar becomes the small offscreen marker with the date and an arrow.
  const winterRow = page.locator('.tl-row', { hasText: 'Winter' });
  assert.equal(await winterRow.count(), 1);
  assert.equal(await winterRow.locator('.tl-offscreen-arrow').count(), 1);
  assert.equal(await winterRow.locator('.tl-bar-offscreen').count(), 1);
  assert.equal(await winterRow.locator('.tl-bar:not(.tl-bar-offscreen)').count(), 0);

  // The mode menu opens at its button, not far above it.
  const rangeBtn = page.locator('.tl-right .cal-range-wrap > button');
  await rangeBtn.click();
  const menu = page.locator('.tl-right .view-tab-menu');
  await menu.waitFor();
  const btn = await rangeBtn.boundingBox();
  const box = await menu.boundingBox();
  assert(box.y >= btn.y + btn.height - 8, `menu at ${box.y}, button ends at ${btn.y + btn.height}`);
  await page.locator('.fs-backdrop').first().click();

  // Stretching a timed value by about two days keeps its time. The edge
  // handles surface on hover, so the row has to be hovered before the handle
  // is measured and grabbed.
  const timedRow = page.locator('.tl-row', { hasText: 'Timed' });
  await timedRow.locator('.tl-bar').hover();
  await page.waitForTimeout(150);
  const handle = timedRow.locator('.tl-resize-r');
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2, { steps: 8 });
  // A finger pauses before letting go; without this the synthetic moves land
  // in one frame and the release reads the day before the last move.
  await page.waitForTimeout(200);
  await page.mouse.up();
  await eventually(async () => {
    const res = await api('GET', `/api/collections/${collectionId}/rows?limit=100`);
    return res.rows.find((r) => r.title === 'Timed').props.end !== iso(2026, 6, 12, 'T14:30');
  });
  const after = await api('GET', `/api/collections/${collectionId}/rows?limit=100`);
  const timed = after.rows.find((r) => r.title === 'Timed');
  assert.match(timed.props.end, /T14:30$/, `stretching must keep the time, got ${timed.props.end}`);

  // A click on a resize handle without dragging saves nothing (it still
  // navigates into the row, which is why this assertion runs last).
  const plainHandle = page.locator('.tl-row', { hasText: 'Plain' }).locator('.tl-resize-r');
  await page.locator('.tl-row', { hasText: 'Plain' }).locator('.tl-bar').hover();
  await plainHandle.click();
  const kept = await api('GET', `/api/collections/${collectionId}/rows?limit=100`);
  const plainRow = kept.rows.find((r) => r.title === 'Plain');
  assert.equal(plainRow.props.end, iso(2026, 6, 16), 'a click without drag must not rewrite the date');

  console.log('Timeline: label-only rows, menu placement, click-safe handles, timed stretch.');
});
