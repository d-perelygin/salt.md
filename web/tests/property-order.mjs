import assert from 'node:assert/strict';
import { withFixture } from './fixture.mjs';

await withFixture(async ({ page, open, read, assertRows }) => {
  page.setDefaultTimeout(15000);
  const initial = await read();
  const items = page.locator('.schema-item');
  const names = () => items.locator('.schema-row > .prop-input').evaluateAll(inputs => inputs.map(input => input.value));
  const drag = async (source, target, after) => {
    const destination = items.nth(target);
    const bounds = await destination.boundingBox();
    await items.nth(source).locator('.schema-drag-handle').dragTo(destination, {
      targetPosition: { x: 100, y: after ? bounds.height - 2 : 2 },
    });
  };
  await open();
  await drag(0, 1, true);
  assert.deepEqual(await names(), ['Labels', 'Status']);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // A reordered schema counts as unsaved work, so cancelling asks whether to
  // drop it; the next open() answers that, so the schema is read first.
  assert.deepEqual((await read()).schema, initial.schema);
  await open();
  await drag(0, 1, true);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Collection properties' }).waitFor({ state: 'hidden' });
  assert.deepEqual((await read()).schema, [...initial.schema].reverse());
  assert.deepEqual((await read()).views, initial.views);
  await assertRows();
  await page.reload();
  await open();
  assert.deepEqual(await names(), ['Labels', 'Status']);
  await drag(1, 0, false);
  assert.deepEqual(await names(), ['Status', 'Labels']);
  // A drag from outside the property handles must not reorder the schema.
  await items.first().locator('.prop-input').dispatchEvent('dragstart');
  await items.last().dispatchEvent('drop');
  assert.deepEqual(await names(), ['Status', 'Labels']);
  for (const name of ['Deadline', 'Owner']) {
    await page.getByPlaceholder('New property name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
  }
  await drag(3, 0, false);
  assert.deepEqual(await names(), ['Owner', 'Status', 'Labels', 'Deadline']);
  await drag(0, 3, true);
  assert.deepEqual(await names(), ['Status', 'Labels', 'Deadline', 'Owner']);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Collection properties' }).waitFor({ state: 'hidden' });
  assert.deepEqual((await read()).schema.map(p => p.name), ['Status', 'Labels', 'Deadline', 'Owner']);
  // The name carries the shortcut since #8 ("Collapse the sidebar ([)").
  await page.getByRole('button', { name: /^Collapse the sidebar/ }).click();
  await open();
  await page.setViewportSize({ width: 375, height: 800 });
  assert(await items.first().locator('.schema-drag-handle').isVisible());
  assert(await page.locator('.dialog.wide').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));

  // Reorder view: one editable line per property. The type configuration and
  // the add/template blocks step aside, so a long schema fits and the handles
  // sit next to each other; dragging still reorders.
  const tall = (await items.first().boundingBox()).height;
  await page.getByRole('tab', { name: 'Reorder', exact: true }).click();
  assert.equal(await page.locator('.dialog.wide.schema-reorder').count(), 1);
  assert.equal(await page.getByPlaceholder('New property name').isVisible(), false);
  assert.equal(await page.locator('.schema-options').first().isVisible(), false);
  const flat = (await items.first().boundingBox()).height;
  assert(flat < tall, `reorder rows are thinner (${Math.round(flat)} < ${Math.round(tall)})`);
  const before = await names();
  await drag(0, 1, true);
  assert.deepEqual(await names(), [before[1], before[0], ...before.slice(2)]);
  await page.getByRole('tab', { name: 'Edit', exact: true }).click();
  assert.equal(await page.getByPlaceholder('New property name').isVisible(), true);
});
console.log('Property order: drag, save/cancel, reload, unchanged data and narrow layout passed.');
