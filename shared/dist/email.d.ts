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
export declare function sendEmail(env: Partial<ResendEnv>, msg: EmailMessage): Promise<void>;
export declare function escapeHtml(s: string): string;
