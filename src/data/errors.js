// Errors thrown by the data layer. Every adapter (SQLite now, maybe PostgreSQL later)
// must translate its own driver errors into these, so callers never see driver codes.

/** A unique rule was broken (for example a username or team name that is already taken). */
export class DuplicateError extends Error {
  /** @param {string} [message] */
  constructor(message = 'That already exists') {
    super(message);
    this.name = 'DuplicateError';
  }
}

/** A row cannot be removed or changed because other rows still use it (restrict / foreign key). */
export class InUseError extends Error {
  /** @param {string} [message] */
  constructor(message = 'That is still in use') {
    super(message);
    this.name = 'InUseError';
  }
}
