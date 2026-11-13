// Who will be taken off when a position, team or service position goes:
// "Max Member (Drums, Sun 2 Feb) and Sam Singer (Vocals, Sun 9 Feb)".
import { formatDate } from './dates.js';

const SHOW = 5;

export function takenOffText(people = []) {
  const items = people.map((p) => `${p.name} (${[p.positionName, p.date && formatDate(p.date)].filter(Boolean).join(', ')})`);
  if (items.length > SHOW) {
    const more = items.length - SHOW;
    return `${items.slice(0, SHOW).join(', ')} and ${more} more`;
  }
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// The people from a has_people 409, or null for any other error.
export function peopleFrom(err) {
  if (err?.status !== 409 || err.code !== 'has_people') return null;
  return Array.isArray(err.data?.people) ? err.data.people : [];
}
