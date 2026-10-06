CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  csrf_token TEXT NOT NULL CHECK (length(csrf_token) = 64),
  credential_version TEXT NOT NULL CHECK (length(credential_version) = 64),
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  bucket_hash TEXT PRIMARY KEY CHECK (length(bucket_hash) = 64),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 9),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_login_expiry ON admin_login_attempts (expires_at);
