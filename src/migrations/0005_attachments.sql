-- Files and links on a service (decision 0011). A file is stored here, up to
-- 5 MB; anything bigger is added as a link. Both expire 7 days after the
-- service date (worked out from the date, never stored) and are deleted when a
-- scheduler runs the clean-up. content stays last so listing skips the bytes.
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('file', 'link')),
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  url TEXT,
  added_by INTEGER REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  content BLOB
);
CREATE INDEX attachments_service ON attachments(service_id);
