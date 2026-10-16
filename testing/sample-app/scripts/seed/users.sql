-- One user per role. Passwords are not stored: see sample-app/README.md.
INSERT INTO users (username, display_name, role, theme) VALUES
  ('viewer', 'Sample Viewer', 'viewer', 'light'),
  ('editor', 'Sample Editor', 'editor', 'light'),
  ('admin',  'Sample Admin',  'admin',  'dark');

INSERT INTO users (username, display_name, role, active) VALUES
  ('inactive', 'Sample Inactive', 'viewer', false);
