const ISSUER = 'https://tsukumistudio.cloudflareaccess.com';
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const SKEW_SECONDS = 60;
const CERTS_TTL_MS = 60 * 60 * 1000;
const encoder = new TextEncoder();
let cachedKeys;
let cachedAt = 0;

export async function checkAccess(request, env) {
  const audience = typeof env.ACCESS_AUD === 'string' ? env.ACCESS_AUD.trim() : '';
  if (!audience) return { response: accessError(503, 'access_not_configured') };

  const token = readToken(request);
  if (!token) return { response: accessError(403, 'access_required') };
  try {
    await verifyAccessToken(token, { audience });
    return {};
  } catch {
    return { response: accessError(403, 'access_denied') };
  }
}

export async function verifyAccessToken(token, { audience, fetcher = fetch, now = Date.now() / 1000 }) {
  if (typeof audience !== 'string' || !audience.trim() || typeof token !== 'string' || token.length > 16_384) throw new Error('invalid token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid token');
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 512) throw new Error('invalid token header');

  const jwks = await getKeys(fetcher);
  const jwk = jwks.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signature = decodeBytes(encodedSignature);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, encoder.encode(`${encodedHeader}.${encodedClaims}`));
  if (!valid) throw new Error('invalid signature');

  const claims = decodeJson(encodedClaims);
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('invalid claims');
  const aud = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (claims?.iss !== ISSUER || !aud.includes(audience)) throw new Error('wrong issuer or audience');
  if (!Number.isFinite(claims.exp) || claims.exp + SKEW_SECONDS < now) throw new Error('invalid expiration');
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf - SKEW_SECONDS > now)) throw new Error('invalid not-before');
  return claims;
}

async function getKeys(fetcher) {
  const cacheable = fetcher === globalThis.fetch;
  if (cacheable && cachedKeys && Date.now() - cachedAt < CERTS_TTL_MS) return cachedKeys;
  const response = await fetcher(CERTS_URL);
  if (!response.ok) throw new Error('could not load signing keys');
  const body = await response.json();
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('empty signing keys');
  if (cacheable) {
    cachedKeys = body.keys;
    cachedAt = Date.now();
  }
  return body.keys;
}

function readToken(request) {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (assertion) return assertion.trim();
  const cookie = request.headers.get('Cookie') || '';
  return cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1] || '';
}

function decodeBytes(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('invalid base64url');
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - segment.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBytes(segment)));
}

function accessError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
