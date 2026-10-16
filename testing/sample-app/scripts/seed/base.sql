-- Schema and reference data. Every seed profile starts with this file; it resets all tables.
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS feature_flags;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id           serial PRIMARY KEY,
  username     text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role         text NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  active       boolean NOT NULL DEFAULT true,
  theme        text NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark'))
);

CREATE TABLE feature_flags (
  name    text PRIMARY KEY,
  enabled boolean NOT NULL
);

CREATE TABLE tickets (
  id          serial PRIMARY KEY,
  title       text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  priority    text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  created_by  integer NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO feature_flags (name, enabled) VALUES
  ('ticket_priority', true),
  ('ticket_export', false);
