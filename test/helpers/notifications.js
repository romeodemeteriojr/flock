// A stand-in for the notifications service in unit tests that build services
// by hand: records each event as [name, ...args] and sends nothing.
export function recordingNotifications() {
  const events = [];
  const rec = (name) => (...args) => { events.push([name, ...args]); };
  return { events, settings: () => ({ enabled: false, publicKey: null }), asked: rec('asked'), removed: rec('removed'), moved: rec('moved'), cancelled: rec('cancelled'), declined: rec('declined') };
}
