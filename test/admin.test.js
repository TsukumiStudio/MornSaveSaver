import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('一覧を展開せず画像を表示し、日付境界も日本時間にする', () => {
  const nodes = [];
  const element = tag => {
    const node = { tag, children: [], events: {}, append(...children) { this.children.push(...children); }, setAttribute() {}, addEventListener(event, handler) { this.events[event] = handler; } };
    nodes.push(node);
    return node;
  };
  const context = vm.createContext({ Intl, Date, URLSearchParams, location: { search: '' }, document: {
    querySelector: () => element('control'), createElement: element, getElementById: () => null
  } });
  vm.runInContext(readFileSync('public/admin.js', 'utf8'), context);
  assert.equal(vm.runInContext("japanTime('2026-09-23T15:00:00Z')", context), '2026/09/24 00:00:00 日本時間');
  vm.runInContext(`showRow({save_id:'test',user_id:'user',revision:1,updated_at:'2026-09-23T12:51:50Z',screenshot:{url:'https://drop.tsukumistudio.com/image.jpg',captured_at:'2026-09-23T12:51:50Z'}})`, context);
  const summary = nodes.find(node => node.tag === 'summary');
  const preview = summary.children.find(node => node.className === 'screenshot');
  assert.equal(preview.children.find(node => node.tag === 'img').src, 'https://drop.tsukumistudio.com/image.jpg');
  assert.equal(preview.children.find(node => node.tag === 'time').textContent, '撮影: 2026/09/23 21:51:50 日本時間');
  assert.equal(nodes.find(node => node.tag === 'details').open, undefined);
});
