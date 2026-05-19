import type { ResendEnv, TursoEnv } from '@secop/shared';

export interface ApiBindings extends TursoEnv, ResendEnv {
  AI: Ai;
  HMAC_SECRET: string;
  API_BASE_URL: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_TOKEN?: string;
  QUOTA_WEBHOOK_URL?: string;
}

// Reserved for handler-set context values (e.g. requestId). Empty for now.
export type ApiVariables = Record<string, never>;
