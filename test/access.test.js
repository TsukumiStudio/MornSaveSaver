import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessToken } from '../src/access.js';
import worker from '../src/index.js';

const audience = 'test-application-audience';
const issuer = 'https://tsukumistudio.cloudflareaccess.com';
const now = Math.floor(Date.now() / 1000);
const encoder = new TextEncoder();
const b64url = value => Buffer.from(value).toString('base64url');
const primary = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', primary.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const certFetcher = async url => {
  assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
  return Response.json({ keys: [jwk] });
};

async function makeToken(claims = {}, signingKey = primary.privateKey) {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: issuer, aud: [audience], exp: now + 3600, nbf: now - 30, ...claims }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, encoder.encode(input));
  return `${input}.${b64url(signature)}`;
}

test('validates Access signature, issuer, audience, exp, and nbf', async () => {
  const claims = await verifyAccessToken(await makeToken({ email: 'admin@example.test' }), { audience, fetcher: certFetcher, now });
  assert.equal(claims.email, 'admin@example.test');

  await assert.rejects(verifyAccessToken(await makeToken({ exp: now - 61 }), { audience, fetcher: certFetcher, now }));
  await assert.rejects(verifyAccessToken(await makeToken({ nbf: now + 61 }), { audience, fetcher: certFetcher, now }));
  await assert.rejects(verifyAccessToken(await makeToken({ exp: 'never' }), { audience, fetcher: certFetcher, now }));
  await assert.rejects(verifyAccessToken(await makeToken({ nbf: null }), { audience, fetcher: certFetcher, now }));
  assert.equal((await verifyAccessToken(await makeToken({ nbf: undefined }), { audience, fetcher: certFetcher, now })).iss, issuer);
  await assert.rejects(verifyAccessToken(await makeToken({ nbf: 'soon' }), { audience, fetcher: certFetcher, now }));
  await assert.rejects(verifyAccessToken(await makeToken({ exp: undefined }), { audience, fetcher: certFetcher, now }));
  await assert.rejects(verifyAccessToken(await makeToken({ aud: ['other'] }), { audience, fetcher: certFetcher, now }));
  await assert.rejects(verifyAccessToken(await makeToken({ iss: 'https://attacker.example' }), { audience, fetcher: certFetcher, now }));
  await assert.rejects(verifyAccessToken(await makeToken({}, other.privateKey), { audience, fetcher: certFetcher, now }));
});

test('protects admin HTML and API while leaving no configuration bypass', async () => {
  const missingEnv = { DB: {}, ADMIN_LIMIT: { limit: async () => ({ success: true }) } };
  const missing = await worker.fetch(new Request('https://morn-save-saver.workers.dev/v1/admin/saves?project_id=game'), missingEnv);
  assert.equal(missing.status, 503);
  assert.equal((await worker.fetch(new Request('https://morn-save-saver.workers.dev/admin/'), missingEnv)).status, 503);
  const configured = { ACCESS_AUD: audience, DB: {}, ADMIN_LIMIT: { limit: async () => ({ success: true }) } };
  for (const path of ['/admin/', '/admin/private', '/index.html', '/v1/admin', '/v1/admin/saves?project_id=game']) {
    const denied = await worker.fetch(new Request(`https://morn-save-saver.workers.dev${path}`), configured);
    assert.equal(denied.status, 403, path);
  }
  const malformed = await worker.fetch(new Request('https://morn-save-saver.workers.dev/v1/admin/saves?project_id=game', { headers: { 'Cf-Access-Jwt-Assertion': 'not.a.jwt' } }), configured);
  assert.equal(malformed.status, 403);

  const captured = { url: 'https://drop.tsukumistudio.com/2026/09/23/0123456789abcdef0123456789abcdef.jpg', captured_at: '2026-09-23T00:00:00Z' };
  const save = { save_id: '123e4567-e89b-12d3-a456-426614174000', user_id: '123e4567-e89b-12d3-a456-426614174001', project_id: 'game', revision: 2, updated_at: '2026-09-23T00:00:00Z', data: '{"level":2}', screenshot: JSON.stringify(captured) };
  let detailSave = save;
  const env = {
    ACCESS_AUD: audience,
    ADMIN_LIMIT: { limit: async () => ({ success: true }) },
    DB: { prepare: () => ({ bind: () => ({ first: async () => detailSave, all: async () => ({ results: [save] }) }) }) },
    ASSETS: { fetch: async () => new Response('<main>admin</main>', { headers: { 'content-type': 'text/html' } }) }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = certFetcher;
  try {
    const token = await makeToken();
    const page = await worker.fetch(new Request('https://morn-save-saver.workers.dev/admin/', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /admin/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const cookiePage = await worker.fetch(new Request('https://morn-save-saver.workers.dev/admin/', { headers: { Cookie: `CF_Authorization=${token}` } }), env);
    assert.equal(cookiePage.status, 200);
    const listing = await worker.fetch(new Request('https://morn-save-saver.workers.dev/v1/admin/saves?project_id=game', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env);
    assert.equal(listing.status, 200);
    const listed = (await listing.json()).items[0];
    assert.equal(listed.save_id, save.save_id);
    assert.deepEqual(listed.screenshot, captured);
    const response = await worker.fetch(new Request(`https://morn-save-saver.workers.dev/v1/admin/saves/${save.save_id}`, { headers: { 'Cf-Access-Jwt-Assertion': token } }), env);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.deepEqual(detail.data, { level: 2 });
    assert.deepEqual(detail.screenshot, captured);
    assert.match(response.headers.get('content-security-policy'), /img-src 'self' https:\/\/drop\.tsukumistudio\.com/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    detailSave = { ...save, screenshot: null };
    const empty = await worker.fetch(new Request(`https://morn-save-saver.workers.dev/v1/admin/saves/${save.save_id}`, { headers: { 'Cf-Access-Jwt-Assertion': token } }), env);
    assert.equal((await empty.json()).screenshot, null);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
