-- Re-shuffle to get a flatter distribution. Uses random() seeded per row from gen_random_uuid().
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
  tmp int;
BEGIN
  FOR q IN SELECT id, options, correct_index FROM quiz_questions LOOP
    opts := q.options;
    n := jsonb_array_length(opts);
    IF n < 2 THEN CONTINUE; END IF;

    correct_text := opts -> q.correct_index;
    perm := ARRAY(SELECT generate_series(0, n - 1));

    -- Fresh randomness per row
    PERFORM setseed(random());

    FOR i IN REVERSE n - 1 .. 1 LOOP
      j := floor(random() * (i + 1))::int;
      IF j <> i THEN
        tmp := perm[i + 1];
        perm[i + 1] := perm[j + 1];
        perm[j + 1] := tmp;
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