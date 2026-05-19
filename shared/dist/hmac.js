// HS256 magic-link tokens. Web Crypto only (no Node deps), works in Workers.
// Token = base64url(payload-json) + "." + base64url(sig).
// Payload carries: sub (alert id), scope, exp (unix seconds), iat.
// State (verified / deleted) lives on the alert row — tokens are stateless signatures.
const enc = new TextEncoder();
const dec = new TextDecoder();
function b64urlEncode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++)
        s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
    try {
        const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
        const bin = atob(padded);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++)
            out[i] = bin.charCodeAt(i);
        return out;
    }
    catch {
        return null;
    }
}
async function getKey(secret) {
    return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signToken(payload, secret) {
    if (!secret)
        throw new Error('HMAC_SECRET is not set');
    const full = { ...payload, iat: Math.floor(Date.now() / 1000) };
    const body = b64urlEncode(enc.encode(JSON.stringify(full)));
    const key = await getKey(secret);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}
export async function verifyToken(token, secret) {
    if (!secret)
        throw new Error('HMAC_SECRET is not set');
    const dotIdx = token.indexOf('.');
    if (dotIdx === -1)
        return { ok: false, reason: 'malformed' };
    const body = token.slice(0, dotIdx);
    const sigEncoded = token.slice(dotIdx + 1);
    const sigBytes = b64urlDecode(sigEncoded);
    const payloadBytes = b64urlDecode(body);
    if (!sigBytes || !payloadBytes)
        return { ok: false, reason: 'malformed' };
    const key = await getKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(body));
    if (!valid)
        return { ok: false, reason: 'bad_signature' };
    let parsed;
    try {
        parsed = JSON.parse(dec.decode(payloadBytes));
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    if (typeof parsed !== 'object' ||
        parsed === null ||
        typeof parsed['sub'] !== 'string' ||
        typeof parsed['scope'] !== 'string' ||
        typeof parsed['exp'] !== 'number' ||
        typeof parsed['iat'] !== 'number') {
        return { ok: false, reason: 'malformed' };
    }
    const payload = parsed;
    if (payload.exp < Math.floor(Date.now() / 1000))
        return { ok: false, reason: 'expired' };
    return { ok: true, payload };
}
export const TOKEN_TTL = {
    verify: 24 * 60 * 60, // 1 day for the magic link
    manage: 7 * 24 * 60 * 60, // 7 days for both manage_alert and manage_email
    unsubscribe: 365 * 24 * 60 * 60, // 1 year — alert deletion is effectively single-use
};
