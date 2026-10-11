/**
 * Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion) with Web Crypto.
 * Fails closed: any problem => throws.
 */

export interface AccessClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  sub?: string;
  email?: string;
  [k: string]: unknown;
}

export interface AccessOptions {
  teamDomain: string; // https://<team>.cloudflareaccess.com
  aud: string;
  allowedEmail?: string;
}

interface KeyCache {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const caches = new Map<string, KeyCache>();
const TTL_MS = 60 * 60 * 1000;
const MIN_REFETCH_MS = 60 * 1000;

export function normalizeTeamDomain(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("ACCESS_TEAM_DOMAIN is not a valid URL");
  }
  if (u.protocol !== "https:" || !u.hostname.endsWith(".cloudflareaccess.com") || u.pathname !== "/") {
    throw new Error("ACCESS_TEAM_DOMAIN must look like https://<team>.cloudflareaccess.com");
  }
  return `https://${u.hostname}`;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseJson<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function loadKeys(team: string): Promise<KeyCache> {
  const res = await fetch(`${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    );
  }
  const cache = { keys, fetchedAt: Date.now() };
  caches.set(team, cache);
  return cache;
}

async function getKey(team: string, kid: string): Promise<CryptoKey> {
  let cache = caches.get(team);
  const now = Date.now();
  if (!cache || now - cache.fetchedAt > TTL_MS) cache = await loadKeys(team);
  let key = cache.keys.get(kid);
  if (!key && now - cache.fetchedAt > MIN_REFETCH_MS) {
    cache = await loadKeys(team); // unknown kid: maybe key rotation (rate-limited refetch)
    key = cache.keys.get(kid);
  }
  if (!key) throw new Error("unknown signing key");
  return key;
}

export function resetAccessCache(): void {
  caches.clear();
}

export async function verifyAccessJwt(token: string, opts: AccessOptions, nowMs = Date.now()): Promise<AccessClaims> {
  const team = normalizeTeamDomain(opts.teamDomain);
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts as [string, string, string];

  const header = parseJson<{ alg?: string; kid?: string }>(b64urlToBytes(h));
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  if (!header.kid) throw new Error("missing kid");

  const key = await getKey(team, header.kid);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("bad signature");

  const claims = parseJson<AccessClaims>(b64urlToBytes(p));
  const nowS = Math.floor(nowMs / 1000);
  if (claims.iss !== team) throw new Error("bad issuer");
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(opts.aud)) throw new Error("bad audience");
  if (typeof claims.exp !== "number" || claims.exp <= nowS) throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > nowS + 30) throw new Error("not yet valid");
  if (opts.allowedEmail) {
    if (typeof claims.email !== "string" || claims.email.toLowerCase() !== opts.allowedEmail.toLowerCase()) {
      throw new Error("email not allowed");
    }
  }
  return claims;
}
