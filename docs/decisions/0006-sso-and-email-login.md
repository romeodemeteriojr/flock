# 6. Single sign-on (Google first), and log in with an email

Status: accepted

## TL;DR

- People get an optional **email** (unique, stored lowercase). Schedulers set it
  when adding or editing a person.
- The login box takes a **username or an email** with the password.
- **Sign in with <provider>** buttons, one per provider that is set up. Google is
  the first: set `FLOCK_GOOGLE_CLIENT_ID` and `FLOCK_GOOGLE_CLIENT_SECRET`.
  Only people a scheduler already added with that (verified) email get in.
  There is no self sign-up.
- Scopes: `openid email` only (no profile, no offline access). The access token
  is discarded; only the id_token's claims are read, once.
- Accounts are linked by the provider's **stable id** (`iss`/`sub`, OIDC Core
  §5.7), not by email. The email is used once, to link the first sign-in.
- A password is **optional**: provider-only people have none.
- No new dependencies: one `fetch` to the provider's token endpoint.

## Decision

- Generic OpenID Connect authorization code flow, scope `openid email`
  (`src/infra/oidc.js`). Providers are presets: label, endpoints, issuers and
  the env prefix of their two settings.
- Routes are provider-agnostic:
  - `GET /api/auth/options` lists the set-up providers (`[{id, label}]`).
  - `GET /api/auth/:provider` stores a random `state` in a 10-minute HttpOnly
    cookie scoped to `/api/auth/<provider>` and redirects to the provider.
  - `GET /api/auth/:provider/callback` checks the state, exchanges the code with
    the client secret, and checks the id_token's `aud`, `iss`, `exp` and `sub`
    (and `email_verified` when linking). The token comes straight from the provider over TLS, so
    its signature is not re-checked.
- Every callback outcome is a redirect: `/#/` with a session, or
  `/#/login?signin=failed`. Every refusal (unknown email, deactivated,
  unverified, bad state, provider error, unknown provider) gets the **same**
  message, so the page never reveals whether an email is in Flock; the reason
  is only logged (without the email). Failures count toward the per-IP throttle.
- The redirect URI is `FLOCK_PUBLIC_URL` (or the request's host) +
  `/api/auth/<provider>/callback`. Register exactly that URI with the provider.
- **Linking**: table `identities (provider, subject) -> person`, at most one
  account per provider per person. A linked account signs straight in, even if
  its email changed at the provider. An unlinked one links to the active person
  with that verified email; that also counts as joining and uses up the invite.
  A different account presenting a linked person's email is refused.
- **Joined** means "has a way in": a password or a linked account (derived in
  SQL, no extra column). Sessions, "at least one joined admin", the "Not joined
  yet" chip and invites all use it. Provider-only people have no password, so
  password login refuses them and **Change my password** is hidden.
- **Unlinking**: changing a person's email in Flock or **Reset password** unlinks
  their accounts (sign in again to re-link). A scheduler without a password
  cannot change their own email (it would log them out). **Deactivate** blocks
  every way in.

## Adding a provider

1. Add a preset to `PRESETS` in `src/infra/oidc.js` (label, `env` prefix,
   `authUrl`, `tokenUrl`, `issuers`, optional `extraParams`).
2. Set `<env>_CLIENT_ID` / `<env>_CLIENT_SECRET`. Config, routes, login buttons
   and validation pick it up. Providers that are not OIDC (no id_token with a
   verified email) need their own `exchange`.

## Not done

- Emailing invite links (Flock still sends no email).
- Linking an account from the invite page (would allow scope `openid` only).
- A way for people to see or unlink their own linked accounts.
