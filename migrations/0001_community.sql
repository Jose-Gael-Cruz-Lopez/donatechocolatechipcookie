-- Private signup storage; the Worker exposes no read/list API.
CREATE TABLE IF NOT EXISTS community_members (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  school TEXT NOT NULL CHECK (length(school) BETWEEN 1 AND 150),
  grade TEXT NOT NULL CHECK (length(grade) BETWEEN 1 AND 80),
  fun_fact TEXT NOT NULL CHECK (length(fun_fact) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Window-specific hashes, never raw IP addresses. Expired buckets are removed on
-- the next valid form request; they are not permanent analytics or member data.
CREATE TABLE IF NOT EXISTS join_rate_limits (
  bucket_hash TEXT PRIMARY KEY CHECK (length(bucket_hash) = 64),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 31),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS join_rate_limits_expiry ON join_rate_limits (expires_at);
