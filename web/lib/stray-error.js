// Which page-wide errors are Flock's own, and worth the "Something went wrong" toast.
//
// Browsers also fire window "error" and "unhandledrejection" events that carry
// no error at all: a script from another site ("Script error."), the
// browser's own internals, an extension, or a request the browser cancelled
// while the page went to the background. On an iPhone this happens around
// Share → Add to Home Screen, which installs Flock fine but used to show the
// toast. Those are logged, not shown.

/** The error a window "error" event carries, or null when it carries none. */
export function errorFromEvent(e) {
  const err = e?.error;
  return err && typeof err === 'object' ? err : null;
}

/** The reason of an "unhandledrejection" event, or null when it is not a real failure. */
export function reasonFromEvent(e) {
  const reason = e?.reason;
  if (reason == null || typeof reason !== 'object') return null;
  if (reason.name === 'AbortError') return null; // cancelled on purpose, or by the browser
  return reason;
}
