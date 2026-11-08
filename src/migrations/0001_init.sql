CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE COLLATE NOCASE, -- the login; NULL = can be scheduled but cannot log in
  password_hash TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE invites (
  person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_person ON sessions(person_id);
-- Linked sign-in provider accounts (decision 0006). (provider, subject) is the
-- provider's stable id for the account (OIDC iss + sub); one account per provider per person.
CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (person_id, provider)
);
CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE(team_id, name)
);
CREATE TABLE person_positions (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  PRIMARY KEY(person_id, position_id)
);
CREATE INDEX idx_person_positions_position ON person_positions(position_id);
CREATE TABLE services (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '09:00',
  title TEXT NOT NULL,
  UNIQUE(date, time)
);
CREATE TABLE slots (
  id INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  position_id INTEGER NOT NULL REFERENCES positions(id),
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','pending','accepted','declined')),
  assigned_at TEXT,
  responded_at TEXT
);
CREATE INDEX idx_slots_service ON slots(service_id);
CREATE INDEX idx_slots_person ON slots(person_id);
CREATE INDEX idx_slots_position ON slots(position_id);
CREATE TABLE blockouts (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK(end_date >= start_date)
);
CREATE INDEX idx_blockouts_person ON blockouts(person_id, start_date, end_date);
CREATE INDEX idx_blockouts_dates ON blockouts(start_date, end_date);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_at ON audit(at);
