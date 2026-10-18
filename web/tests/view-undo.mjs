import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Session undo for collection views. A cell edit, a hidden column and a
// cross-column board drop each undo and redo through the ⋯ menu, and a
// shortcut does the same — one gesture, one step, this tab only.
await withFixture(async ({ page, api, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();

  const statusOf = async (title) => {
    const { rows } = await api('GET', `${path}/rows`);
    return rows.find((r) => r.title === title)?.props.status;
  };
  const more = () => page.getByRole('button', { name: 'More actions' });
  const undo = () => page.getByRole('button', { name: 'Undo', exact: true });
  const redo = () => page.getByRole('button', { name: 'Redo', exact: true });

  // Nothing to take back yet: both grey.
  await more().click();
  assert.equal(await undo().isDisabled(), true);
  assert.equal(await redo().isDisabled(), true);
  await page.keyboard.press('Escape');

  // A cell edit, through the ⋯ menu and back.
  const firstCell = page.locator('.db-table tbody tr', { hasText: 'First row' }).locator('td[data-col=status] .select-cell-value');
  await firstCell.click();
  await page.locator('.select-menu').getByRole('button', { name: 'Done', exact: true }).click();
  await eventually(async () => (await statusOf('First row')) === 'done');
  await more().click();
  // The menu reads the stack when it opens (effect, so a beat after paint).
  await eventually(async () => (await undo().isDisabled()) === false);
  await undo().click();
  await eventually(async () => (await statusOf('First row')) === 'todo');
  await more().click();
  await eventually(async () => (await redo().isDisabled()) === false);
  await redo().click();
  await eventually(async () => (await statusOf('First row')) === 'done');

  // The shortcut does the same: back to todo, then forward again.
  await page.locator('.db-table thead th').first().click();
  await page.keyboard.press('Control+z');
  await eventually(async () => (await statusOf('First row')) === 'todo');
  await page.keyboard.press('Control+Shift+z');
  await eventually(async () => (await statusOf('First row')) === 'done');

  // Sorting back announces itself: a restored order reads as nothing
  // happening, so the undo says what came back.
  await page.getByRole('button', { name: 'Sort' }).click();
  await page.locator('.fs-popover select.prop-select').first().selectOption('status');
  await page.locator('.fs-backdrop').click();
  await eventually(async () => (await api('GET', path)).views[0].sort?.property === 'status');
  await more().click();
  await eventually(async () => (await undo().isDisabled()) === false);
  await undo().click();
  await eventually(async () => (await page.locator('.toaster').getByText('Sort reverted').count()) === 1);
  await eventually(async () => (await api('GET', path)).views[0].sort == null);

  // Undoing a first-time write clears the key instead of leaving the value:
  // JSON drops undefined, which the server reads as "no change", so the old
  // is captured as null (the server deletes null keys). A row that never had
  // labels loses them again, key and all — the tray-scheduling case.
  const fresh = await api('POST', '/api/pages', {
    parentId: collectionId,
    title: 'No labels row',
    props: { status: 'todo' },
  });
  await eventually(async () => {
    const { rows } = await api('GET', `${path}/rows`);
    return rows.some((r) => r.title === 'No labels row');
  });
  await page.locator('.db-table tbody tr', { hasText: 'No labels row' }).locator('td[data-col=labels] .select-cell-value').click();
  await page.locator('.select-menu').getByRole('button', { name: 'To do', exact: true }).click();
  // Multiselect stays open (focus sits on the option, so Escape would miss
  // the search box that owns it): dismiss through the backdrop.
  await page.locator('.select-backdrop').click();
  await eventually(async () => {
    const { rows } = await api('GET', `${path}/rows`);
    return (rows.find((r) => r.title === 'No labels row')?.props.labels ?? []).length === 1;
  });
  await more().click();
  await eventually(async () => (await undo().isDisabled()) === false);
  await undo().click();
  await eventually(async () => {
    const { rows } = await api('GET', `${path}/rows`);
    return !('labels' in (rows.find((r) => r.title === 'No labels row')?.props ?? {}));
  });

  // Hiding a column is a view change: gone, then back.
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.locator('.col-popover').getByRole('button', { name: 'Labels' }).click();
  await page.locator('.fs-backdrop').click();
  await eventually(async () => (await page.locator('.db-table thead th', { hasText: 'LABELS' }).count()) === 0);
  await more().click();
  await eventually(async () => (await undo().isDisabled()) === false);
  await undo().click();
  await eventually(async () => (await page.locator('.db-table thead th', { hasText: 'LABELS' }).count()) === 1);

  // Across columns on the board: one step takes the card there and back.
  // Back to todo first, so the drop actually changes columns (through the
  // API: setup, not the action under test — the done row is filtered out of
  // this view and has no cell to press).
  await api('PATCH', `/api/pages/${(await api('GET', `${path}/rows`)).rows.find((r) => r.title === 'First row').id}`, {
    propsPatch: { status: 'todo' },
  });
  await eventually(async () => (await statusOf('First row')) === 'todo');
  await page.locator('.view-tab', { hasText: 'Board' }).click();
  await page.locator('.board-card', { hasText: 'First row' }).waitFor();
  // Let the SSE reload from the API reset land, or the card detaches
  // mid-gesture and the coordinates go null.
  await page.waitForTimeout(1000);
  await page.locator('.board-card', { hasText: 'First row' }).waitFor();
  const card = page.locator('.board-card', { hasText: 'First row' }).boundingBox();
  const doneCol = page.locator('.board-col[data-col=done] .board-cards').boundingBox();
  const box = await card;
  const col = await doneCol;
  // Grabbed by the card's top padding: the middle holds chips and buttons,
  // and starting a drag on those must keep meaning click, not drag. Dropped
  // onto the column's empty area below its cards (inside the viewport), so
  // it lands on the column rather than between cards.
  const dropY = Math.min(col.y + 200, 850);
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(col.x + col.width / 2, dropY, { steps: 12 });
  await page.mouse.up();
  await eventually(async () => (await statusOf('First row')) === 'done');
  await more().click();
  await eventually(async () => (await undo().isDisabled()) === false);
  await undo().click();
  await eventually(async () => (await statusOf('First row')) === 'todo');
  await eventually(async () => (await page.locator('.board-col[data-col=todo] .board-card', { hasText: 'First row' }).count()) === 1);
});
