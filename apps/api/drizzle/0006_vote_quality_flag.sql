-- Add quality flag to votes table to track potentially low-quality votes.
-- Flagged votes (e.g., decision time < 3s) are excluded from Elo computation.

ALTER TABLE votes ADD COLUMN quality_flagged BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for leaderboard filtering (Elo computation only uses unflagged votes)
CREATE INDEX votes_quality_flagged_idx ON votes (quality_flagged);
