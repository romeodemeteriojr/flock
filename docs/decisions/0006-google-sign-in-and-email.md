# 6. Sign in with Google, and log in with an email

Status: accepted

## TL;DR

- People get an optional **email** (unique, stored lowercase). Schedulers set it
  when adding or editing a person.
- The login box takes a **username or an email** with the password.
- **Sign in with Google** appears when `FLOCK_GOOGLE_CLIENT_ID` and
  `FLOCK_GOOGLE_CLIENT_SECRET` are set. Only people a scheduler already added
  with that (Google-verified) email get in. There is no self sign-up.
- No new dependencies: one `fetch` to Google's token endpoint.

## Decision

- OpenID Connect authorization code flow, scope `openid email`.
  `GET /api/auth/google` stores a random `state` in a 10-minute HttpOnly
  cookie (path `/api/auth/google`) and redirects to Google.
  `GET /api/auth/google/callback` checks the state, exchanges the code with the
  client secret, and checks the id_token's `aud`, `iss`, `exp` and
  `email_verified`. The token comes straight from Google over TLS, so its
  signature is not re-checked (Google's documented allowance for this flow).
- Every callback outcome is a redirect: `/#/` with a session, or
  `/#/login?google=failed`. Every refusal (unknown email, deactivated,
  unverified, bad state, Google error) gets the **same** message, so the page
  never reveals whether an email is in Flock; the real reason is only logged
  (without the email). Failures count toward the per-IP throttle.
- The redirect URI is `FLOCK_PUBLIC_URL` (or the request's host) +
  `/api/auth/google/callback`. Register exactly that URI in Google Cloud.
- **Joining through Google**: a person who never joined gets an unknowable
  random password hash and their invite is deleted. So "joined", "at least one
  joined admin" and session checks keep their meaning without a new column.
- Resetting a password does not stop Google sign-in; **deactivate** a person to
  lock them out.

## Not done

- Emailing invite links (Flock still sends no email).
- Linking by Google account id (`sub`): the email is the key, so changing a
  person's email in Flock changes who can sign in as them.
