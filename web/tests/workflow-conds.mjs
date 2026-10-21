import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Workflow value conditions: sister rules split one transition by a row
// value. A bug moved to Done is asked for its note; a task moves silently;
// anything else is refused, naming the value it needs.
await withFixture(async ({ page, api, base, path }) => {
  page.setDefaultTimeout(15000);
  const collectionId = path.split('/').pop();
  await api('PUT', path, {
    schema: [
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 'a', name: 'A' }, { id: 'done', name: 'Done' }] },
      { id: 'kind', name: 'Kind', type: 'select', options: [{ id: 'bug', name: 'Bug' }, { id: 'task', name: 'Task' }, { id: 'other', name: 'Other' }] },
      { id: 'note', name: 'Note', type: 'text' },
    ],
    views: [{ id: 'table', name: 'Table', type: 'table' }],
    workflow: { statusPropId: 'status', rules: [
      { id: 'r1', when: { type: 'status_to', to: 'done' }, whenProps: [{ prop: 'kind', op: 'is', value: 'bug' }], do: [{ type: 'require_prop', prop: 'note', mode: 'if_empty' }] },
      { id: 'r2', when: { type: 'status_to', to: 'done' }, whenProps: [{ prop: 'kind', op: 'is', value: 'task' }], do: [] },
    ] },
  });
  await api('POST', '/api/pages', { parentId: collectionId, title: 'BugRow', props: { status: 'a', kind: 'bug' } });
  await api('POST', '/api/pages', { parentId: collectionId, title: 'TaskRow', props: { status: 'a', kind: 'task' } });
  await api('POST', '/api/pages', { parentId: collectionId, title: 'OtherRow', props: { status: 'a', kind: 'other' } });
  const statusOf = async (title) =>
    (await api('GET', `/api/collections/${collectionId}/rows?limit=100`)).rows.find((r) => r.title === title).props.status;

  await page.goto(`${base}/p/${collectionId}`);
  await page.locator('tr', { hasText: 'BugRow' }).waitFor();
  const setStatus = async (title, opt) => {
    await page.locator('tr', { hasText: title }).locator('.select-cell-value').first().click();
    await page.locator('.select-menu').waitFor();
    await page.locator('.select-menu').getByRole('button', { name: opt, exact: true }).click();
    await page.waitForTimeout(1000);
  };
  const dlg = page.locator('.dialog, [role=dialog], .modal');

  // A bug is asked for its note; answering lands the move with the note saved.
  await setStatus('BugRow', 'Done');
  await dlg.first().waitFor();
  assert.match(await dlg.first().innerText(), /Note/);
  await dlg.first().locator('input, textarea').first().fill('repro steps');
  await dlg.first().getByRole('button', { name: /Move card|Move|Save|OK/ }).click();
  await eventually(async () => (await statusOf('BugRow')) === 'done');

  // A task takes the sister rule: no dialog, the move just lands.
  await setStatus('TaskRow', 'Done');
  await eventually(async () => (await statusOf('TaskRow')) === 'done');
  assert.equal(await dlg.count(), 0);

  // Anything else matches no rule: refused, naming the value it needs.
  await setStatus('OtherRow', 'Done');
  await eventually(async () => (await page.locator('.toaster, .toast').count()) >= 1);
  assert.match(await page.locator('.toaster, .toast').first().innerText(), /Kind.*Bug/);
  assert.equal(await statusOf('OtherRow'), 'a');

  console.log('Workflow value conditions: bug asks, task passes, other is refused with the reason.');
});
