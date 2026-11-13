// The numbers on the tabs and on the app icon: how many asks you still have to
// answer, and (schedulers) how many positions are not filled. Plain functions,
// no browser parts; loadCounts takes the api.

/** Asks still waiting for an answer, from GET /api/me/schedule. */
export function answerCount(schedule) {
  const items = Array.isArray(schedule?.items) ? schedule.items : [];
  return items.filter((i) => i?.status === 'pending').length;
}

/** Gaps in the next weeks, from GET /api/admin/gaps. */
export function gapCount(gaps) {
  return Array.isArray(gaps?.items) ? gaps.items.length : 0;
}

/** What a badge shows: nothing at 0, "9+" above 9. */
export function badgeText(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n > 9 ? '9+' : String(Math.floor(n));
}

/** { answer, gaps }. Gaps only for schedulers. A failed call counts as 0: badges are a hint. */
export async function loadCounts(api, user) {
  if (!user) return { answer: 0, gaps: 0 };
  const isAdmin = user.role === 'admin';
  const [schedule, gaps] = await Promise.all([
    api.get('/api/me/schedule').catch(() => null),
    isAdmin ? api.get('/api/admin/gaps').catch(() => null) : null,
  ]);
  return { answer: answerCount(schedule), gaps: isAdmin ? gapCount(gaps) : 0 };
}

/** The number on the installed app's icon: the asks you have to answer. Never throws. */
export function setAppBadge(win, n) {
  const nav = win?.navigator;
  try {
    const done = n > 0 ? nav?.setAppBadge?.(n) : nav?.clearAppBadge?.();
    done?.catch?.(() => {});
  } catch { /* not supported, or not installed */ }
}
