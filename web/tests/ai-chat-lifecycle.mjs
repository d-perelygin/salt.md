import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { eventually, withFixture } from './fixture.mjs';

// Opening, closing and reloading a chat: the three things a reader does all
// day, and the places a chat surface tends to lose its place.
await withFixture(async ({ page, context, api, base, workspace, dataDir }) => {
  page.setDefaultTimeout(15000);
  const doc = await api('POST', '/api/pages', { title: 'Chat host', type: 'doc', workspaceId: workspace.id });
  const alpha = await api('POST', '/api/ai/threads', { pageId: doc.id, title: 'Alpha' });
  const beta = await api('POST', '/api/ai/threads', { pageId: doc.id, title: 'Beta' });

  // Messages are written by a model that is not configured in a test; seed
  // the history where it lives.
  const long = ('A long answer that wraps over several lines and makes the thread taller than the panel. ').repeat(6).trim();
  const q = (v) => "'" + v.replace(/'/g, "''") + "'";
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const body = i % 2 ? `ALPHA ANSWER ${i}. ${long}` : `alpha question ${i}`;
    rows.push(`INSERT INTO ai_messages (id, thread_id, role, content, created_at)
      VALUES ('a${i}', ${q(alpha.id)}, '${i % 2 ? 'assistant' : 'user'}', ${q(body)}, '2026-01-01T00:${String(i).padStart(2, '0')}:00Z');`);
  }
  rows.push(`INSERT INTO ai_messages (id, thread_id, role, content, created_at)
    VALUES ('b1', ${q(beta.id)}, 'user', 'BETA QUESTION', '2026-02-01T10:00:00Z');`);
  rows.push(`INSERT INTO ai_messages (id, thread_id, role, content, created_at)
    VALUES ('b2', ${q(beta.id)}, 'assistant', 'BETA ANSWER', '2026-02-01T10:01:00Z');`);
  rows.push(`UPDATE ai_threads SET updated_at = '2026-02-01T10:01:00Z', last_read_at = '' WHERE id = ${q(beta.id)};`);
  const seeded = spawnSync('sqlite3', [join(dataDir, 'salt.db'), rows.join('\n')], { encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr || 'sqlite3 is needed to seed chat history');

  const unread = async () => {
    const list = await api('GET', '/api/ai/threads');
    const th = list.find((x) => x.id === beta.id);
    return th.msgCount > 0 && th.lastRole === 'assistant' && (!th.lastReadAt || th.updatedAt > th.lastReadAt);
  };
  const markUnread = () => {
    const r = spawnSync('sqlite3', [join(dataDir, 'salt.db'), `UPDATE ai_threads SET last_read_at = '' WHERE id = '${beta.id}';`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const panelMsgs = () => page.locator('.ai-panel .ai-msg');
  const panelBody = () => page.locator('.ai-panel-body');
  const bodyScroll = (locator) => locator.evaluate((el) => ({
    top: Math.round(el.scrollTop),
    max: el.scrollHeight - el.clientHeight,
    atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 4,
  }));

  await page.goto(`${base}/p/${doc.id}`);
  await page.locator('.ai-fab').click();
  const switcher = page.locator('.ai-panel-chat-switcher');
  await switcher.waitFor();
  await switcher.click();
  await page.locator('.ai-panel .menu button', { hasText: 'Alpha' }).click();
  await eventually(async () => (await panelMsgs().count()) === 20);
  assert.equal((await bodyScroll(panelBody())).atBottom, true, 'a thread opens at its end');

  // A thread switch must not show the previous conversation under the new
  // name, even when the new one is slow to answer.
  await page.route(`**/api/ai/threads/${beta.id}/messages`, async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await switcher.click();
  await page.locator('.ai-panel .menu button', { hasText: 'Beta' }).click();
  await page.waitForTimeout(250);
  const during = await panelMsgs().allInnerTexts();
  console.log('DEBUG during', during.length, JSON.stringify(during.map((x) => x.slice(0, 24))), 'title', await switcher.innerText());
  assert.equal(during.length, 0, `the previous thread stayed on screen: ${during[0] ?? ''}`);
  await eventually(async () => (await panelMsgs().count()) === 2);
  assert.match(await panelMsgs().first().innerText(), /BETA QUESTION/);
  assert.equal(await unread(), false, 'opening a chat in the side panel marks it read');
  await page.unroute(`**/api/ai/threads/${beta.id}/messages`);

  // Closing and reopening the panel keeps the thread; a reload does too, and
  // neither waits for a slow scroll through the whole history.
  await page.locator('.ai-panel button[title="Close"]').click();
  await eventually(async () => (await page.locator('.ai-panel').isVisible()) === false);
  await page.locator('.ai-fab').click();
  await eventually(async () => (await panelMsgs().count()) === 2);
  await switcher.click();
  await page.locator('.ai-panel .menu button', { hasText: 'Alpha' }).click();
  await eventually(async () => (await panelMsgs().count()) === 20);
  await page.reload();
  await eventually(async () => (await panelMsgs().count()) === 20);
  await page.waitForTimeout(120);
  assert.equal((await bodyScroll(panelBody())).atBottom, true, 'a reload lands at the end at once');
  assert.match(await switcher.innerText(), /Alpha/);

  // One conversation, one draft: the prompt typed in the panel is the prompt
  // the full chat has.
  await page.locator('.ai-panel textarea').fill('draft across surfaces');
  await page.waitForTimeout(300);
  await page.goto(`${base}/?chat=${alpha.id}`);
  const viewInput = page.locator('.ai-chat-main textarea');
  await eventually(async () => (await viewInput.inputValue()) === 'draft across surfaces');
  await viewInput.fill('draft back again');
  await page.waitForTimeout(300);
  await page.goto(`${base}/p/${doc.id}`);
  await eventually(async () => (await page.locator('.ai-panel').isVisible()) === true);
  await eventually(async () => (await page.locator('.ai-panel textarea').inputValue()) === 'draft back again');

  // The unread dot: a chat opened in the panel is read, one left behind while
  // the panel is shut is not. (The messages were fetched with the thread, so
  // the server's own marker is the thing to check.)
  markUnread();
  await switcher.click();
  await page.locator('.ai-panel .menu button', { hasText: 'Beta' }).click();
  await eventually(async () => (await unread()) === false);
  markUnread();
  await page.locator('.ai-panel button[title="Close"]').click();
  await eventually(async () => (await page.locator('.ai-panel').isVisible()) === false);
  await page.reload();
  await page.waitForTimeout(1200);
  assert.equal(await unread(), true, 'a chat nobody opened came back read');

  console.log('AI chat: panel reopen, reload, thread switch, read marker and shared draft passed.');
});
