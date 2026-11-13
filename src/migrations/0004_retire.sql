-- Retired teams and positions (deleting one that has history retires it).
-- A retired row is hidden from every list and picker but stays so past
-- services still show it. NULL = active.
ALTER TABLE teams ADD COLUMN retired_at TEXT;
ALTER TABLE positions ADD COLUMN retired_at TEXT;
