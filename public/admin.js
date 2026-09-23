const status = document.querySelector('#status');
const items = document.querySelector('#items');
const more = document.querySelector('#more');
const detail = document.querySelector('#detail');
const projectInput = document.querySelector('#project');
let project = new URLSearchParams(location.search).get('project_id') || '';
let cursor = null;
projectInput.value = project;

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
  } catch (error) { report(error); }
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
  } catch (error) { report(error); }
}
document.querySelector('#search').addEventListener('submit', event => {
  event.preventDefault(); project = projectInput.value; loadPage(true);
});
document.querySelector('#exact').addEventListener('submit', event => {
  event.preventDefault(); const id = document.querySelector('#save-id').value.trim(); if (id) openSave(id);
});
more.addEventListener('click', () => loadPage(false));
if (project) loadPage(true);
