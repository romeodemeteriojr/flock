CREATE TABLE availability (
  person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  every_weeks INTEGER NOT NULL CHECK(every_weeks IN (0,1,2,3,4,6,8)),
  updated_at TEXT NOT NULL
);
