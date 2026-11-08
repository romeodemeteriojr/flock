// "Sign in with Google" (OpenID Connect, authorization code flow), decision 0006.
// Only two calls: the URL we send the browser to, and a server-to-server code
// exchange. The id_token comes straight from Google's token endpoint over TLS
// (authenticated with our client secret), so its signature is not re-checked;
// its audience, issuer and expiry are.

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * @param {{clientId?: string, clientSecret?: string, fetch?: Function}} opts
 * @returns {{enabled: boolean, authUrl: Function, exchange: Function}}
 */
export function googleOAuth({ clientId, clientSecret, fetch = (u, i) => globalThis.fetch(u, i) } = {}) {
  const enabled = !!(clientId && clientSecret);
  return {
    enabled,

    authUrl({ state, redirectUri }) {
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: 'openid email', state, prompt: 'select_account',
      });
      return `${AUTH_URL}?${q}`;
    },

    /** Code -> {email, emailVerified}. Throws on any problem. */
    async exchange({ code, redirectUri, nowMs }) {
      if (!enabled) throw new Error('Google sign-in is not set up');
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code',
        }).toString(),
      });
      if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
      const { id_token: idToken } = await res.json();
      const claims = JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString('utf8'));
      if (claims.aud !== clientId) throw new Error('Google id_token has the wrong audience');
      if (!ISSUERS.includes(claims.iss)) throw new Error('Google id_token has the wrong issuer');
      if (!(Number(claims.exp) * 1000 > nowMs)) throw new Error('Google id_token has expired');
      return { email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null, emailVerified: claims.email_verified === true };
    },
  };
}
