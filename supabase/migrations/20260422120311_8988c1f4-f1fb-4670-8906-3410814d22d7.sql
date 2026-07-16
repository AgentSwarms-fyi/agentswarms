-- Randomize correct answer position across all quiz_questions.
DO $$
DECLARE
  q RECORD;
  opts jsonb;
  n int;
  i int;
  j int;
  perm int[];
  correct_text jsonb;
  new_idx int;
  seed_float float8;
BEGIN
  FOR q IN SELECT id, options, correct_index FROM quiz_questions LOOP
    opts := q.options;
    n := jsonb_array_length(opts);
    IF n < 2 THEN CONTINUE; END IF;

    correct_text := opts -> q.correct_index;
    perm := ARRAY(SELECT generate_series(0, n - 1));

    -- Deterministic seed from question id (range -1..1)
    seed_float := (('x' || substr(md5(q.id::text), 1, 8))::bit(32)::int)::float8 / 2147483647.0;
    IF seed_float > 0.999999 THEN seed_float := 0.999999; END IF;
    IF seed_float < -0.999999 THEN seed_float := -0.999999; END IF;
    PERFORM setseed(seed_float);

    FOR i IN REVERSE n - 1 .. 1 LOOP
      j := floor(random() * (i + 1))::int;
      IF j <> i THEN
        perm := perm[1:j] || perm[i+1:i+1] || perm[j+2:i] || perm[j+1:j+1] || perm[i+2:array_length(perm,1)];
      END IF;
    END LOOP;

    SELECT jsonb_agg(opts -> perm[ord]) INTO opts
    FROM generate_series(1, n) AS ord;

    new_idx := NULL;
    FOR i IN 0 .. n - 1 LOOP
      IF (opts -> i) = correct_text THEN
        new_idx := i;
        EXIT;
      END IF;
    END LOOP;

    IF new_idx IS NOT NULL THEN
      UPDATE quiz_questions
      SET options = opts, correct_index = new_idx
      WHERE id = q.id;
    END IF;
  END LOOP;
END $$;