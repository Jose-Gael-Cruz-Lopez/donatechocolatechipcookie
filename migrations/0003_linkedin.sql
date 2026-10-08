-- Optional: not everyone has a LinkedIn profile yet.
ALTER TABLE community_members ADD COLUMN linkedin TEXT NOT NULL DEFAULT '' CHECK (length(linkedin) <= 200);
