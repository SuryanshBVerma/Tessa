-- Admin-heavy profile: the default users plus two more admins, for permission matrix tests.
-- The first three users are inserted in the same order as users.sql, so user ids (and so
-- signed-in sessions, which store the id) mean the same person under either profile.
INSERT INTO users (username, display_name, role, theme) VALUES
  ('viewer', 'Sample Viewer', 'viewer', 'light'),
  ('editor', 'Sample Editor', 'editor', 'light'),
  ('admin',  'Sample Admin',  'admin',  'dark');

INSERT INTO users (username, display_name, role) VALUES
  ('admin2', 'Sample Second Admin', 'admin'),
  ('admin3', 'Sample Third Admin',  'admin');
