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
--     < deploy/sql/ops/mint-participants.sql
--
-- `-v kind=test` mints DRY-RUN codes instead — T01, T02, … with is_test
-- set — for walking the flow ourselves during the study window. They run
-- the identical path and are filtered back out at read time, from the
-- Bradley-Terry fit and from the admin exports. The two sequences are
-- counted separately, so minting ten test codes does not push the next real
-- participant to P31:
--
--   … psql -U reviewarena -d reviewarena -v count=10 -v kind=test \
--     < deploy/sql/ops/mint-participants.sql
--
-- ADDITIVE, like the script: it always creates `count` NEW rows and never
-- touches existing ones. Re-running mints another batch — that is the point,
-- but it is also why this is not idempotent. Check the total afterwards.
--
-- Shapes, kept in sync with seed-participants.ts:
--   id   'P' (or 'T' for dry runs) + zero-padded sequence, continuing from
--        the highest existing number of that prefix: P01..P20 already there
--        means the next real batch is P21..P40
--   code '<tree word>-<other tree word>-<4 digits>', e.g. maple-larch-4821
--        (32 x 31 x 9000 ~ 8.9M codes). Before 2026-10 it was
--        '<tree word>-<4 digits>' (20 x 9000 = 180k, enumerable against the
--        404-vs-200 of /study/state); codes already minted in that shape
--        stay valid, nothing here rewrites existing rows.
--
-- The sequence is a LABEL ONLY. Until 2026-09 the P-number doubled as a
-- schedule -- P01 meant rotations R1 then R2 -- which is what capped the
-- study at twenty slots. Rotations are now drawn per paper at upload by
-- nextRotationId(), so the number encodes nothing and any code can go to
-- any person in any order. It is sequential purely because it is easier to
-- read aloud, tick off a handout list, and paste into a status query than
-- a random string.

\if :{?count}
\else
  \set count 20
\endif

\if :{?kind}
\else
  \set kind real
\endif

BEGIN;

-- psql does not interpolate :variables inside a dollar-quoted body, so the
-- count is handed to the DO block through a custom GUC instead.
SET LOCAL mint.count = :count;
SET LOCAL mint.kind = :'kind';

DO $$
DECLARE
  want      int := current_setting('mint.count')::int;
  kind      text := current_setting('mint.kind');
  is_test_  boolean;
  prefix    text;
  words     text[] := ARRAY[
    'maple','cedar','birch','aspen','alder','hazel','rowan','olive',
    'pine','oak','elm','fir','ash','yew','beech','larch',
    'linden','spruce','walnut','willow',
    'poplar','cherry','holly','juniper','laurel','acacia','cypress','hemlock',
    'magnolia','sequoia','myrtle','sumac'
  ];
  nwords    int := array_length(words, 1);
  w1        int;
  next_n    int;
  made      int := 0;
  attempts  int := 0;
  new_id    text;
  new_code  text;
BEGIN
  -- Anything but the two spellings below is a typo worth stopping for: a
  -- silent fallback to 'real' would put dry-run codes on the handout sheet.
  IF kind = 'test' THEN
    is_test_ := true;
    prefix   := 'T';
  ELSIF kind = 'real' THEN
    is_test_ := false;
    prefix   := 'P';
  ELSE
    RAISE EXCEPTION 'kind must be ''real'' or ''test'', got: %', kind;
  END IF;

  -- Continue the sequence rather than restarting it, per prefix. Only ids of
  -- the form P<digits> / T<digits> count: anything else in the table (the
  -- p_xxxxxxxx shape the tsx script used to mint) is ignored rather than
  -- parsed.
  SELECT coalesce(max(substring(id from '^' || prefix || '([0-9]+)$')::int), 0) + 1
    INTO next_n
    FROM participants
   WHERE id ~ ('^' || prefix || '[0-9]+$');

  WHILE made < want LOOP
    attempts := attempts + 1;
    IF attempts > want * 100 THEN
      RAISE EXCEPTION
        'gave up after % attempts with only % of % minted -- the code space '
        'is probably crowded; widen WORDS or the digit range', attempts, made, want;
    END IF;

    new_id := prefix || lpad(next_n::text, 2, '0');

    -- Two distinct words + 1000..9999, matching newCode() in the script.
    -- The second index is offset from the first by 1..nwords-1 (mod
    -- nwords), so the words never repeat.
    w1 := floor(random() * nwords)::int;
    new_code := words[1 + w1]
                || '-' || words[1 + (w1 + 1 + floor(random() * (nwords - 1))::int) % nwords]
                || '-' || (1000 + floor(random() * 9000))::int::text;

    -- Only the code can collide; the id is sequential and checked above.
    -- A collision just costs another spin of the loop, same id next time.
    INSERT INTO participants (id, code, is_test) VALUES (new_id, new_code, is_test_)
    ON CONFLICT DO NOTHING;

    IF FOUND THEN
      made := made + 1;
      next_n := next_n + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'minted % % participant(s) (through %) in % attempt(s)',
    made, kind, new_id, attempts;
END $$;

COMMIT;

\echo ''
\echo 'All participants (hand out any REAL row with 0 papers and 0 votes):'
SELECT p.id,
       p.code,
       CASE WHEN p.is_test THEN 'test' ELSE 'real' END AS kind,
       count(DISTINCT pa.id) AS papers,
       count(DISTINCT v.id)  AS votes
FROM participants p
LEFT JOIN papers pa ON pa.participant_id = p.id
LEFT JOIN votes  v  ON v.participant_id  = p.id
GROUP BY p.id, p.code, p.is_test
ORDER BY p.is_test, papers, votes, p.id;
