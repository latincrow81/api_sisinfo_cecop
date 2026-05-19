// HS256 magic-link tokens. Web Crypto only (no Node deps), works in Workers.
// Token = base64url(payload-json) + "." + base64url(sig).
// Payload carries: sub (alert id), scope, exp (unix seconds), iat.
// State (verified / deleted) lives on the alert row — tokens are stateless signatures.

export type TokenScope = 'manage_alert' | 'manage_email' | 'unsubscribe';

export interface TokenPayload {
  sub: string;
  scope: TokenScope;
  exp: number;
  iat: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signToken(
  payload: Omit<TokenPayload, 'iat'>,
  secret: string,
): Promise<string> {
  if (!secret) throw new Error('HMAC_SECRET is not set');
  const full: TokenPayload = { ...payload, iat: Math.floor(Date.now() / 1000) };
  const body = b64urlEncode(enc.encode(JSON.stringify(full)));
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export interface VerifyOk {
  ok: true;
  payload: TokenPayload;
}
export interface VerifyErr {
  ok: false;
  reason: 'malformed' | 'bad_signature' | 'expired';
}

export async function verifyToken(
  token: string,
  secret: string,
): Promise<VerifyOk | VerifyErr> {
  if (!secret) throw new Error('HMAC_SECRET is not set');
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dotIdx);
  const sigEncoded = token.slice(dotIdx + 1);
  const sigBytes = b64urlDecode(sigEncoded);
  const payloadBytes = b64urlDecode(body);
  if (!sigBytes || !payloadBytes) return { ok: false, reason: 'malformed' };

  const key = await getKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(body));
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['sub'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['scope'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['exp'] !== 'number' ||
    typeof (parsed as Record<string, unknown>)['iat'] !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const payload = parsed as TokenPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

export const TOKEN_TTL = {
  verify: 24 * 60 * 60, // 1 day for the magic link
  manage: 7 * 24 * 60 * 60, // 7 days for both manage_alert and manage_email
  unsubscribe: 365 * 24 * 60 * 60, // 1 year — alert deletion is effectively single-use
};
