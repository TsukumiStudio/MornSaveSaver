const login = document.querySelector('#login');
const browser = document.querySelector('#browser');
const tokenInput = document.querySelector('#token');
const status = document.querySelector('#status');
const items = document.querySelector('#items');
const more = document.querySelector('#more');
const detail = document.querySelector('#detail');
let token = '';
let project = '';
let cursor = null;

async function api(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(res.status === 401 ? '管理トークンを確認してください。' : `HTTP ${res.status}`);
  return res.json();
}
function showRow(row) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '開く';
  button.addEventListener('click', () => openSave(row.save_id));
  li.append(button, `save ${row.save_id} · user ${row.user_id} · revision ${row.revision} · ${row.updated_at}`);
  items.append(li);
}
async function loadPage(reset = false) {
  if (reset) { cursor = null; items.replaceChildren(); detail.hidden = true; }
  status.textContent = '読み込み中…';
  try {
    const q = new URLSearchParams({ project_id: project });
    if (cursor) q.set('cursor', cursor);
    const result = await api(`/v1/admin/saves?${q}`);
    result.items.forEach(showRow);
    cursor = result.next_cursor;
    more.hidden = !cursor;
    status.textContent = `${items.children.length}件を表示しました。`;
  } catch (e) { status.textContent = e.message; }
}
async function openSave(saveId) {
  status.textContent = '読み込み中…';
  try {
    const save = await api(`/v1/admin/saves/${encodeURIComponent(saveId)}`);
    const text = JSON.stringify(save, null, 2);
    document.querySelector('#data').textContent = text;
    const blob = new Blob([text], { type: 'application/json' });
    const link = document.querySelector('#download');
    if (link.dataset.url) URL.revokeObjectURL(link.dataset.url);
    link.href = URL.createObjectURL(blob);
    link.dataset.url = link.href;
    link.download = `${save.save_id}.json`;
    detail.hidden = false;
    status.textContent = '';
  } catch (e) { status.textContent = e.message; }
}
login.addEventListener('submit', async e => {
  e.preventDefault();
  token = tokenInput.value;
  try {
    const q = new URLSearchParams({ project_id: 'login-probe' });
    const res = await fetch(`/v1/admin/saves?${q}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new Error('管理トークンを確認してください。');
    if (!res.ok) throw new Error(`管理API HTTP ${res.status}`);
    browser.hidden = false;
    login.hidden = true;
    tokenInput.value = '';
    status.textContent = '管理トークンを確認しました。プロジェクトを入力してください。';
  } catch (err) { status.textContent = err.message; }
});
document.querySelector('#search').addEventListener('submit', e => {
  e.preventDefault(); project = document.querySelector('#project').value; loadPage(true);
});
document.querySelector('#exact').addEventListener('submit', e => {
  e.preventDefault(); const id = document.querySelector('#save-id').value.trim(); if (id) openSave(id);
});
more.addEventListener('click', () => loadPage(false));
