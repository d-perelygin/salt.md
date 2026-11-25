import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eventually, withFixture } from './fixture.mjs';

// A person property that allows several people and names who can be picked
// (#11), and what happens to the rows when it is switched back to one.
await withFixture(async ({ page, api, workspace, path, read }) => {
  page.setDefaultTimeout(15000);
  const colleague = (name) =>
    api('POST', '/api/users', {
      name,
      email: `${name.toLowerCase()}@example.test`,
      password: randomUUID(),
      workspaces: [{ id: workspace.id, role: 'member' }],
    });
  const ana = await colleague('Ana');
  const ben = await colleague('Ben');
  await colleague('Cleo');

  const config = await read();
  const withTeam = (team) => api('PUT', path, { schema: [...config.schema, team], views: config.views });
  await withTeam({ id: 'team', name: 'Team', type: 'person', personMultiple: true, personPool: [ana.id, ben.id] });
  await page.reload();

  const firstRow = page.locator('.db-table tbody tr').filter({ hasText: 'First row' });
  await firstRow.waitFor();
  await page.locator('.db-table thead th', { hasText: /team/i }).waitFor();
  const headers = await page.locator('.db-table thead th').allInnerTexts();
  const col = headers.findIndex((h) => /team/i.test(h));
  assert(col >= 0, 'the Team column is shown');
  const cell = () => firstRow.locator('td').nth(col);
  const rowId = async () => (await api('GET', `${path}/rows?limit=10`)).rows.find((r) => r.title === 'First row').id;
  const team = async () => (await api('GET', `/api/pages/${await rowId()}`)).props.team;

  // Only Ana and Ben are offered, and nobody can be typed in beside them.
  await cell().locator('.relation-open').click();
  const options = page.locator('.relation-menu .relation-option');
  await options.first().waitFor();
  const offered = await options.allInnerTexts();
  // Each option reads "✓ A Ana" or "B Ben": tick, face, name. The name is last.
  assert.deepEqual(offered.map((o) => o.trim().split(/\s+/).pop()).sort(), ['Ana', 'Ben']);
  await page.locator('.relation-menu .prop-input').fill('Cleo');
  assert.equal(await page.locator('.relation-menu').getByText('Use “Cleo”').count(), 0);
  await page.locator('.relation-menu .prop-input').fill('');

  // Several: the list stays open, each pick adds a tick.
  await options.filter({ hasText: 'Ana' }).click();
  await options.filter({ hasText: 'Ben' }).click();
  await eventually(async () => JSON.stringify(await team()) === JSON.stringify([ana.id, ben.id]));
  await options.filter({ hasText: 'Ana' }).click();
  await eventually(async () => JSON.stringify(await team()) === JSON.stringify([ben.id]));
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);

  // Back to one person: the row keeps what it holds until somebody picks.
  await withTeam({ id: 'team', name: 'Team', type: 'person', personPool: [ana.id, ben.id] });
  await page.reload();
  await cell().locator('.relation-open').click();
  await page.locator('.relation-menu .relation-option').filter({ hasText: 'Ana' }).click();
  await eventually(async () => (await team()) === ana.id);
  await page.locator('.relation-menu').waitFor({ state: 'hidden' });

  // The face beside a name in the picker opens that person's account page.
  await cell().locator('.relation-open').click();
  const anaRow = page.locator('.relation-option-row').filter({ hasText: 'Ana' });
  await anaRow.locator('.relation-profile-btn').click();
  await page.locator('.person-page').waitFor();
  assert.match(await page.locator('.person-name').innerText(), /Ana/);
  await page.locator('.person-close').click();
  await page.locator('.person-page').waitFor({ state: 'detached' });

  // --- a person's two names ------------------------------------------------
  // The instance default is the nickname; a reader may choose the formal name
  // for their own screen. Neither changes what the account's record says.
  await api('PATCH', `/api/users/${ana.id}`, { nickname: 'Annie' });
  const me = await api('GET', '/api/me');
  const setDisplay = (nameDisplay) => api('PUT', '/api/me/prefs', { ...me.prefs, nameDisplay });
  await setDisplay('nickname');
  await page.reload();
  await cell().waitFor();
  await eventually(async () => (await cell().innerText()).includes('Annie'));
  await setDisplay('name');
  await page.reload();
  await cell().waitFor();
  await eventually(async () => {
    const text = await cell().innerText();
    return text.includes('Ana') && !text.includes('Annie');
  });

  // --- the account page ----------------------------------------------------
  await page.locator('.user-menu-btn').first().click();
  await page.getByRole('button', { name: 'Account page' }).click();
  await page.locator('.person-page').waitFor();
  assert.match(await page.locator('.person-name').innerText(), /Browser Tester \(You\)/);
  const side = await page.locator('.person-side').innerText();
  assert(side.includes('browser@example.test'), 'the account page shows the email');
  assert(side.includes('Membership type'), 'and the instance role');
  assert.equal(await page.locator('.person-close').count(), 1);
  await page.locator('.person-close').click();
  await eventually(async () => (await page.locator('.person-page').count()) === 0);

  // And the setting itself, from the Properties dialog.
  await page.getByRole('button', { name: 'Properties', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Several people' }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await eventually(async () => (await read()).schema.find((p) => p.id === 'team')?.personMultiple === true);

  console.log('People: several per cell, only the named ones offered, and back to one.');
});
