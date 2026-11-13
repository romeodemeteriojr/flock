// Who a change takes off, for the has_people 409. One person can hold up to 3
// positions on one service (decision 0010), so slots are grouped: one entry per
// person per service ("Pat (Vocals and Keys, Sun 15 Nov)"), and `count` is the
// number of different people, not slots.

const joinAnd = (parts) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

/** @param {Array<{personId:number, personName:string, positionName:string, serviceId:number, serviceDate:string}>} held */
export function takenOff(held) {
  const groups = new Map();
  for (const s of held) {
    const key = `${s.personId}:${s.serviceId}`;
    if (!groups.has(key)) groups.set(key, { name: s.personName, positions: [], date: s.serviceDate });
    groups.get(key).positions.push(s.positionName);
  }
  const people = [...groups.values()].map((g) => ({ name: g.name, positionName: joinAnd(g.positions), date: g.date }));
  return { count: new Set(held.map((s) => s.personId)).size, people };
}
