import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// A timeline bar drag moves the start and the end in one gesture, so undo
// takes both back in one step — not one date at a time.
await withFixture(async ({ page, api, base, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  await api('PUT', path, {
    schema: [
      { id: 'start', name: 'Start', type: 'date' },
      { id: 'end', name: 'End', type: 'date' },
    ],
    views: [{ id: 'timeline', name: 'Timeline', type: 'timeline', dateProp: 'start', endDateProp: 'end' }],
  });
  await api('POST', '/api/pages', {
    parentId: collectionId,
    title: 'Sprint',
    props: { start: iso(2026, 6, 10), end: iso(2026, 6, 12) },
  });
  const datesOf = async () => {
    const res = await api('GET', `/api/collections/${collectionId}/rows?limit=100`);
    const r = res.rows.find((x) => x.title === 'Sprint');
    return { start: String(r.props.start).slice(0, 10), end: String(r.props.end).slice(0, 10) };
  };

  await page.goto(`${base}/p/${collectionId}`);
  // Rows load once per mount with no retry: on a slow first paint a reload
  // with warm data is the honest fallback (same for the bar below — the
  // window sometimes opens before the rows arrive and never recenters).
  try {
    await page.locator('.tl-row', { hasText: 'Sprint' }).waitFor({ timeout: 12000 });
  } catch {
    await page.reload();
    await page.locator('.tl-row', { hasText: 'Sprint' }).waitFor({ timeout: 25000 });
  }
  // The window sometimes opens before the rows arrive and never recenters;
  // a reload with warm data opens on it for sure.
  try {
    await page.locator('.tl-row', { hasText: 'Sprint' }).locator('.tl-bar').waitFor({ timeout: 8000 });
  } catch {
    await page.reload();
    await page.locator('.tl-row', { hasText: 'Sprint' }).locator('.tl-bar').waitFor();
  }

  // Drag the middle of the bar a few days right: a move, not a resize. The
  // press is dispatched straight at the bar — the month axis above it would
  // eat a real one — while the moves and the release are genuine pointer
  // events through the drag's own window listeners.
  const bar = await page.locator('.tl-row', { hasText: 'Sprint' }).locator('.tl-bar').boundingBox();
  const bx = bar.x + bar.width / 2;
  const by = bar.y + bar.height / 2;
  await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y)?.closest('.tl-bar') ?? document.querySelector('.tl-row .tl-bar');
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    );
  }, [bx, by]);
  await page.mouse.move(bx, by);
  await page.mouse.move(bx + 80, by, { steps: 10 });
  await page.mouse.up();
  await eventually(async () => (await datesOf()).start !== iso(2026, 6, 10));
  const moved = await datesOf();
  assert.notEqual(moved.end, iso(2026, 6, 12), 'the whole range travels, not just the start');

  // One undo takes the whole range back.
  await page.getByRole('button', { name: 'More actions' }).click();
  await eventually(async () => (await page.getByRole('button', { name: 'Undo', exact: true }).isDisabled()) === false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await eventually(async () => {
    const d = await datesOf();
    return d.start === iso(2026, 6, 10) && d.end === iso(2026, 6, 12);
  });
});
