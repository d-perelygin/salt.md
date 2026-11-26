import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// #68: looking at a page's sharing state must not publish it. The globe used to
// create a link the moment its menu opened, so checking whether Stop sharing
// had worked published the page again under a fresh address, and every page
// somebody looked at this way ended up public.
//
// The two halves now live in one dialog (Access and Publish). The globe opens
// it on Publish; opening is still free, and only "Share publicly" mints.
await withFixture(async ({ page, api, base, workspace }) => {
  page.setDefaultTimeout(15000);
  const doc = await api('POST', '/api/pages', { title: 'Quarterly notes', workspaceId: workspace.id });
  const shared = async () => (await api('GET', `/api/pages/${doc.id}`)).shared === true;
  const status = async (url) => (await fetch(url)).status;

  await page.goto(`${base}/p/${doc.id}`);
  const globe = page.locator('.share-wrap button[title="Share to web (read-only link)"]');
  await globe.waitFor();
  const dialog = page.locator('.share-dialog');

  // Opening the dialog shows the state and publishes nothing.
  await globe.click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Share publicly', exact: true }).waitFor();
  assert.equal(await shared(), false, 'opening the dialog published the page');

  // "Share publicly" publishes, and the address works.
  await dialog.getByRole('button', { name: 'Share publicly', exact: true }).click();
  const field = dialog.locator('input.share-input[readonly]');
  await eventually(async () => (await field.count()) === 1 && (await field.inputValue()).includes('/public/'));
  const first = await field.inputValue();
  assert.equal(await status(first), 200);
  assert.equal(await shared(), true);

  // A password applies to the link that is already on screen; it must not mint
  // a new address behind the reader's back.
  await dialog.locator('input[type=password]').fill('correct horse');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await eventually(async () => (await dialog.locator('input[type=password]').inputValue()) === '');
  assert.equal(await field.inputValue(), first, 'applying a password replaced the link');

  // Stop sharing ends the address and closes the dialog; opening it again to
  // check does not bring the page back.
  await dialog.getByRole('button', { name: 'Stop sharing', exact: true }).click();
  await eventually(async () => (await dialog.count()) === 0);
  assert.equal(await status(first), 404);
  assert.equal(await shared(), false);
  await globe.click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Share publicly', exact: true }).waitFor();
  assert.equal(await shared(), false, 'checking the dialog after Stop sharing published the page again');
  await page.keyboard.press('Escape');
  await eventually(async () => (await dialog.count()) === 0);
  assert.equal(await shared(), false);
});
