import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// A tab keeps where it was scrolled (#62). Switching away within two seconds
// of scrolling lost it: the editor's cleanup read scrollTop from the page body
// React had already taken out of the document, which reads 0, and saved that
// over the good value.
await withFixture(async ({ page, api, base, workspace }) => {
  page.setDefaultTimeout(15000);
  const long = await api('POST', '/api/pages', { title: 'Long read', workspaceId: workspace.id });
  await api('PATCH', `/api/pages/${long.id}`, {
    content: Array.from({ length: 300 }, (_, i) => ({
      id: `p${i}`, type: 'paragraph', props: {},
      content: [{ type: 'text', text: `Line ${i + 1}`, styles: {} }], children: [],
    })),
  });
  await api('POST', '/api/pages', { title: 'Other page', workspaceId: workspace.id });

  await page.goto(`${base}/p/${long.id}`);
  await page.locator('.bn-block-outer[data-id="p0"]').waitFor();
  const tabs = page.locator('.tab-bar .tab');
  await page.locator('.sidebar').getByText('Other page', { exact: true }).click({ modifiers: ['Meta'] });
  await eventually(async () => (await tabs.filter({ hasText: 'Other page' }).count()) === 1);
  await tabs.filter({ hasText: 'Long read' }).click();
  await page.locator('.bn-block-outer[data-id="p0"]').waitFor();

  // Scrolled by wheel, which is a gesture: the memory keeps only those.
  const body = page.locator('.page-body');
  const top = () => body.evaluate((el) => el.scrollTop);
  await body.hover();
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
  await eventually(async () => (await top()) >= 2000);
  const was = await top();

  // Away at once, then back: the position comes back with the tab.
  await tabs.filter({ hasText: 'Other page' }).click();
  await eventually(async () => (await page.locator('.bn-block-outer[data-id="p0"]').count()) === 0);
  await tabs.filter({ hasText: 'Long read' }).click();
  await page.locator('.bn-block-outer[data-id="p0"]').waitFor({ state: 'attached' });
  await eventually(async () => Math.abs((await top()) - was) < 5);
  assert(Math.abs((await top()) - was) < 5);

  console.log(`Scroll memory: back at ${await top()} after switching away right after scrolling to ${was}.`);
});
