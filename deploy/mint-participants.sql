-- Mint N more study participants, without the DB tunnel.
--
-- The canonical minter is apps/api/scripts/seed-participants.ts, but that is
-- a tsx script and prod Postgres publishes no host port, so running it
-- against production means standing up deploy/docker-compose.db-tunnel.yml
-- first. This reproduces its id and code shapes in SQL so it can go through
-- the same `exec -T postgres psql` path as every other script in here.
--
--   sudo docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U reviewarena -d reviewarena -v count=20 \
--     < deploy/mint-participants.sql
--
-- ADDITIVE, like the script: it always creates `count` NEW rows and never
-- touches existing ones. Re-running mints another batch — that is the point,
-- but it is also why this is not idempotent. Check the total afterwards.
--
-- Shapes, kept in sync with seed-participants.ts:
--   id   'p_' + 8 chars of abcdefghijkmnpqrstuvwxyz23456789
--        (no l/1/o/0 -- ids get read aloud and typed into queries)
--   code '<tree word>-<4 digits>'
--
-- Participant ids carry NO schedule. Rotations are drawn per paper at upload
-- by nextRotationId(), so any code can go to any person in any order.

\if :{?count}
\else
  \set count 20
\endif

BEGIN;

-- psql does not interpolate :variables inside a dollar-quoted body, so the
-- count is handed to the DO block through a custom GUC instead.
SET LOCAL mint.count = :count;

DO $$
DECLARE
  want      int := current_setting('mint.count')::int;
  alphabet  text := 'abcdefghijkmnpqrstuvwxyz23456789';
  words     text[] := ARRAY[
    'maple','cedar','birch','aspen','alder','hazel','rowan','olive',
    'pine','oak','elm','fir','ash','yew','beech','larch',
    'linden','spruce','walnut','willow'
  ];
  made      int := 0;
  attempts  int := 0;
  new_id    text;
  new_code  text;
  i         int;
BEGIN
  WHILE made < want LOOP
    attempts := attempts + 1;
    IF attempts > want * 100 THEN
      RAISE EXCEPTION
        'gave up after % attempts with only % of % minted -- the code space '
        'is probably crowded; widen WORDS or the digit range', attempts, made, want;
    END IF;

    new_id := 'p_';
    FOR i IN 1..8 LOOP
      new_id := new_id || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;

    -- 1000..9999, matching randomInt(1000, 10000) in the script.
    new_code := words[1 + floor(random() * array_length(words, 1))::int]
                || '-' || (1000 + floor(random() * 9000))::int::text;

    -- A collision on either column just costs another spin of the loop.
    INSERT INTO participants (id, code) VALUES (new_id, new_code)
    ON CONFLICT DO NOTHING;

    IF FOUND THEN
      made := made + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'minted % participant(s) in % attempt(s)', made, attempts;
END $$;

COMMIT;

\echo ''
\echo 'All participants (hand out any row with 0 papers and 0 votes):'
SELECT p.id,
       p.code,
       count(DISTINCT pa.id) AS papers,
       count(DISTINCT v.id)  AS votes
FROM participants p
LEFT JOIN papers pa ON pa.participant_id = p.id
LEFT JOIN votes  v  ON v.participant_id  = p.id
GROUP BY p.id, p.code
ORDER BY papers, votes, p.id;
