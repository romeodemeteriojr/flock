-- Sign-in: optional email, and linked provider accounts (decision 0006).
-- Email is stored lowercase; NULLs do not clash in a UNIQUE index.
ALTER TABLE people ADD COLUMN email TEXT;
CREATE UNIQUE INDEX people_email ON people(email);

-- One row per linked provider account. (provider, subject) is the provider's
-- stable id for the account (OIDC iss + sub); at most one account per provider per person.
CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (person_id, provider)
);
