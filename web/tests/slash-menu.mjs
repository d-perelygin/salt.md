import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// The slash menu keys its headings by group, and our own entries came after
// BlockNote's, so a group could appear twice: "Basic blocks" three times on
// 1.1.1, and after typing "ch" and clearing it, headings that were left behind.
// Each group is one run of entries now, in the order it first appears.
await withFixture(async ({ page, api, base, workspace }) => {
  page.setDefaultTimeout(15000);
  const doc = await api('POST', '/api/pages', { title: 'Slash', workspaceId: workspace.id });
  await api('PATCH', `/api/pages/${doc.id}`, { content: [{ id: 'intro', type: 'paragraph', props: {}, content: [], children: [] }] });
  await page.goto(`${base}/p/${doc.id}`);
  await page.locator('[data-id="intro"] .bn-inline-content').click();
  await page.keyboard.type('/');
  const menu = page.locator('.bn-suggestion-menu');
  await menu.waitFor();
  const headings = () => menu.locator('.bn-suggestion-menu-label').allTextContents();
  const unique = (list) => new Set(list).size === list.length;

  const full = await headings();
  assert.ok(full.length > 1, `no groups at all: ${full}`);
  assert.ok(unique(full), `a group heading repeats: ${full}`);
  await page.keyboard.type('ch');
  await page.waitForTimeout(400);
  assert.ok(unique(await headings()), 'a heading repeats while filtering');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
  assert.deepEqual(await headings(), full, 'clearing the query left other headings than before');
});

// /page creates a sub-page from the text: the child opens under the current
// page with its title ready to type, in the same workspace and with the same
// permissions as one made from the sidebar (#133). The listing block keeps its
// own entry, and a refusal stays visible on the parent.
await withFixture(async ({ page, api, base, workspace }) => {
  page.setDefaultTimeout(15000);
  const parent = await api('POST', '/api/pages', { title: 'Parent document', workspaceId: workspace.id });
  const paragraphs = (id, text) => ({
    id,
    type: 'paragraph',
    props: {},
    content: text ? [{ type: 'text', text, styles: {} }] : [],
    children: [],
  });
  await api('PATCH', `/api/pages/${parent.id}`, {
    content: [paragraphs('notes', 'Keep these notes'), paragraphs('command', '')],
  });
  const creates = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/pages') creates.push(request.postDataJSON());
  });
  const openCommand = async () => {
    await page.goto(`${base}/p/${parent.id}`);
    await page.locator('[data-id="command"] .bn-inline-content').click();
    await page.keyboard.type('/page');
    const menu = page.locator('.bn-suggestion-menu');
    await menu.getByText('Create a subpage', { exact: true }).waitFor();
    assert.equal(await menu.getByText('Sub-pages', { exact: true }).count(), 1, 'the Sub-pages entry must remain');
  };

  await openCommand();
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/pages'),
    page.keyboard.press('Enter'),
  ]);
  const child = await created.json();
  await eventually(async () => page.url() !== `${base}/p/${parent.id}`);
  const fetched = await api('GET', `/api/pages/${child.id}`);
  assert.equal(fetched.parentId, parent.id);
  assert.equal(fetched.workspaceId, workspace.id);
  assert.equal(fetched.type, 'doc');
  // The new page is made to be named: the title has the focus.
  await eventually(() => page.evaluate(() => !!document.activeElement?.closest('.page-title')));
  await page.keyboard.type('Child of the parent');
  await eventually(async () => (await api('GET', `/api/pages/${child.id}`)).title === 'Child of the parent');
  await page.reload();
  assert.equal(await page.locator('.page-title').inputValue(), 'Child of the parent');

  // One selection, one child, and the parent's own text is still its own.
  await page.goto(`${base}/p/${parent.id}`);
  await eventually(async () => (await page.locator('[data-id="notes"] .bn-inline-content').textContent()) === 'Keep these notes');
  assert.equal(creates.filter((request) => request.parentId === parent.id).length, 1);

  // A refusal is visible, and leaves the person and their notes where they were.
  const before = (await api('GET', '/api/pages')).length;
  await page.route('**/api/pages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Page creation denied for test' }) });
  });
  await openCommand();
  await page.keyboard.press('Enter');
  await page.locator('.toast').filter({ hasText: 'Page creation denied for test' }).waitFor();
  assert.ok(page.url().endsWith(parent.id), `left the parent: ${page.url()}`);
  assert.equal((await api('GET', '/api/pages')).length, before);
});
