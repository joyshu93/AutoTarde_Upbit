ALTER TABLE operator_notifications
  ADD COLUMN lease_token TEXT;

ALTER TABLE operator_notifications
  ADD COLUMN lease_expires_at TEXT;
