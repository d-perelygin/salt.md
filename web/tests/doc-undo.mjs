import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Doc undo buttons in the ⋯ menu drive BlockNote's own history. Whatever was
// typed while the menu was closed must still enable them when it opens.
await withFixture(async ({ page, api, workspace }) => {
  page.setDefaultTimeout(15000);
  const doc = await api('POST', '/api/pages', {
    title: 'Undo doc',
    type: 'doc',
    workspaceId: workspace.id,
  });
  const more = () => page.getByRole('button', { name: 'More actions' });
  const undo = () => page.getByRole('button', { name: 'Undo', exact: true });
  const redo = () => page.getByRole('button', { name: 'Redo', exact: true });
  const text = () => page.locator('.bn-block-content').first().innerText();

  await page.goto(page.url().split('/p/')[0] + `/p/${doc.id}`);
  await page.locator('.bn-block-content').first().click();
  await page.keyboard.type('hello undo');
  await eventually(async () => (await text()).includes('hello undo'));

  await more().click();
  await eventually(async () => (await undo().isDisabled()) === false);
  // BlockNote may batch typing per keystroke or per word: undo until gone.
  // Each undo closes the menu, so reopen for the next round.
  for (let i = 0; i < 8; i++) {
    await undo().click();
    if (!(await text()).includes('hello')) break;
    await more().click();
    await eventually(async () => (await undo().isDisabled()) === false);
  }
  assert.ok(!(await text()).includes('hello'), 'undo took the typed word back');

  await more().click();
  await eventually(async () => (await redo().isDisabled()) === false);
  await redo().click();
  await eventually(async () => (await text()).length > 0);
});
