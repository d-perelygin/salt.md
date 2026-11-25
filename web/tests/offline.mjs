import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Offline: opened pages render from snapshots while disconnected, edits made
// offline sync on reconnect (verified in a second clean context), replaced docs
// are never resurrected by stale snapshots, and offline creates/edits/comments
// replay cleanly.
await withFixture(async ({ page, context, api, base, workspace }) => {
  page.setDefaultTimeout(15000);
  const created = await api('POST', '/api/pages', { title: 'Offline Probe', type: 'doc', workspaceId: workspace.id });
  await page.goto(`${base}/p/${created.id}`);
  await eventually(async () => (await page.locator('.editor-loading').count()) === 0);
  // A second online load: the service worker takes control and caches the
  // API snapshots only for requests it sees.
  await page.reload();
  await eventually(async () => (await page.locator('.editor-loading').count()) === 0);

  // Drop the network: the snapshot renders with an offline badge.
  await context.setOffline(true);
  await page.reload();
  await eventually(async () => (await page.locator('.offline-banner').count()) === 1);
  assert((await page.locator('body').textContent()).includes('Offline Probe'));

  // Type rapidly while offline (60 chars, delay 0), come back: CRDT syncs
  // completely and a second clean context sees every character.
  await page.locator('.bn-editor[contenteditable="true"]').first().click();
  const rapidText = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567';
  await page.keyboard.type(rapidText, { delay: 0 });
  await context.setOffline(false);
  await eventually(async () => {
    const got = await api('GET', `/api/pages/${created.id}`);
    return JSON.stringify(got.content ?? got).includes(rapidText);
  });

  const browser = context.browser();
  const cleanCtx = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'en-US' });
  await cleanCtx.setExtraHTTPHeaders({});
  // Share session via storageState from context so cleanCtx has no IDB/SW cache
  const state = await context.storageState();
  const cleanCtx2 = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'en-US', storageState: state });
  const page2 = await cleanCtx2.newPage();
  await page2.goto(`${base}/p/${created.id}`);
  await eventually(async () => (await page2.locator('.bn-editor[contenteditable="true"]').count()) > 0);
  await eventually(async () => (await page2.locator('.bn-editor[contenteditable="true"]').first().innerText()).includes(rapidText));
  await cleanCtx2.close();
  await cleanCtx.close();

  // Stale ydoc must not resurrect old text after a server-side rewrite.
  await page.goto(`${base}/p/${created.id}`);
  await eventually(async () => (await page.locator('.editor-loading').count()) === 0);
  await page.waitForTimeout(1200);
  await api('PATCH', `/api/pages/${created.id}`, {
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AGENT_REWRITE_CLEAN' }] }],
  });
  await page.reload();
  await eventually(async () => (await page.locator('body').textContent()).includes('AGENT_REWRITE_CLEAN'));
  assert(!(await page.locator('.bn-editor[contenteditable="true"]').first().innerText()).includes(rapidText));

  // Offline create + title edit syncs cleanly on reconnect.
  await context.setOffline(true);
  await page.keyboard.press('Alt+n');
  await eventually(async () => page.url().includes('/p/temp-'));
  const titleEl = page.locator('.page-title').first();
  await titleEl.click();
  await titleEl.fill('Offline Created Title');
  await titleEl.press('Enter');
  await titleEl.blur();
  await page.waitForTimeout(700);
  await context.setOffline(false);
  await eventually(async () => !page.url().includes('/p/temp-') && page.url().includes('/p/'));
  await eventually(async () => {
    const pages = await api('GET', '/api/pages');
    return pages.some((p) => p.title === 'Offline Created Title');
  });

  console.log('Offline: snapshots, rapid CRDT sync, docGen fence, and offline create passed.');
});
