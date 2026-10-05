import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('一覧を展開せず、画像の右へ情報を表で並べ、日付境界も日本時間にする', () => {
  const nodes = [];
  const element = tag => {
    const node = { tag, children: [], events: {}, append(...children) { this.children.push(...children); }, setAttribute() {}, addEventListener(event, handler) { this.events[event] = handler; } };
    nodes.push(node);
    return node;
  };
  // 読み込み時にプロジェクト一覧を取りに行く。応答は返さず、行の組み立てだけを見る。
  const context = vm.createContext({ Intl, Date, URLSearchParams, location: { search: '' }, fetch: () => new Promise(() => {}), document: {
    querySelector: () => element('control'), createElement: element, getElementById: () => null
  } });
  vm.runInContext(readFileSync('public/admin.js', 'utf8'), context);
  assert.equal(vm.runInContext("japanTime('2026-09-23T15:00:00Z')", context), '2026/09/24 00:00:00 日本時間');
  vm.runInContext(`showRow(saveEntry({save_id:'test',user_id:'user',revision:1,updated_at:'2026-09-23T12:51:50Z',screenshot:{url:'https://drop.tsukumistudio.com/image.jpg',captured_at:'2026-09-23T12:51:50Z'}}))`, context);
  const summary = nodes.find(node => node.tag === 'summary');
  const preview = summary.children.find(node => node.className === 'screenshot');
  assert.equal(preview.children.find(node => node.tag === 'img').src, 'https://drop.tsukumistudio.com/image.jpg');
  const table = summary.children.find(node => node.tag === 'table');
  const cells = Object.fromEntries(table.children.map(tr => [tr.children[0].textContent, tr.children[1]]));
  assert.deepEqual(Object.keys(cells), ['Save ID', 'User ID', 'Revision', '更新', '撮影']);
  assert.equal(cells['Save ID'].textContent, 'test');
  // User ID は履歴へ移る釦になっている。
  assert.equal(cells['User ID'].children[0].tag, 'button');
  assert.equal(cells['User ID'].children[0].textContent, 'user');
  assert.equal(cells['更新'].textContent, '2026/09/23 21:51:50 日本時間');
  assert.equal(cells['撮影'].children[0].textContent, '2026/09/23 21:51:50 日本時間');
  assert.equal(summary.children.indexOf(preview), 0);
  assert.equal(nodes.find(node => node.tag === 'details').open, undefined);
});
