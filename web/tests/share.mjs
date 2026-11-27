import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Sharing a page, from both sides: the person who mints the link (opening the
// dialog must not publish, a password must not rotate the link, stopping must
// end it) and the reader who opens it with no session at all (document,
// collection, dead address, password). One server for both.
await withFixture(async ({ page, context, api, base, workspace, collection }) => {
  page.setDefaultTimeout(15000);

  // --- minting the link -----------------------------------------------------
  // #68: looking at a page's sharing state must not publish it. The globe used
  // to create a link the moment its menu opened, so checking whether Stop
  // sharing had worked published the page again under a fresh address.
  {
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

    // A password applies to the link that is already on screen; it must not
    // mint a new address behind the reader's back.
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
  }

  // --- opening the link -----------------------------------------------------
  // What a reader gets: the shared document, the shared collection, a dead
  // address, and one behind a password. Opening a link is a pure browser
  // journey — no session, no app state — so it is checked in a fresh context,
  // and a blank page there is a failure even when every API answers 200.
  {
    const doc = await api('POST', '/api/pages', { title: 'Public notes', type: 'doc', workspaceId: workspace.id });
    await api('PATCH', `/api/pages/${doc.id}`, {
      content: [{ id: 'p1', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Numbers for the quarter', styles: {} }], children: [] }],
    });

    const open = async (url) => {
      const ctx = await context.browser().newContext({ viewport: { width: 1200, height: 900 }, locale: 'en-US' });
      const reader = await ctx.newPage();
      reader.setDefaultTimeout(15000);
      const errors = [];
      reader.on('pageerror', (e) => errors.push(e.message));
      const response = await reader.goto(url, { waitUntil: 'load' });
      return { reader, ctx, response, errors };
    };

    const shared = await api('POST', `/api/pages/${doc.id}/share`, { expiresInDays: 0 });
    {
      const { reader, ctx, response, errors } = await open(shared.url);
      assert.equal(response.status(), 200);
      await reader.getByRole('heading', { name: 'Public notes' }).waitFor();
      await reader.getByText('Numbers for the quarter', { exact: true }).waitFor();
      assert.deepEqual(errors, [], 'the reader page threw');
      assert.ok((await reader.locator('body').innerText()).trim().length > 0, 'the reader page came up blank');
      await ctx.close();
    }

    // A collection link shows its views and rows, not just a title.
    const sharedCollection = await api('POST', `/api/pages/${collection.id}/share`, { expiresInDays: 0 });
    {
      const { reader, ctx, errors } = await open(sharedCollection.url);
      await reader.getByText(collection.title, { exact: false }).first().waitFor();
      await eventually(async () => (await reader.getByText('First row', { exact: false }).count()) > 0);
      assert.deepEqual(errors, []);
      await ctx.close();
    }

    // A link that was replaced or revoked says so instead of showing nothing.
    {
      const { reader, ctx } = await open(`${base}/public/00000000000000000000000000000000`);
      await reader.getByText('This link is invalid or has expired.', { exact: true }).waitFor();
      await ctx.close();
    }

    // A password-protected link asks first, then opens the same document.
    const guarded = await api('POST', `/api/pages/${doc.id}/share`, { expiresInDays: 0, password: 'correct horse' });
    {
      const { reader, ctx, errors } = await open(guarded.url);
      const field = reader.locator('input[type=password]');
      await field.waitFor();
      await field.fill('correct horse');
      await reader.locator('button[type=submit], button').filter({ hasText: /open|view|continue/i }).first().click();
      await reader.getByText('Numbers for the quarter', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }

  console.log('Share: minting does not publish behind your back, and the link opens for a reader.');
});
