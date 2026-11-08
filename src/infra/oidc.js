// Single sign-on providers (OpenID Connect, authorization code flow), decision 0006.
// A provider is two calls: the URL we send the browser to, and a server-to-server
// code exchange. The id_token comes straight from the provider's token endpoint
// over TLS (authenticated with our client secret), so its signature is not
// re-checked; its audience, issuer and expiry are.
//
// Adding a provider = one preset below + its two settings in src/config.js.

/** Known providers. `env` is the prefix of their settings: <env>_CLIENT_ID / _CLIENT_SECRET. */
export const PRESETS = Object.freeze({
  google: {
    label: 'Google',
    env: 'FLOCK_GOOGLE',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    extraParams: { prompt: 'select_account' },
  },
});

/**
 * @param {{id: string, label: string, authUrl: string, tokenUrl: string, issuers: string[],
 *          extraParams?: object, clientId: string, clientSecret: string, fetch?: Function}} opts
 */
export function oidcProvider({ id, label, authUrl, tokenUrl, issuers, extraParams = {}, clientId, clientSecret,
  fetch = (u, i) => globalThis.fetch(u, i) }) {
  return {
    id,
    label,

    authUrl({ state, redirectUri }) {
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: 'openid email', state, ...extraParams,
      });
      return `${authUrl}?${q}`;
    },

    /** Code -> {subject, email, emailVerified}. Throws on any problem. */
    async exchange({ code, redirectUri, nowMs }) {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code',
        }).toString(),
      });
      if (!res.ok) throw new Error(`${label} token exchange failed (${res.status})`);
      const { id_token: idToken } = await res.json();
      const claims = JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString('utf8'));
      if (claims.aud !== clientId) throw new Error(`${label} id_token has the wrong audience`);
      if (!issuers.includes(claims.iss)) throw new Error(`${label} id_token has the wrong issuer`);
      if (!(Number(claims.exp) * 1000 > nowMs)) throw new Error(`${label} id_token has expired`);
      if (typeof claims.sub !== 'string' || claims.sub === '' || claims.sub.length > 255) throw new Error(`${label} id_token has no subject`);
      return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null, emailVerified: claims.email_verified === true };
    },
  };
}

/**
 * The providers that are set up: {id: provider}. `settings` is config.sso ({id: {clientId, clientSecret}}).
 * @param {Record<string, {clientId?: string, clientSecret?: string}>} [settings]
 * @param {{fetch?: Function}} [opts]
 */
export function ssoProviders(settings = {}, { fetch } = {}) {
  const out = {};
  for (const [id, s] of Object.entries(settings)) {
    if (!PRESETS[id] || !s?.clientId || !s?.clientSecret) continue;
    out[id] = oidcProvider({ id, ...PRESETS[id], clientId: s.clientId, clientSecret: s.clientSecret, ...(fetch ? { fetch } : {}) });
  }
  return out;
}
