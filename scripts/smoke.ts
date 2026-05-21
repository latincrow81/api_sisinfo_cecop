#!/usr/bin/env tsx
// Smoke tests for the secop-api worker. Hits every public + admin endpoint and
// reports per-endpoint status, with non-zero exit on any failure.
//
// Usage:
//   tsx scripts/smoke.ts                       # uses API_BASE_URL / MATCH_URL env or defaults
//   tsx scripts/smoke.ts --base=https://...    # override api base
//   tsx scripts/smoke.ts --match-url=https://… # also smoke the match worker's /admin/match
//   tsx scripts/smoke.ts --tender-id=ABC       # also verify GET /v1/tenders/{id} returns 200
//   tsx scripts/smoke.ts --alerts-live         # exercise the real POST /v1/alerts create path
//                                                (sends a real email — DO NOT use in prod)
//   tsx scripts/smoke.ts --match-live          # call /admin/match for real (sends digests)
//
// Env:
//   API_BASE_URL   default base when --base is omitted
//   MATCH_URL      default match worker URL when --match-url is omitted
//   ADMIN_TOKEN    if set, /admin/stats is verified for 200; otherwise only the 401 path
//   SMOKE_EMAIL    recipient for --alerts-live (or pass --live-email=…)

const DEFAULT_BASE = 'https://secop-api.mescude1.workers.dev';

interface Args {
  base: string;
  matchUrl: string | null;
  tenderId: string | null;
  alertsLive: boolean;
  matchLive: boolean;
  adminToken: string | null;
  liveEmail: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const stripSlash = (s: string): string => s.replace(/\/+$/, '');
  const matchUrlRaw = get('match-url') ?? process.env['MATCH_URL'] ?? null;
  return {
    base: stripSlash(get('base') ?? process.env['API_BASE_URL'] ?? DEFAULT_BASE),
    matchUrl: matchUrlRaw ? stripSlash(matchUrlRaw) : null,
    tenderId: get('tender-id') ?? null,
    alertsLive: flag('alerts-live'),
    matchLive: flag('match-live'),
    adminToken: process.env['ADMIN_TOKEN'] ?? null,
    liveEmail: get('live-email') ?? process.env['SMOKE_EMAIL'] ?? null,
  };
}

interface CheckResult {
  name: string;
  method: string;
  path: string;
  expected: number | number[];
  actual: number | 'ERR';
  ok: boolean;
  detail?: string;
  bodyExcerpt?: string;
}

const results: CheckResult[] = [];

function expectedMatches(expected: number | number[], actual: number): boolean {
  return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}

