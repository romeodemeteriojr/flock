-- Push notifications (decision 0008): the devices a person turned them on for.
-- endpoint is the push service address of one browser on one device.
CREATE TABLE push_devices (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX push_devices_person ON push_devices(person_id);
