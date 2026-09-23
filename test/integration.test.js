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
let server;
let stateDir;
let persistDir;
let serverOutput = '';

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'mornsavesaver-'));
  persistDir = join(stateDir, 'state');
  const migration = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'morn-save-saver', '--local', '--persist-to', persistDir], { cwd: process.cwd(), encoding: 'utf8' });
  if (migration.status !== 0) throw new Error(migration.stderr || migration.stdout);
  server = spawn(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--port', String(port),
    '--persist-to', persistDir, '--show-interactive-dev-session=false',
    '--var', `REGISTRATION_SECRET:${secret}`, '--var', 'ACCESS_AUD:integration-test-audience'
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
function storedScreenshot(saveId) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'morn-save-saver', '--local', '--persist-to', persistDir, '--json', '--command', `SELECT screenshot FROM saves WHERE save_id='${saveId}'`], { cwd: process.cwd(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  return output[0].results[0].screenshot;
}

test('registration, write auth, revision, and admin fail-closed', async () => {
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

  const write = (revision, data, token = first.write_token, extra = {}) => call(`/v1/saves/${first.save_id}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ revision, data, ...extra }) });
  const screenshot = { url: 'https://drop.tsukumistudio.com/2026/09/23/0123456789abcdef0123456789abcdef.jpg', captured_at: '2026-09-23T00:00:00Z' };
  assert.equal((await write(1, { level: 1 }, first.write_token, { screenshot })).status, 200);
  assert.deepEqual(JSON.parse(storedScreenshot(first.save_id)), screenshot);
  assert.equal((await write(1, { level: 1 }, first.write_token, { screenshot })).status, 200);
  assert.equal((await write(1, { level: 1 })).status, 200);
  assert.equal((await write(1, { level: 1 }, first.write_token, { screenshot: null })).status, 409);
  assert.equal((await write(1, { level: 1 }, first.write_token, { screenshot: { ...screenshot, captured_at: '2026-09-23T00:00:01Z' } })).status, 409);
  assert.equal((await write(1, { level: 2 })).status, 409);
  assert.equal((await write(0, { level: 0 })).status, 400);
  assert.equal((await write(2, { level: 2 }, 'f'.repeat(64))).status, 401);
  assert.equal((await write(2, { level: 2 })).status, 200);
  assert.deepEqual(JSON.parse(storedScreenshot(first.save_id)), screenshot);
  assert.equal((await write(3, { level: 3 }, first.write_token, { screenshot: null })).status, 200);
  assert.equal(storedScreenshot(first.save_id), null);
  assert.equal((await write(3, { level: 3 }, first.write_token, { screenshot: null })).status, 200);
  const invalidScreenshots = [
    { ...screenshot, url: 'https://evil.example/2026/09/23/0123456789abcdef0123456789abcdef.jpg' },
    { ...screenshot, url: 'https://user@drop.tsukumistudio.com/2026/09/23/0123456789abcdef0123456789abcdef.jpg' },
    { ...screenshot, url: 'https://drop.tsukumistudio.com:443/2026/09/23/0123456789abcdef0123456789abcdef.jpg' },
    { ...screenshot, url: `${screenshot.url}?x=1` },
    { ...screenshot, url: 'https://drop.tsukumistudio.com/2026/09/23/not-a-key.svg' },
    { ...screenshot, url: 'https://drop.tsukumistudio.com/2026/02/31/0123456789abcdef0123456789abcdef.jpg' },
    { ...screenshot, other: true },
    { ...screenshot, captured_at: '2026-02-30T00:00:00Z' },
    { ...screenshot, captured_at: '2026-09-23T00:00:00.000Z' }
  ];
  for (const invalid of invalidScreenshots) assert.equal((await write(4, { level: 4 }, first.write_token, { screenshot: invalid })).status, 400);
  assert.equal(storedScreenshot(first.save_id), null);

  assert.equal((await call('/v1/admin/saves?project_id=integration-game')).status, 403);
  assert.equal((await call('/admin/')).status, 403);
});

test('enforces 256 KiB body limit and CORS scope', async () => {
  const tooLarge = JSON.stringify({ project_id: 'integration-game', registration_key: 'b'.repeat(64), data: 'x'.repeat(256 * 1024) });
  const oversized = await call('/v1/users', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://game.example' }, body: tooLarge });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get('access-control-allow-origin'), '*');
  const admin = await call('/v1/admin/saves?project_id=integration-game', { headers: { origin: 'https://game.example' } });
  assert.equal(admin.headers.get('access-control-allow-origin'), null);
  const health = await call('/health');
  assert.deepEqual(await payload(health), { ok: true });
  const root = await call('/', { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), 'http://127.0.0.1:' + new URL(base).port + '/admin/');
  const page = await call('/admin/');
  assert.equal(page.status, 403);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test('rate limits registration, save updates, and admin requests by client IP', async () => {
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
    adminResponse = await call('/v1/admin/saves?project_id=integration-game');
    if (adminResponse.status === 429) break;
  }
  assert.equal(adminResponse.status, 429);
});
