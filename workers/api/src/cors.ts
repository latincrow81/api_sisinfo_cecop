// CORS allowlist. ALLOWED_ORIGINS is a comma-separated list. Literal entries match
// exactly. The special token `*.vercel.app` matches any subdomain of vercel.app so
// preview deploys work without re-deploying the worker.

const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

export function parseAllowed(raw: string | undefined): {
  literals: Set<string>;
  vercelPreview: boolean;
} {
  const literals = new Set<string>();
  let vercelPreview = false;
  for (const item of (raw ?? '').split(',')) {
    const v = item.trim();
    if (!v) continue;
    if (v === '*.vercel.app') vercelPreview = true;
    else literals.add(v);
  }
  return { literals, vercelPreview };
}

export function isAllowed(
  origin: string | null,
  allowed: { literals: Set<string>; vercelPreview: boolean },
): boolean {
  if (!origin) return false;
  if (allowed.literals.has(origin)) return true;
  if (allowed.vercelPreview && VERCEL_PREVIEW_RE.test(origin)) return true;
  return false;
}
