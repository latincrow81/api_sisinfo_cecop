export type TokenScope = 'manage_alert' | 'manage_email' | 'unsubscribe';
export interface TokenPayload {
    sub: string;
    scope: TokenScope;
    exp: number;
    iat: number;
}
export declare function signToken(payload: Omit<TokenPayload, 'iat'>, secret: string): Promise<string>;
export interface VerifyOk {
    ok: true;
    payload: TokenPayload;
}
export interface VerifyErr {
    ok: false;
    reason: 'malformed' | 'bad_signature' | 'expired';
}
export declare function verifyToken(token: string, secret: string): Promise<VerifyOk | VerifyErr>;
export declare const TOKEN_TTL: {
    verify: number;
    manage: number;
    unsubscribe: number;
};
