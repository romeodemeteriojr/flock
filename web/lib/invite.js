/** The first part of the person's name, for a friendly greeting. */
export function firstName(name) {
  return String(name).trim().split(/\s+/)[0] || String(name);
}

/** The ready-to-send message; callers render it as escaped text or copy it as plain text. */
export function inviteMessage({ name, username, link }) {
  return `Hi ${firstName(name)}, you've been added to Flock. Tap this link to choose your password: ${link} `
    + `Your username is ${username}. The link works for 7 days.`;
}
