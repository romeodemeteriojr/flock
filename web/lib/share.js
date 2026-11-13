// The phone's share sheet (Messages, WhatsApp, email…) for invites and
// reminders, where the browser has one. Copy stays for everyone else.
// Every browser part comes from `win`; nothing runs at import.

/** Does this browser have a share sheet? */
export function canShare(win) {
  return typeof win?.navigator?.share === 'function';
}

/**
 * Opens the share sheet. Resolves true when shared, false when the person
 * closed the sheet (nothing to say). Anything else is thrown: the caller
 * falls back to Copy.
 */
export async function share(win, { title, text }) {
  try {
    await win.navigator.share({ title, text });
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') return false;
    throw err;
  }
}
