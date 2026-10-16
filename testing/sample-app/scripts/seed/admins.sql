-- Admin-heavy profile: several admins and one viewer, for permission matrix tests.
INSERT INTO users (username, display_name, role) VALUES
  ('admin',  'Sample Admin',        'admin'),
  ('admin2', 'Sample Second Admin', 'admin'),
  ('admin3', 'Sample Third Admin',  'admin'),
  ('viewer', 'Sample Viewer',       'viewer');
