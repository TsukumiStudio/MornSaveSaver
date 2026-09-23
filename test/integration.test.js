import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 8790 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const secret = 'registration-secret-for-integration-tests';
const adminToken = 'admin-token-for-integration-tests';
let server;
let stateDir;
let serverOutput = '';

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'mornsavesaver-'));
  const persist = join(stateDir, 'state');
  const migration = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'morn-save-saver', '--local', '--persist-to', persist], { cwd: process.cwd(), encoding: 'utf8' });
  if (migration.status !== 0) throw new Error(migration.stderr || migration.stdout);
  server = spawn(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--port', String(port),
    '--persist-to', persist, '--show-interactive-dev-session=false',
    '--var', `REGISTRATION_SECRET:${secret}`, '--var', `ADMIN_TOKEN:${adminToken}`
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Wrangler exited early:\n${serverOutput}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await delay(200);
  }
  throw new Error(`Wrangler did not start:\n${serverOutput}`);
});

after(async () => {
  server?.kill('SIGTERM');
  await rm(stateDir, { recursive: true, force: true });
});

async function call(path, options = {}) {
  return fetch(`${base}${path}`, options);
}
async function payload(res) { return res.json(); }

 test('registration, write auth, revision, and admin retrieval', async () => {
  const key = 'a'.repeat(64);
  const registration = { project_id: 'integration-game', registration_key: key };
  const firstRes = await call('/v1/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registration) });
  assert.equal(firstRes.status, 200, serverOutput);
  const first = await payload(firstRes);
  assert.match(first.user_id, /^[0-9a-f-]{36}$/i);
  assert.match(first.save_id, /^[0-9a-f-]{36}$/i);
  assert.match(first.write_token, /^[0-9a-f]{64}$/);
  const retry = await payload(await call('/v1/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registration) }));
  assert.deepEqual(retry, first);

  const write = (revision, data, token = first.write_token) => call(`/v1/saves/${first.save_id}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ revision, data }) });
  assert.equal((await write(1, { level: 1 })).status, 200);
  assert.equal((await write(1, { level: 1 })).status, 200);
  assert.equal((await write(1, { level: 2 })).status, 409);
  assert.equal((await write(0, { level: 0 })).status, 400);
  assert.equal((await write(2, { level: 2 }, 'f'.repeat(64))).status, 401);

  const auth = { authorization: `Bearer ${adminToken}` };
  const listing = await payload(await call('/v1/admin/saves?project_id=integration-game', { headers: auth }));
  assert.equal(listing.items.length, 1);
  assert.equal(listing.items[0].save_id, first.save_id);
  const detail = await payload(await call(`/v1/admin/saves/${first.save_id}`, { headers: auth }));
  assert.deepEqual(detail.data, { level: 1 });
  assert.equal(detail.revision, 1);
  assert.equal((await call(`/v1/admin/saves/${first.save_id}`)).status, 401);
  assert.equal((await call('/v1/admin/saves?project_id=integration-game', { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('enforces 256 KiB body limit and CORS scope', async () => {
  const tooLarge = JSON.stringify({ project_id: 'integration-game', registration_key: 'b'.repeat(64), data: 'x'.repeat(256 * 1024) });
  const oversized = await call('/v1/users', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://game.example' }, body: tooLarge });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get('access-control-allow-origin'), '*');
  const admin = await call('/v1/admin/saves?project_id=integration-game', { headers: { authorization: `Bearer ${adminToken}`, origin: 'https://game.example' } });
  assert.equal(admin.headers.get('access-control-allow-origin'), null);
  const health = await call('/health');
  assert.deepEqual(await payload(health), { ok: true });
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('rate limits registration and save updates by client IP', async () => {
  let response;
  for (let i = 0; i < 35; i++) {
    response = await call('/v1/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (response.status === 429) break;
  }
  assert.equal(response.status, 429);

  let writeResponse;
  for (let i = 0; i < 65; i++) {
    writeResponse = await call(`/v1/saves/${crypto.randomUUID()}`, { method: 'PUT', headers: { authorization: 'Bearer invalid' } });
    if (writeResponse.status === 429) break;
  }
  assert.equal(writeResponse.status, 429);

  let adminResponse;
  for (let i = 0; i < 35; i++) {
    adminResponse = await call('/v1/admin/saves?project_id=integration-game', { headers: { authorization: 'Bearer wrong' } });
    if (adminResponse.status === 429) break;
  }
  assert.equal(adminResponse.status, 429);
});
