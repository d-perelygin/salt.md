import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// What a reader gets when somebody sends them a link: the shared document, the
// shared collection, a dead address, and one behind a password. Opening a link
// is a pure browser journey — no session, no app state — so it is checked in a
// fresh context, and a blank page there is a failure even when every API
// answers 200.
await withFixture(async ({ context, api, base, workspace, collection }) => {
  const doc = await api('POST', '/api/pages', { title: 'Quarterly notes', type: 'doc', workspaceId: workspace.id });
  await api('PATCH', `/api/pages/${doc.id}`, {
    content: [{ id: 'p1', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Numbers for the quarter', styles: {} }], children: [] }],
  });

  const open = async (url) => {
    const ctx = await context.browser().newContext({ viewport: { width: 1200, height: 900 }, locale: 'en-US' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const response = await page.goto(url, { waitUntil: 'load' });
    return { page, ctx, response, errors };
  };

  const shared = await api('POST', `/api/pages/${doc.id}/share`, { expiresInDays: 0 });
  {
    const { page, ctx, response, errors } = await open(shared.url);
    assert.equal(response.status(), 200);
    await page.getByRole('heading', { name: 'Quarterly notes' }).waitFor();
    await page.getByText('Numbers for the quarter', { exact: true }).waitFor();
    assert.deepEqual(errors, [], 'the reader page threw');
    assert.ok((await page.locator('body').innerText()).trim().length > 0, 'the reader page came up blank');
    await ctx.close();
  }

  // A collection link shows its views and rows, not just a title.
  const sharedCollection = await api('POST', `/api/pages/${collection.id}/share`, { expiresInDays: 0 });
  {
    const { page, ctx, errors } = await open(sharedCollection.url);
    await page.getByText(collection.title, { exact: false }).first().waitFor();
    await eventually(async () => (await page.getByText('First row', { exact: false }).count()) > 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // A link that was replaced or revoked says so instead of showing nothing.
  {
    const { page, ctx } = await open(`${base}/public/00000000000000000000000000000000`);
    await page.getByText('This link is invalid or has expired.', { exact: true }).waitFor();
    await ctx.close();
  }

  // A password-protected link asks first, then opens the same document.
  const guarded = await api('POST', `/api/pages/${doc.id}/share`, { expiresInDays: 0, password: 'correct horse' });
  {
    const { page, ctx, errors } = await open(guarded.url);
    const field = page.locator('input[type=password]');
    await field.waitFor();
    await field.fill('correct horse');
    await page.locator('button[type=submit], button').filter({ hasText: /open|view|continue/i }).first().click();
    await page.getByText('Numbers for the quarter', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  console.log('Public share: a document, a collection, a dead link and a password open outside the app.');
});
