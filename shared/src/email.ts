// Resend HTTP client. Used by api (magic links) and match (digests).

export interface ResendEnv {
  RESEND_API_KEY: string;
  ALERT_EMAIL_FROM: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(env: Partial<ResendEnv>, msg: EmailMessage): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  if (!env.ALERT_EMAIL_FROM) throw new Error('ALERT_EMAIL_FROM is not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.ALERT_EMAIL_FROM,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      ...(msg.text ? { text: msg.text } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend ${res.status}: ${body.slice(0, 500)}`);
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
