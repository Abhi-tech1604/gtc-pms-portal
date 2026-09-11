import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, details);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function wrap(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Spec 11.2: a malformed request or file produces a clear message naming the
 * problem, never an unhandled exception.
 */
export function errorHandler(
  err: Error & { status?: number; details?: unknown },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[pms]', err);
  res.status(status).json({
    error: err.message || 'The request could not be completed.',
    details: err.details ?? undefined,
  });
}
