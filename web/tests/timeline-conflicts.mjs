import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Timeline conflicts: the Skip-weekends toggle lives in the conflicts menu,
// under the conflict list — not in the view settings — and flipping it
// retargets the Shift buttons. June 2026: the 12th is a Friday, so shifting
// clear of it lands on Saturday the 13th, or Monday the 15th with the toggle.
await withFixture(async ({ page, api, base, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();
  const iso = (d) => `2026-06-${String(d).padStart(2, '0')}`;
  await api('PUT', path, {
    schema: [
      { id: 'start', name: 'Start', type: 'date' },
      { id: 'end', name: 'End', type: 'date' },
      { id: 'blocking', name: 'Blocking', type: 'relation', relationCollection: collectionId },
    ],
    views: [
      { id: 'timeline', name: 'Timeline', type: 'timeline', dateProp: 'start', endDateProp: 'end', depProp: 'blocking' },
    ],
  });
  const blocked = await api('POST', '/api/pages', {
    parentId: collectionId,
    title: 'Blocked',
    props: { start: iso(10), end: iso(11) },
  });
  await api('POST', '/api/pages', {
    parentId: collectionId,
    title: 'Blocker',
    props: { start: iso(8), end: iso(12), blocking: [blocked.id] },
  });

  await page.goto(`${base}/p/${collectionId}`);
  await page.locator('.tl-conflicts-btn').waitFor();

  // The view settings carry Start/End/Blockers but no weekend toggle.
  await page.locator('.tl-settings-wrap > button').click();
  const settings = page.locator('.tl-settings-menu');
  await settings.waitFor();
  assert.equal(await settings.getByText('Skip weekends', { exact: true }).count(), 0);
  await page.keyboard.press('Escape');

  // The conflicts menu carries it, under the list, unchecked.
  await page.locator('.tl-conflicts-btn').click();
  const menu = page.locator('.tl-conflicts-menu');
  await menu.waitFor();
  const toggle = menu.getByRole('checkbox', { name: 'Skip weekends' });
  assert.equal(await toggle.count(), 1);
  assert.equal(await toggle.isChecked(), false);
  const shift = menu.locator('.tl-conflict-row button.btn-sm.primary');
  const saturday = await shift.innerText();
  assert.match(saturday, /13/, `shift lands on Saturday without the toggle, got ${saturday}`);

  // Flipping it retargets the Shift button to Monday, and back.
  await toggle.check();
  await eventually(async () => (await shift.innerText()) !== saturday);
  assert.match(await shift.innerText(), /15/, 'shift lands on Monday with the toggle');
  await toggle.uncheck();
  await eventually(async () => (await shift.innerText()) === saturday);

  console.log('Timeline conflicts: Skip weekends lives under the conflict list and retargets Shift.');
});