async function check(
  name: string,
  method: string,
  url: string,
  init: RequestInit,
  expected: number | number[],
): Promise<Response | null> {
  const path = new URL(url).pathname + new URL(url).search;
  const start = Date.now();
  try {
    const res = await fetch(url, { ...init, method });
    const elapsed = Date.now() - start;
    const ok = expectedMatches(expected, res.status);
    let bodyExcerpt: string | undefined;
    if (!ok) {
      try {
        const text = await res.clone().text();
        bodyExcerpt = text.length > 240 ? text.slice(0, 240) + '…' : text;
      } catch {
        // ignore body read failures
      }
    }
    results.push({
      name,
      method,
      path,
      expected,
      actual: res.status,
      ok,
      detail: `${elapsed}ms`,
      ...(bodyExcerpt !== undefined ? { bodyExcerpt } : {}),
    });
    return res;
  } catch (err) {
    results.push({
      name,
      method,
      path,
      expected,
      actual: 'ERR',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function run(): Promise<void> {
  const args = parseArgs();
  const base = args.base;
  console.log(`smoke target: ${base}`);
  console.log('');

  // ─── meta / openapi ─────────────────────────────────────────────────────────────────
  await check('health', 'GET', `${base}/v1/health`, {}, 200);
  await check('openapi.json', 'GET', `${base}/v1/openapi.json`, {}, 200);
  await check('openapi.yaml', 'GET', `${base}/v1/openapi.yaml`, {}, 200);
  await check('openapi/doc', 'GET', `${base}/v1/openapi/doc`, {}, 200);

  // ─── catalog ────────────────────────────────────────────────────────────────────────
  await check('sectors', 'GET', `${base}/v1/sectors`, {}, 200);
  await check('facets', 'GET', `${base}/v1/facets`, {}, 200);

  // ─── search ─────────────────────────────────────────────────────────────────────────
  await check(
    'search (happy path)',
    'POST',
    `${base}/v1/search`,
    {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'servicios de consultoría', top_k: 5 }),
    },
    200,
  );
  await check(
    'search (validation 400)',
    'POST',
    `${base}/v1/search`,
    {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    },
    400,
  );

  // ─── tenders ────────────────────────────────────────────────────────────────────────
  await check(
    'tender (not found)',
    'GET',
    `${base}/v1/tenders/__smoke_nonexistent__`,
    {},
    404,
  );
  if (args.tenderId) {
    await check(
      'tender (real id)',
      'GET',
      `${base}/v1/tenders/${encodeURIComponent(args.tenderId)}`,
      {},
      200,
    );
  }

  // ─── alerts: auth paths (token-gated routes return 401 with bogus token) ────────────
  await check(
    'alert verify (bad token)',
    'GET',
    `${base}/v1/alerts/verify?token=not-a-real-token`,
    {},
    401,
  );
  await check(
    'alert unsubscribe (bad token)',
    'GET',
    `${base}/v1/alerts/unsubscribe?token=not-a-real-token`,
    {},
    401,
  );
  await check(
    'alert list (bad token)',
    'GET',
    `${base}/v1/alerts?email=smoke@example.com&token=not-a-real-token`,
    {},
    401,
  );
  await check(
    'alert update (bad token)',
    'PATCH',
    `${base}/v1/alerts/00000000-0000-0000-0000-000000000000?token=not-a-real-token`,
    {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ min_score: 0.6 }),
    },
    401,
  );
  await check(
    'alert delete (bad token)',
    'DELETE',
    `${base}/v1/alerts/00000000-0000-0000-0000-000000000000?token=not-a-real-token`,
    {},
    401,
  );

  // ─── alerts: validation path (avoid creating real alerts unless --alerts-live) ──────
  await check(
    'alert create (validation 400)',
    'POST',
    `${base}/v1/alerts`,
    {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', query: '' }),
    },
    400,
  );

  if (args.alertsLive) {
    if (!args.liveEmail) {
      console.warn('  ⚠ --alerts-live given but no --live-email=… or SMOKE_EMAIL env — skipping');
    } else {
      await check(
        'alert create (live)',
        'POST',
        `${base}/v1/alerts`,
        {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: args.liveEmail,
            query: 'smoke test alert — please ignore',
            min_score: 0.99,
          }),
        },
        202,
      );
    }
  }

  // ─── admin/stats ────────────────────────────────────────────────────────────────────
  await check(
    'admin/stats (no auth)',
    'GET',
    `${base}/admin/stats`,
    {},
    401,
  );
  if (args.adminToken) {
    await check(
      'admin/stats (authed)',
      'GET',
      `${base}/admin/stats`,
      { headers: { authorization: `Bearer ${args.adminToken}` } },
      200,
    );
  }

  // ─── match worker ───────────────────────────────────────────────────────────────────
  if (args.matchUrl) {
    await check(
      'match/admin (no auth)',
      'POST',
      `${args.matchUrl}/admin/match`,
      {},
      401,
    );
    await check(
      'match/admin (wrong method)',
      'GET',
      `${args.matchUrl}/admin/match`,
      {},
      404,
    );
    if (args.adminToken && args.matchLive) {
      // Triggers the real digest run (sends emails to verified subscribers past
      // cooldown). Gated behind --match-live so the default smoke is non-destructive.
      await check(
        'match/admin (authed, live)',
        'POST',
        `${args.matchUrl}/admin/match`,
        { headers: { authorization: `Bearer ${args.adminToken}` } },
        202,
      );
    }
  }

  // ─── 404 catch-all ──────────────────────────────────────────────────────────────────
  await check(
    'unknown route → 404',
    'GET',
    `${base}/v1/does-not-exist`,
    {},
    404,
  );

  // ─── report ─────────────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    const exp = Array.isArray(r.expected) ? r.expected.join('|') : r.expected;
    const line = `${mark} ${r.method.padEnd(6)} ${String(r.actual).padEnd(3)} (want ${exp})  ${r.name}  [${r.detail ?? ''}]`;
    console.log(line);
    if (r.bodyExcerpt) console.log(`    body: ${r.bodyExcerpt}`);
  }

  console.log('');
  console.log(`${passed}/${results.length} passed`);
  if (failed.length > 0) {
    console.log(`${failed.length} failed`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('smoke runner crashed:', err);
  process.exit(1);
});