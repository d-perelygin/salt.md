import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Relative days in collection date filters: "after today-1M" keeps meaning a
// month back from whenever the view runs, entered either by preset or typed by
// hand, and the server resolves the same word over plain HTTP.
await withFixture(async ({ page, context, api, base, workspace, path, read }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();
  const day = (off) => {
    const d = new Date();
    d.setDate(d.getDate() + off);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  await api('PUT', path, {
    schema: [{ id: 'due', name: 'Due', type: 'date' }],
    views: [{ id: 'table', name: 'Table', type: 'table' }],
  });
  for (const [title, due] of [['Old', day(-40)], ['Recent', day(-10)], ['Soon', day(5)]]) {
    await api('POST', '/api/pages', { parentId: collectionId, title, props: { due } });
  }
  await page.goto(`${base}/p/${collectionId}`);
  const rows = page.locator('.collection-scroll .db-table tbody tr');
  // Three of our own plus the fixture's two, which carry no date.
  await eventually(async () => (await rows.count()) === 5);

  // The server resolves the word over plain HTTP, without any UI involved.
  const ask = async (value) => {
    const res = await context.request.get(`${base}/api/collections/${collectionId}/rows`, {
      params: { filter: JSON.stringify({ property: 'due', op: 'gt', value }) },
    });
    assert(res.ok(), `rows: HTTP ${res.status()}`);
    return (await res.json()).total;
  };
  assert.equal(await ask('today-1M'), 2);
  assert.equal(await ask(day(-20)), 2, 'the word and the day it names must agree');

  // The UI: add "Due", ask for what is after, answer with a preset.
  await page.locator('.fs-controls button', { hasText: 'Filter' }).click();
  await page.locator('.fs-add').selectOption({ label: 'Due' });
  await page.locator('.fs-op').selectOption({ label: 'after' });
  await page.getByRole('button', { name: 'Relative', exact: true }).click();
  await page.locator('.fs-date .prop-select').selectOption({ label: 'A month ago' });
  await eventually(async () => (await page.locator('.fs-hint', { hasText: 'Resolves to' }).count()) === 1);
  await eventually(async () => (await rows.count()) === 2);
  assert.equal(await rows.filter({ hasText: 'Old' }).count(), 0);

  // Typed by hand instead: only the row five days out is after today-5d.
  await page.locator('.fs-date input[type="text"]').fill('today-5d');
  await eventually(async () => (await rows.count()) === 1);
  assert.equal(await rows.filter({ hasText: 'Soon' }).count(), 1);

  // Clearing the field to type another word must not fling the picker back
  // to Exact: the mode is sticky, the unfinished condition simply stops
  // filtering until something is typed.
  await page.locator('.fs-date input[type="text"]').fill('');
  assert.match(await page.getByRole('button', { name: 'Relative', exact: true }).getAttribute('class'), /on/);
  await eventually(async () => (await rows.count()) === 5);
  await page.locator('.fs-date input[type="text"]').fill('today-5d');
  await eventually(async () => (await rows.count()) === 1);

  // The word is what is saved, so a reload keeps filtering by it.
  await eventually(async () => (await read()).views[0].filters[0].value === 'today-5d');
  await page.reload();
  await eventually(async () => (await rows.count()) === 1);

  console.log('Smart dates: preset and hand-typed relative days filter, persist, and resolve server-side.');
});
