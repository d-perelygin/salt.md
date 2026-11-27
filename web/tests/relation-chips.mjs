import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Relation chips: a click EDITS (opens the picker below), the icon beside the
// chip opens the row. A click must never navigate, and buttons must never nest
// — the picker toggle used to swallow a pencil button, which is invalid HTML
// and vanished behind long titles on cards.
await withFixture(async ({ page, api, base, workspace, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();
  const target = await api('POST', '/api/pages', {
    title: 'Targets',
    type: 'collection',
    workspaceId: workspace.id,
  });
  const alpha = await api('POST', '/api/pages', { parentId: target.id, title: 'Alpha', props: {} });
  await api('POST', '/api/pages', { parentId: target.id, title: 'Beta', props: {} });
  await api('PUT', path, {
    schema: [{ id: 'rel', name: 'Rel', type: 'relation', relationCollection: target.id }],
    views: [{ id: 'table', name: 'Table', type: 'table', colWidths: { __title: 140, rel: 160 } }],
  });
  const long = await api('POST', '/api/pages', {
    parentId: target.id,
    title: 'A target whose title is longer than any narrow column will ever be',
    props: {},
  });
  await api('POST', '/api/pages', {
    parentId: collectionId,
    title: 'Linked',
    props: { rel: [alpha.id] },
  });
  const wide = await api('POST', '/api/pages', {
    parentId: collectionId,
    title: 'Linked too',
    props: { rel: [long.id] },
  });

  await page.goto(`${base}/p/${collectionId}`);
  const chip = page.locator('.relation-chip-wrap', { hasText: 'Alpha' }).first();
  await chip.waitFor();
  // A long title is cut off inside its cell, never painted over the next
  // column (#146). Measured on the pinned 160px column: the wrapper used to
  // grow to the title's width while the chip resolved its 100% against it.
  const overflow = await page
    .locator('.db-table tbody tr', { hasText: 'Linked too' })
    .locator('td', { has: page.locator('.relation-value') })
    .first()
    .evaluate((td) => {
      const value = td.querySelector('.relation-value');
      const chipIn = td.querySelector('.relation-chip');
      if (!value || !chipIn) return null;
      return Math.round(chipIn.getBoundingClientRect().right - td.getBoundingClientRect().right);
    });
  assert.ok(overflow !== null, 'the long relation cell did not render');
  assert.ok(overflow <= 1, `the chip runs ${overflow}px past its cell`);
  // No button inside a button anywhere in the relation cells.
  assert.equal(await page.locator('.relation-value button button').count(), 0);

  // Clicking the chip edits: the picker opens, nothing navigates.
  const url = page.url();
  await chip.locator('.relation-chip').click();
  await page.locator('.relation-menu').waitFor();
  assert.equal(page.url(), url);

  // The icon opens the row. Deploy peeks a collection row on a plain click, so
  // a side peek carrying the row's title is the proof it opened.
  await chip.locator('.relation-open-btn').click();
  await eventually(async () => (await page.locator('.peek-panel', { hasText: 'Alpha' }).count()) >= 1);

  console.log('Relation chips: click edits, the icon opens the row, no nested buttons.');
});
