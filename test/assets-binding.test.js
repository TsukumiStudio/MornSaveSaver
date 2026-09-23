import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 9300 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let stateDir;
let server;
let output = '';

test('serves admin HTML through the real Assets binding without canonical redirect', async t => {
  const productionConfig = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  assert.equal(productionConfig.assets.html_handling, 'none');

  stateDir = await mkdtemp(join(tmpdir(), 'mornsavesaver-assets-'));
  server = spawn(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'test/assets-probe.wrangler.jsonc', '--local',
    '--port', String(port), '--persist-to', join(stateDir, 'state'), '--show-interactive-dev-session=false'
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    server?.kill('SIGTERM');
    await rm(stateDir, { recursive: true, force: true });
  });

  let response;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Wrangler exited early:\n${output}`);
    try {
      response = await fetch(`${base}/__probe`, { redirect: 'manual' });
      break;
    } catch {}
    await delay(200);
  }
  assert.ok(response, `Wrangler did not start:\n${output}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.match(await response.text(), /MornSaveSaver 管理/);
});
