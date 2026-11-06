// Errors the service layer throws. The HTTP layer turns them into responses:
// { error: message, code? } with the error's status.
//
// Every error has a `code`, but only codes that were passed in explicitly are
// sent to the client (`exposeCode`), so existing JSON shapes such as
// { error: 'Please log in' } can be kept exactly when handlers move to throwing.

function readOpts(opts) {
  if (typeof opts === 'string') return { code: opts };
  return opts && typeof opts === 'object' ? opts : {};
}

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.exposeCode = true;
  }
}

function makeSub(name, status, defaultCode, defaultMessage) {
  return class extends AppError {
    constructor(message = defaultMessage, opts) {
      const o = readOpts(opts);
      super(status, o.code ?? defaultCode, message, o.details);
      this.name = name;
      this.exposeCode = o.code !== undefined;
    }
  };
}

export const ValidationError = makeSub('ValidationError', 400, 'validation_error', 'That request was not valid');
export const UnauthenticatedError = makeSub('UnauthenticatedError', 401, 'unauthenticated', 'Please log in');
export const ForbiddenError = makeSub('ForbiddenError', 403, 'forbidden', 'You are not allowed to do that');
export const NotFoundError = makeSub('NotFoundError', 404, 'not_found', 'Not found');
export const ConflictError = makeSub('ConflictError', 409, 'conflict', 'That clashes with something that already exists');

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many tries. Please wait and try again', retryAfterSec = 60, opts) {
    const o = readOpts(opts);
    super(429, o.code ?? 'too_many_requests', message, o.details);
    this.name = 'TooManyRequestsError';
    this.exposeCode = o.code !== undefined;
    const n = Math.ceil(Number(retryAfterSec));
    this.retryAfterSec = Number.isFinite(n) && n > 0 ? n : 1;
  }
}
