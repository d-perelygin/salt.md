import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Server-side rewrite vs open tab (#79): the tab picks the rewrite up and
// must not overwrite it with its stale copy — neither through the debounced
// autosave nor through the unmount flush on navigation.
await withFixture(async ({ page, api, base, workspace }) => {
  page.setDefaultTimeout(15000);
  const block = (id, text) => ({
    id, type: 'paragraph', props: {},
    content: [{ type: 'text', text, styles: {} }], children: [],
  });
  const created = await api('POST', '/api/pages', {
    title: 'Rewrite Probe', type: 'doc', workspaceId: workspace.id,
  });
  await api('PATCH', `/api/pages/${created.id}`, { content: [block('v1', 'version one')] });
  await page.goto(`${base}/p/${created.id}`);
  await eventually(async () => (await page.locator('.editor-loading').count()) === 0);
  await page.locator('[data-id="v1"] .bn-inline-content').waitFor();

  // A stale draft typed in the open tab; wait until it is materialized.
  await page.locator('[data-id="v1"] .bn-inline-content').click();
  await page.keyboard.type(' + stale draft');
  await eventually(async () => {
    const got = await api('GET', `/api/pages/${created.id}`);
    return JSON.stringify(got.content).includes('stale draft');
  });

  // An outside rewrite (agent/import path: plain PATCH, no ?materialize=1).
  await api('PATCH', `/api/pages/${created.id}`, { content: [block('v2', 'version two from api')] });

  // The tab picks the rewrite up instead of sitting on the stale copy.
  await eventually(async () => ((await page.locator('body').textContent()) ?? '').includes('version two from api'));

  // Let any debounced autosave fire, then navigate away (unmount flush):
  // the server text must still be the API rewrite.
  await page.waitForTimeout(2500);
  await page.goto(`${base}/`);
  await page.waitForTimeout(1000);
  const after = await api('GET', `/api/pages/${created.id}`);
  assert(JSON.stringify(after.content).includes('version two from api'));
  assert(!JSON.stringify(after.content).includes('stale draft'));

  // And a fresh load renders the rewrite, not the stale draft.
  await page.goto(`${base}/p/${created.id}`);
  await eventually(async () => (await page.locator('.editor-loading').count()) === 0);
  await eventually(async () => ((await page.locator('body').textContent()) ?? '').includes('version two from api'));

  console.log('API rewrite: open tab picks it up and never overwrites it with the stale copy.');
});
