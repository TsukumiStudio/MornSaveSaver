const status = document.querySelector('#status');
const items = document.querySelector('#items');
const more = document.querySelector('#more');
const projectInput = document.querySelector('#project');
const searchForm = document.querySelector('#search');
const historyBar = document.querySelector('#history-bar');
const historyTitle = document.querySelector('#history-title');
const params = new URLSearchParams(location.search);
let project = params.get('project_id') || '';
// 履歴を見ているユーザー。空なら一覧を見ている。
let historyUser = params.get('user_id') || '';
let cursor = null;

async function api(path) {
  let res;
  try { res = await fetch(path); }
  catch { const error = new Error('Cloudflare Accessの認証を確認してください。'); error.access = true; throw error; }
  const contentType = res.headers.get('content-type') || '';
  if (res.status === 401 || res.status === 403 || res.redirected || !contentType.includes('application/json')) {
    const error = new Error('Cloudflare Accessの認証を確認してください。');
    error.access = true;
    throw error;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
function report(error) {
  status.replaceChildren(document.createTextNode(error.message));
  if (error.access) {
    const link = document.createElement('a');
    link.href = '/admin/';
    link.textContent = '再認証';
    status.append(' ', link);
  }
}
function renderFields(value, parent) {
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && typeof child === 'object') {
      const group = document.createElement('details');
      const title = document.createElement('summary');
      title.textContent = `${key} (${Object.keys(child).length})`;
      const children = document.createElement('div');
      children.className = 'fields';
      renderFields(child, children);
      group.append(title, children);
      parent.append(group);
    } else {
      const field = document.createElement('div');
      field.className = 'field';
      const label = document.createElement('strong');
      label.textContent = key;
      const text = document.createElement('span');
      text.textContent = JSON.stringify(child);
      field.append(label, text);
      parent.append(field);
    }
  }
}
function japanTime(value) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(new Date(value)) + ' 日本時間';
}
function cell(value) {
  const td = document.createElement('td');
  if (typeof value === 'string') td.textContent = value; else td.append(value);
  return td;
}
// 1件の行。高さは画像の高さに揃え、画像以外の情報は右の表へ並べる。開くとJSONの中身を出す。
function showRow(entry) {
  const li = document.createElement('li');
  const group = document.createElement('details');
  group.className = 'save-group';
  const summary = document.createElement('summary');
  const download = document.createElement('button');
  download.type = 'button';
  download.textContent = 'JSONで保存';
  const fields = document.createElement('div');
  fields.className = 'fields';
  fields.setAttribute('aria-live', 'polite');
  const screenshot = document.createElement('span');
  screenshot.className = 'screenshot';
  let captured = '—';
  if (entry.screenshot) {
    const image = document.createElement('img');
    image.src = entry.screenshot.url;
    image.alt = '添付スクリーンショット';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    const state = document.createElement('span');
    state.textContent = '画像を読み込み中…';
    image.addEventListener('load', () => state.remove(), { once: true });
    image.addEventListener('error', () => { image.hidden = true; state.textContent = '画像を表示できません'; }, { once: true });
    screenshot.append(image, state);
    captured = document.createElement('time');
    captured.dateTime = entry.screenshot.captured_at;
    captured.textContent = japanTime(entry.screenshot.captured_at);
  } else {
    screenshot.textContent = '画像なし';
  }
  const table = document.createElement('table');
  table.className = 'save-info';
  for (const [name, value] of [...entry.cells, ['撮影', captured]]) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = name;
    tr.append(th, cell(value));
    table.append(tr);
  }
  let pending;
  let save = null;
  async function getSave() {
    if (save) return save;
    pending ??= api(entry.path);
    try { save = await pending; return save; }
    finally { pending = null; }
  }
  let rendered = false;
  group.addEventListener('toggle', async () => {
    if (!group.open || rendered) return;
    fields.textContent = '読み込み中…';
    try {
      const result = await getSave();
      fields.replaceChildren();
      renderFields(result.data, fields);
      if (!fields.childElementCount) fields.textContent = '{}';
      rendered = true;
    } catch (error) { fields.textContent = error.message; report(error); }
  });
  download.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    download.disabled = true;
    try {
      const result = await getSave();
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = entry.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { report(error); }
    finally { download.disabled = false; }
  });
  summary.append(screenshot, table, download);
  group.append(summary, fields);
  li.append(group);
  items.append(li);
  return group;
}
function saveEntry(row) {
  // User ID を押すと、そのユーザーの保存の履歴へ移る。
  const user = document.createElement('button');
  user.type = 'button';
  user.className = 'link';
  user.textContent = row.user_id;
  user.title = 'このユーザーの保存の履歴を見る';
  user.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openHistory(row.user_id); });
  return {
    screenshot: row.screenshot,
    cells: [['Save ID', row.save_id], ['User ID', user], ['Revision', String(row.revision)], ['更新', japanTime(row.updated_at)]],
    path: `/v1/admin/saves/${encodeURIComponent(row.save_id)}`,
    filename: `${row.save_id}.json`
  };
}
function historyEntry(row, owner) {
  return {
    screenshot: row.screenshot,
    cells: [['Revision', String(row.revision)], ['保存', japanTime(row.saved_at)]],
    path: `/v1/admin/users/${encodeURIComponent(owner.user_id)}/history/${row.revision}`,
    filename: `${owner.save_id}-r${row.revision}.json`
  };
}
function showView() {
  searchForm.hidden = Boolean(historyUser);
  historyBar.hidden = !historyUser;
  historyTitle.textContent = historyUser ? `User ${historyUser} の保存の履歴（新しい順・直近300件）` : '';
  const q = historyUser ? { project_id: project, user_id: historyUser } : { project_id: project };
  window.history.replaceState(null, '', `?${new URLSearchParams(q)}`);
  loadPage(true);
}
function openHistory(userId) { historyUser = userId; showView(); }
async function loadPage(reset = false) {
  if (reset) { cursor = null; items.replaceChildren(); }
  status.textContent = '読み込み中…';
  try {
    if (historyUser) {
      const q = cursor ? `?${new URLSearchParams({ cursor })}` : '';
      const result = await api(`/v1/admin/users/${encodeURIComponent(historyUser)}/history${q}`);
      result.items.forEach(row => showRow(historyEntry(row, result)));
      cursor = result.next_cursor;
    } else {
      const q = new URLSearchParams({ project_id: project });
      if (cursor) q.set('cursor', cursor);
      const result = await api(`/v1/admin/saves?${q}`);
      result.items.forEach(row => showRow(saveEntry(row)));
      cursor = result.next_cursor;
    }
    more.hidden = !cursor;
    status.textContent = `${items.children.length}件を表示しました。`;
  } catch (error) { report(error); }
}
async function loadProjects() {
  try {
    const result = await api('/v1/admin/projects');
    const options = result.items.map(item => {
      const option = document.createElement('option');
      option.value = item.project_id;
      option.textContent = `${item.project_id}（${item.saves}件）`;
      return option;
    });
    projectInput.replaceChildren(...options);
    if (!result.items.some(item => item.project_id === project)) project = result.items[0]?.project_id || '';
    projectInput.value = project;
    if (project || historyUser) showView(); else status.textContent = 'セーブのあるプロジェクトがありません。';
  } catch (error) { report(error); }
}
projectInput.addEventListener('change', () => { project = projectInput.value; showView(); });
document.querySelector('#back').addEventListener('click', () => { historyUser = ''; showView(); });
more.addEventListener('click', () => loadPage(false));
loadProjects();
