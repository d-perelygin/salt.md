import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// The table grows with the page: scrolling sends the page header (title,
// description) away like the calendar and the board do, while the toolbar
// and the table's own heading row stay put. The table used to scroll inside
// a capped box, so the header stood frozen no matter how far down the rows
// went.
await withFixture(async ({ page, api, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();

  // Enough rows to overflow the viewport.
  for (let i = 0; i < 40; i++) {
    await api('POST', '/api/pages', {
      parentId: collectionId, title: `Scroll row ${i}`, props: { status: 'todo' },
    });
  }
  await page.reload();
  await page.locator('.db-table tbody tr', { hasText: 'Scroll row 39' }).waitFor();

  // The heading sticks natively, with no hand-driven offset: position sticky
  // against the page scroll, clearing exactly the live toolbar.
  const pos = await page
    .locator('.db-table thead th')
    .first()
    .evaluate((el) => getComputedStyle(el).position);
  assert.equal(pos, 'sticky');

  await page.evaluate(() => document.querySelector('.page-body')?.scrollTo(0, 1e9));
  await eventually(async () => {
    const r = await page.locator('.page-head').evaluate((el) => el.getBoundingClientRect().toJSON());
    return r.bottom < 0;
  });

  // Toolbar stuck to the top of the page scroller, heading stuck under the
  // toolbar. (The scroller starts below the topbar with the body's own
  // offset — what matters is the bar rides the scroller's top edge.)
  const bodyTop = await page.locator('.page-body').evaluate((el) => el.getBoundingClientRect().top);
  const bar = await page.locator('.collection-toolbar').evaluate((el) => el.getBoundingClientRect().toJSON());
  const head = await page
    .locator('.db-table thead th')
    .first()
    .evaluate((el) => el.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(bar.top - bodyTop) < 2, `toolbar stuck to scroller top (bar=${bar.top}, body=${bodyTop})`);
  assert.ok(Math.abs(head.top - bar.bottom) < 3, `heading stuck under toolbar (head=${head.top}, bar bottom=${bar.bottom})`);

  // A table wider than the viewport scrolls sideways at the page level, and
  // the heading travels with the columns it names.
  const cfg = await api('GET', path);
  const schema = [...cfg.schema];
  for (let i = 0; i < 14; i++) schema.push({ id: `extra${i}`, name: `Extra ${i}`, type: 'text' });
  await api('PUT', path, { schema, views: cfg.views });
  await page.reload();
  await page.locator('.db-table thead th', { hasText: 'Extra 13' }).waitFor();
  const wide = await page.evaluate(() => {
    const b = document.querySelector('.page-body');
    return b.scrollWidth > b.clientWidth + 100;
  });
  assert.ok(wide, 'page carries the sideways scroll');
  await page.evaluate(() => document.querySelector('.page-body')?.scrollTo(99999, 0));
  await eventually(async () => {
    const x = await page.evaluate(() => document.querySelector('.page-body')?.scrollLeft ?? 0);
    return x > 100;
  });
  const firstTh = await page
    .locator('.db-table thead th')
    .first()
    .evaluate((el) => el.getBoundingClientRect().toJSON());
  const bodyBox = await page.locator('.page-body').evaluate((el) => el.getBoundingClientRect().toJSON());
  assert.ok(firstTh.left < bodyBox.left, 'heading travels with its columns');

  // The toolbar does not ride away with the table: it holds the viewport's
  // left edge while the columns slide under it.
  const barBox = await page.locator('.collection-toolbar').evaluate((el) => el.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(barBox.left - bodyBox.left) < 2, `toolbar holds the left edge (bar=${barBox.left}, body=${bodyBox.left})`);
  assert.ok(Math.abs(barBox.width - bodyBox.width) < 2, `toolbar spans the viewport (bar=${barBox.width}, body=${bodyBox.width})`);
});
