// Typed errors that the global onError handler converts to the envelope shape.

import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorCodeValue =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'INTERNAL';

export class ApiError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: ContentfulStatusCode;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCodeValue,
    message: string,
    status: ContentfulStatusCode,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const notFound = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError('NOT_FOUND', message, 404, details);

export const validation = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError('VALIDATION_ERROR', message, 400, details);

export const internal = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError('INTERNAL', message, 500, details);
