import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// A slow read started before an edit must not paint over it when it lands
// late — and here no second load can rescue it, so only the rowsVersion
// guard stands between the stale answer and the screen. The handshake below
// makes the order deterministic: the held load is provably in flight before
// the edit bumps the version. Without the guard the held answer overwrites
// the edit and sticks (nothing reloads after it).
await withFixture(async ({ page, api, path, context }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();
  const labelsOf = async (title) => {
    const { rows } = await api('GET', `${path}/rows`);
    return rows.find((r) => r.title === title)?.props.labels ?? [];
  };
  const labelsText = () =>
    page.locator('.db-table tbody tr', { hasText: 'First row' }).locator('td[data-col=labels]').innerText();

  // The table first (its load passes before the route below exists), then
  // the held load, then the edit. The service worker is stood down first:
  // it shadows page.route interception for the API calls it snapshots, and
  // this test steers one. The stub keeps both call sites safe (registration
  // is best-effort, the version check guards and catches).
  await page.locator('.db-table tbody tr', { hasText: 'First row' }).waitFor();
  await page.evaluate(() =>
    navigator.serviceWorker?.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))),
  );
  await page.addInitScript(() => {
    const stub = {
      register: () => Promise.reject(new Error('sw disabled in test')),
      getRegistration: async () => undefined,
      getRegistrations: async () => [],
    };
    try {
      Object.defineProperty(window.navigator, 'serviceWorker', { value: stub, configurable: true });
    } catch {
      /* already gone */
    }
  });
  await page.reload();
  await page.locator('.db-table tbody tr', { hasText: 'First row' }).waitFor();
  const state = { release: false, started: false };
  await page.route(/\/api\/collections\/.*\/rows/, async (route) => {
    const res = await route.fetch();
    if (!state.started) {
      state.started = true;
      while (!state.release) await new Promise((r) => setTimeout(r, 100));
    }
    await route.fulfill({ response: res });
  });

  // A load is in flight (held). Offline next, so the edit journals without
  // any server event starting a fresher load.
  await page.evaluate(
    ([id]) => window.dispatchEvent(new CustomEvent('salt:rows', { detail: id })),
    [collectionId],
  );
  for (let i = 0; i < 100 && !state.started; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(state.started, 'held load in flight');
  await context.setOffline(true);
  await page.locator('.db-table tbody tr', { hasText: 'First row' }).locator('td[data-col=labels] .select-cell-value').click();
  await page.locator('.select-menu').getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.select-backdrop').click();
  await eventually(async () => !((await labelsText()).includes('Done')));
  // Release the stale answer: the cell still shows the edit, not the read.
  state.release = true;
  await page.waitForTimeout(1000);
  assert.ok(!(await labelsText()).includes('Done'), 'stale read must not overwrite the edit');
  // Back online: the journaled edit replays and the server converges.
  await context.setOffline(false);
  await eventually(async () => (await labelsOf('First row')).length === 1);
});
