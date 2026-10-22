import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// The process scheme draws every road, not only the guarded ones: with a
// single rule A→Done, the four roads into the unguarded A and B are free
// (dashed), A→Done is solid, and the refused B→Done has no arrow at all.
await withFixture(async ({ page, api, base, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();
  await api('PUT', path, {
    schema: [
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'done', name: 'Done' }] },
    ],
    views: [{ id: 'board', name: 'Board', type: 'board', groupBy: 'status' }],
    workflow: { statusPropId: 'status', rules: [
      { id: 'r1', when: { type: 'status_to', to: 'done' }, allowFrom: ['a'], do: [] },
    ] },
  });
  await page.goto(`${base}/p/${collectionId}`);
  await page.getByRole('button', { name: 'Properties', exact: true }).click();
  await page.getByRole('button', { name: /^Process/ }).click();
  await page.getByRole('tab', { name: 'Scheme' }).click();
  const svg = page.locator('.workflow-scheme-svg');
  await svg.waitFor();

  const free = svg.locator('g.free path');
  await eventually(async () => (await free.count()) === 4);
  const solid = svg.locator('g:not(.free) path');
  assert.equal(await solid.count(), 1);
  assert.match(await svg.locator('g.free title').first().textContent(), /Allowed — no rule/);

  console.log('Scheme draws the four free roads dashed, the guarded one solid, none for the refused move.');
});
