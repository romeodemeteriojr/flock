-- Optional email per person: log in with it, or with Google (decision 0006).
-- Stored lowercase; NULLs do not clash in a UNIQUE index.
ALTER TABLE people ADD COLUMN email TEXT;
CREATE UNIQUE INDEX people_email ON people(email);
