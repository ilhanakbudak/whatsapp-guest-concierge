/** Base for errors we raise deliberately and can map to an HTTP response. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "validation_error", details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "unauthorized");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403, "forbidden");
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, "not_found");
  }
}

export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many requests", 429, "rate_limited", { retryAfterSeconds });
  }
}

/** An upstream dependency (Twilio, Google, the LLM provider) failed. */
export class UpstreamError extends AppError {
  constructor(
    readonly service: string,
    message: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(`${service}: ${message}`, 502, "upstream_error");
    this.cause = cause;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Narrow an unknown thrown value to a message without losing non-Error throws. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}
