-- Sample tickets. Depends on a user named 'admin', which every profile seeds.
INSERT INTO tickets (title, description, status, priority, created_by)
SELECT t.title, t.description, t.status, t.priority, u.id
FROM (VALUES
  ('Login page shows wrong error', 'Error text should not reveal which field was wrong.', 'open', 'high'),
  ('Add dark theme to settings', 'Users can pick light or dark.', 'open', 'medium'),
  ('Typo on tickets page', 'Header reads "Tickts".', 'closed', 'low')
) AS t (title, description, status, priority)
CROSS JOIN (SELECT id FROM users WHERE username = 'admin') AS u;
