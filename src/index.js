import { checkAccess } from './access.js';

const MAX_BODY = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_64 = /^[0-9a-f]{64}$/i;
const encoder = new TextEncoder();

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
function json(body, status = 200, headers = {}) { return response(JSON.stringify(body), status, headers); }
function fail(status, error) { return json({ error }, status); }
function secure(res) {
  const headers = new Headers(res.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://drop.tsukumistudio.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function tokenFor(secret, projectId, registrationKey) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${projectId}:${registrationKey}`));
  return [...new Uint8Array(sig)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function readJson(req) {
  const length = Number(req.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY) throw new Error('too_large');
  if (!req.body) throw new Error('invalid_json');
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error('too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('invalid_json'); }
}
function ip(req) { return req.headers.get('cf-connecting-ip') || 'unknown'; }
async function rate(binding, req) {
  if (!binding) throw new Error('missing_binding');
  return (await binding.limit({ key: ip(req) })).success;
}
function corsHeaders(req) {
  const origin = req.headers.get('origin');
  return origin ? { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, PUT, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600', vary: 'Origin' } : {};
}
const SCREENSHOT_URL = /^https:\/\/drop\.tsukumistudio\.com\/\d{4}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/[0-9a-f]{32}\.(?:jpg|jpeg|png|webp)$/;
const SCREENSHOT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function validScreenshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string' || typeof value.captured_at !== 'string') return false;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'url') || !Object.hasOwn(value, 'captured_at')) return false;
  if (!SCREENSHOT_URL.test(value.url)) return false;
  const [, year, month, day] = value.url.match(/^https:\/\/drop\.tsukumistudio\.com\/(\d{4})\/(\d{2})\/(\d{2})\//);
  const folderDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (folderDate.getUTCFullYear() !== Number(year) || folderDate.getUTCMonth() + 1 !== Number(month) || folderDate.getUTCDate() !== Number(day)) return false;
  const time = value.captured_at;
  if (!SCREENSHOT_TIME.test(time)) return false;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) && date.toISOString().replace('.000Z', 'Z') === time;
}
async function register(req, env) {
  if (!env.REGISTRATION_SECRET || !env.DB) return fail(503, 'service_unavailable');
  if (!await rate(env.REGISTER_LIMIT, req)) return fail(429, 'rate_limited');
  let body;
  try { body = await readJson(req); } catch (e) { return fail(e.message === 'too_large' ? 413 : 400, e.message); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.project_id !== 'string' || !PROJECT.test(body.project_id) || typeof body.registration_key !== 'string' || !HEX_64.test(body.registration_key)) return fail(400, 'invalid_request');

  const { project_id: projectId, registration_key: registrationKey } = body;
  const registrationHash = await sha256(`${projectId}:${registrationKey}`);
  const writeToken = await tokenFor(env.REGISTRATION_SECRET, projectId, registrationKey);
  const writeTokenHash = await sha256(writeToken);
  let row = await env.DB.prepare('SELECT u.user_id, s.save_id FROM users u JOIN saves s ON s.user_id = u.user_id WHERE u.registration_hash = ?').bind(registrationHash).first();
  if (!row) {
    const userId = crypto.randomUUID();
    const saveId = crypto.randomUUID();
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users (user_id, project_id, registration_hash) VALUES (?, ?, ?) ON CONFLICT(registration_hash) DO NOTHING').bind(userId, projectId, registrationHash),
        env.DB.prepare('INSERT INTO saves (save_id, user_id, write_token_hash) SELECT ?, user_id, ? FROM users WHERE registration_hash = ? ON CONFLICT(user_id) DO NOTHING').bind(saveId, writeTokenHash, registrationHash)
      ]);
    } catch { return fail(503, 'service_unavailable'); }
    row = await env.DB.prepare('SELECT u.user_id, s.save_id FROM users u JOIN saves s ON s.user_id = u.user_id WHERE u.registration_hash = ?').bind(registrationHash).first();
  }
  if (!row) return fail(503, 'service_unavailable');
  return json({ user_id: row.user_id, save_id: row.save_id, write_token: writeToken });
}
async function writeSave(req, env, saveId) {
  if (!env.DB || !env.REGISTRATION_SECRET) return fail(503, 'service_unavailable');
  if (!UUID.test(saveId)) return fail(400, 'invalid_save_id');
  if (!await rate(env.SAVE_LIMIT, req)) return fail(429, 'rate_limited');
  const bearer = /^Bearer ([0-9a-f]{64})$/i.exec(req.headers.get('authorization') || '');
  if (!bearer) return fail(401, 'unauthorized');
  let body;
  try { body = await readJson(req); } catch (e) { return fail(e.message === 'too_large' ? 413 : 400, e.message); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.data || typeof body.data !== 'object' || Array.isArray(body.data) || !Number.isSafeInteger(body.revision) || body.revision < 1) return fail(400, 'invalid_request');
  const data = JSON.stringify(body.data);
  const tokenHash = await sha256(bearer[1]);
  const hasScreenshot = Object.hasOwn(body, 'screenshot');
  if (hasScreenshot && body.screenshot !== null && !validScreenshot(body.screenshot)) return fail(400, 'invalid_screenshot');
  const screenshot = hasScreenshot && body.screenshot !== null ? JSON.stringify({ url: body.screenshot.url, captured_at: body.screenshot.captured_at }) : null;
  const existing = await env.DB.prepare('SELECT user_id, write_token_hash, revision, data, screenshot FROM saves WHERE save_id = ?').bind(saveId).first();
  const storedHash = existing?.write_token_hash || '0'.repeat(64);
  const tokenValid = crypto.subtle.timingSafeEqual(encoder.encode(storedHash), encoder.encode(tokenHash));
  if (!existing || !tokenValid) return fail(401, 'unauthorized');
  if (body.revision > existing.revision) {
    await env.DB.prepare("UPDATE saves SET revision = ?, data = ?, screenshot = CASE WHEN ? THEN ? ELSE screenshot END, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE save_id = ? AND revision < ?").bind(body.revision, data, hasScreenshot ? 1 : 0, screenshot, saveId, body.revision).run();
  }
  const current = await env.DB.prepare('SELECT user_id, revision, data, screenshot FROM saves WHERE save_id = ?').bind(saveId).first();
  if (current.revision !== body.revision || current.data !== data || (hasScreenshot && current.screenshot !== screenshot)) return fail(409, 'revision_conflict');
  return json({ save_id: saveId, user_id: current.user_id, revision: current.revision });
}
async function adminAccess(req, env) {
  if (typeof env.ACCESS_AUD !== 'string' || !env.ACCESS_AUD.trim() || !env.DB) return fail(503, 'service_unavailable');
  if (!await rate(env.ADMIN_LIMIT, req)) return fail(429, 'rate_limited');
  return (await checkAccess(req, env)).response || null;
}
async function admin(req, env, url) {
  const denied = await adminAccess(req, env);
  if (denied) return denied;
  if (req.method !== 'GET') return fail(405, 'method_not_allowed');
  if (url.pathname === '/v1/admin/saves') {
    const projectId = url.searchParams.get('project_id');
    const cursor = url.searchParams.get('cursor');
    if (!projectId || !PROJECT.test(projectId)) return fail(400, 'invalid_project_id');
    if (cursor && !UUID.test(cursor)) return fail(400, 'invalid_cursor');
    const rows = await env.DB.prepare(`SELECT s.save_id, s.user_id, u.project_id, s.revision, s.updated_at, s.screenshot FROM saves s JOIN users u ON u.user_id=s.user_id WHERE u.project_id=? ${cursor ? 'AND s.save_id > ?' : ''} ORDER BY s.save_id LIMIT 51`).bind(...(cursor ? [projectId, cursor] : [projectId])).all();
    const hasMore = rows.results.length > 50;
    const items = rows.results.slice(0, 50).map(row => ({ ...row, screenshot: row.screenshot === null ? null : JSON.parse(row.screenshot) }));
    return json({ items, next_cursor: hasMore ? items.at(-1).save_id : null });
  }
  const match = /^\/v1\/admin\/saves\/([^/]+)$/.exec(url.pathname);
  if (match) {
    if (!UUID.test(match[1])) return fail(400, 'invalid_save_id');
    const row = await env.DB.prepare('SELECT s.save_id, s.user_id, u.project_id, s.revision, s.updated_at, s.data, s.screenshot FROM saves s JOIN users u ON u.user_id=s.user_id WHERE s.save_id=?').bind(match[1]).first();
    if (!row) return fail(404, 'not_found');
    return json({ ...row, data: JSON.parse(row.data), screenshot: row.screenshot === null ? null : JSON.parse(row.screenshot) });
  }
  return fail(404, 'not_found');
}

export default {
  async fetch(req, env) {
    let cors = {};
    try {
      const url = new URL(req.url);
      const method = req.method;
      let res;
      if (method === 'GET' && url.pathname === '/health') res = json({ ok: true });
      else if (url.pathname === '/') res = method === 'GET' ? Response.redirect(new URL('/admin/', url), 302) : fail(405, 'method_not_allowed');
      else if (url.pathname === '/index.html' || url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        const denied = await adminAccess(req, env);
        if (denied) res = denied;
        else if (method !== 'GET') res = fail(405, 'method_not_allowed');
        else if (url.pathname === '/admin' || url.pathname === '/index.html') res = Response.redirect(new URL('/admin/', url), 302);
        else if (url.pathname === '/admin/' || url.pathname === '/admin/index.html') {
          const page = await env.ASSETS.fetch(new Request(new URL('/index.html', url), req));
          const headers = new Headers(page.headers);
          headers.set('cache-control', 'no-store');
          res = new Response(page.body, { status: page.status, headers });
        } else res = fail(404, 'not_found');
      } else if (url.pathname === '/v1/users' && (method === 'POST' || method === 'OPTIONS')) {
        cors = corsHeaders(req);
        res = method === 'OPTIONS' ? new Response(null, { status: 204, headers: cors }) : await register(req, env);
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      } else if (url.pathname.startsWith('/v1/saves/') && (method === 'PUT' || method === 'OPTIONS')) {
        cors = corsHeaders(req);
        res = method === 'OPTIONS' ? new Response(null, { status: 204, headers: cors }) : await writeSave(req, env, url.pathname.slice('/v1/saves/'.length));
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      } else if (url.pathname === '/v1/admin' || url.pathname.startsWith('/v1/admin/')) {
        res = await admin(req, env, url);
      } else {
        res = await env.ASSETS.fetch(req);
      }
      return secure(res);
    } catch {
      return secure(fail(503, 'service_unavailable', cors));
    }
  }
};
