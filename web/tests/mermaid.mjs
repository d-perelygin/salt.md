import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// Opening a page used to draw every diagram again and write the result back
// into the block. Mermaid's output differs from the stored string often
// enough that the write was not a no-op, so a plain read bumped the page's
// last-edited time and two people reading the same page traded updates nobody
// had made (#136). The stored picture is used as long as its source and the
// renderer generation are unchanged.
await withFixture(async ({ page, api, base, workspace }) => {
  page.setDefaultTimeout(20000);
  const doc = await api('POST', '/api/pages', { title: 'Diagrams', workspaceId: workspace.id });
  await api('PATCH', `/api/pages/${doc.id}`, {
    content: [
      {
        id: 'dia',
        type: 'mermaid',
        props: { code: 'graph TD\n  A --> B', svg: '', rev: 0 },
        content: [],
        children: [],
      },
    ],
  });
  const stored = async () => {
    const p = await api('GET', `/api/pages/${doc.id}`);
    const block = (p.content ?? []).find((b) => b.id === 'dia');
    return { page: p, svg: block?.props?.svg ?? '' };
  };

  await page.goto(`${base}/p/${doc.id}`);
  // The first open has nothing to show and draws the picture, then stores it.
  await eventually(async () => (await stored()).svg !== '');
  await page.locator('.bn-mermaid img').waitFor();
  const first = await stored();

  // A second open finds the picture from the current renderer and does no
  // work: nothing is written, so the page's last-edited time stays put.
  await page.reload();
  await page.locator('.bn-mermaid img').waitFor();
  // Long enough for a render that would have happened to land.
  await page.waitForTimeout(1500);
  const second = await stored();
  assert.equal(second.svg, first.svg, 'the stored picture was replaced by an identical read');
  assert.equal(second.page.updatedAt, first.page.updatedAt, 'opening the page bumped its last-edited time');

  console.log('Mermaid: the first open draws and stores, the second writes nothing.');
});
