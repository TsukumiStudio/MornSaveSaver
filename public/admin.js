const status = document.querySelector('#status');
const items = document.querySelector('#items');
const more = document.querySelector('#more');
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
function showRow(row, initialSave = null) {
  const existing = document.getElementById(`save-${row.save_id}`);
  if (existing) return existing;
  const li = document.createElement('li');
  const group = document.createElement('details');
  group.id = `save-${row.save_id}`;
  group.className = 'save-group';
  const summary = document.createElement('summary');
  const label = document.createElement('span');
  label.className = 'save-label';
  const id = document.createElement('strong');
  id.textContent = row.save_id;
  const meta = document.createElement('small');
  meta.textContent = `user ${row.user_id} · revision ${row.revision} · ${row.updated_at}`;
  label.append(id, meta);
  const download = document.createElement('button');
  download.type = 'button';
  download.textContent = 'JSONで保存';
  const fields = document.createElement('div');
  fields.className = 'fields';
  fields.setAttribute('aria-live', 'polite');
  const screenshot = document.createElement('div');
  screenshot.className = 'screenshot';
  screenshot.setAttribute('aria-live', 'polite');
  let pending;
  let save = initialSave;
  async function getSave() {
    if (save) return save;
    pending ??= api(`/v1/admin/saves/${encodeURIComponent(row.save_id)}`);
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
      screenshot.replaceChildren();
      if (result.screenshot) {
        const time = document.createElement('time');
        time.dateTime = result.screenshot.captured_at;
        time.textContent = `撮影日時: ${result.screenshot.captured_at}`;
        const image = document.createElement('img');
        image.src = result.screenshot.url;
        image.alt = '添付スクリーンショット';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        const state = document.createElement('span');
        state.textContent = '画像を読み込み中…';
        image.addEventListener('load', () => state.remove(), { once: true });
        image.addEventListener('error', () => { image.hidden = true; state.textContent = '画像を表示できません'; }, { once: true });
        screenshot.append(time, image, state);
      }
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
      link.download = `${row.save_id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { report(error); }
    finally { download.disabled = false; }
  });
  summary.append(label, download);
  group.append(summary, screenshot, fields);
  li.append(group);
  items.append(li);
  return group;
}
async function loadPage(reset = false) {
  if (reset) { cursor = null; items.replaceChildren(); }
  status.textContent = '読み込み中…';
  try {
    const q = new URLSearchParams({ project_id: project });
    if (cursor) q.set('cursor', cursor);
    const result = await api(`/v1/admin/saves?${q}`);
    result.items.forEach(row => showRow(row));
    cursor = result.next_cursor;
    more.hidden = !cursor;
    status.textContent = `${items.children.length}件を表示しました。`;
  } catch (error) { report(error); }
}
async function openSave(saveId) {
  status.textContent = '読み込み中…';
  try {
    const save = await api(`/v1/admin/saves/${encodeURIComponent(saveId)}`);
    const group = showRow(save, save);
    group.open = true;
    group.scrollIntoView({ block: 'nearest' });
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
