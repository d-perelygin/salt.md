import assert from 'node:assert/strict';
import { withFixture } from './fixture.mjs';

// An installed window has no browser reload button, and after a phone sleeps
// the live connection can be dead without ever saying so. The page menu
// carries the way out: refetch what is on screen and open a fresh stream,
// without reloading the window. It used to be a pull gesture, which could get
// stuck mid-pull and leave the dial on screen while swallowing every touch.
const installed = () => {
  // The fixture runs in an ordinary tab, where the item is deliberately
  // absent. Report the window as installed before the app boots.
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const mql = real(query);
    if (!query.includes('display-mode: standalone')) return mql;
    return {
      media: query,
      matches: true,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  };
  const w = window;
  w.__boots = (w.__boots ?? 0) + 1;
  w.__refreshes = 0;
  window.addEventListener('salt:refresh', () => {
    w.__refreshes += 1;
  });
};

await withFixture(async ({ page, api, base, workspace }) => {
  page.setDefaultTimeout(15000);
  const doc = await api('POST', '/api/pages', { title: 'Refresh menu', workspaceId: workspace.id });
  await page.addInitScript(installed);
  await page.goto(`${base}/p/${doc.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  const menu = page.locator('.overflow-menu');
  await menu.waitFor();
  const item = menu.getByRole('button', { name: 'Refresh data', exact: true });
  await item.waitFor();

  // Beside the page's own actions, between Duplicate and Import: it belongs
  // with them rather than among the export entries, and never right under the
  // thumb at the top where the first entries live.
  const labels = await menu
    .locator('.menu-item')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
  const at = labels.indexOf('Refresh data');
  assert.ok(at > 0, 'the entry is in the menu');
  assert.equal(labels[at - 1], 'Duplicate', 'Refresh data follows Duplicate');
  assert.equal(labels[at + 1], 'Import (.md / .zip)', 'and precedes Import');

  await item.click();
  await page.waitForFunction(() => window.__refreshes >= 1);
  assert.equal(await page.evaluate(() => window.__refreshes), 1, 'one soft refresh, not two');
  assert.equal(await page.evaluate(() => window.__boots), 1, 'the window was not reloaded');
  assert.equal(await menu.count(), 0, 'the menu closes behind the choice');
});

await withFixture(async ({ page, api, base, workspace }) => {
  page.setDefaultTimeout(15000);
  const doc = await api('POST', '/api/pages', { title: 'Browser tab menu', workspaceId: workspace.id });
  await page.goto(`${base}/p/${doc.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.locator('.overflow-menu').waitFor();
  assert.equal(
    await page.locator('.overflow-menu').getByRole('button', { name: 'Refresh data', exact: true }).count(),
    0,
    'a browser tab already has a reload button',
  );
});
