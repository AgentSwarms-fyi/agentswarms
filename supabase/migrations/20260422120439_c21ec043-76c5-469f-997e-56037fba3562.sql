-- Re-shuffle correct answer positions in all stored exam_question_sets.
-- Handles both schemas: {options, correct_index} and {options, correct} and {options, answer}.
DO $$
DECLARE
  s RECORD;
  qs jsonb;
  new_qs jsonb;
  q jsonb;
  opts jsonb;
  n int;
  i int;
  j int;
  perm int[];
  tmp int;
  ci_field text;
  ci int;
  correct_text jsonb;
  new_idx int;
  new_opts jsonb;
BEGIN
  FOR s IN SELECT id, questions FROM exam_question_sets LOOP
    qs := s.questions;
    new_qs := '[]'::jsonb;

    FOR q IN SELECT * FROM jsonb_array_elements(qs) LOOP
      opts := q->'options';
      IF opts IS NULL OR jsonb_typeof(opts) <> 'array' THEN
        new_qs := new_qs || jsonb_build_array(q);
        CONTINUE;
      END IF;
      n := jsonb_array_length(opts);
      IF n < 2 THEN
        new_qs := new_qs || jsonb_build_array(q);
        CONTINUE;
      END IF;

      -- Find which field holds the correct index
      IF q ? 'correct_index' THEN ci_field := 'correct_index';
      ELSIF q ? 'correct' THEN ci_field := 'correct';
      ELSIF q ? 'answer' THEN ci_field := 'answer';
      ELSE
        new_qs := new_qs || jsonb_build_array(q);
        CONTINUE;
      END IF;

      ci := (q->>ci_field)::int;
      IF ci < 0 OR ci >= n THEN
        new_qs := new_qs || jsonb_build_array(q);
        CONTINUE;
      END IF;
      correct_text := opts -> ci;

      perm := ARRAY(SELECT generate_series(0, n - 1));
      PERFORM setseed(random());
      FOR i IN REVERSE n - 1 .. 1 LOOP
        j := floor(random() * (i + 1))::int;
        IF j <> i THEN
          tmp := perm[i + 1];
          perm[i + 1] := perm[j + 1];
          perm[j + 1] := tmp;
        END IF;
      END LOOP;

      SELECT jsonb_agg(opts -> perm[ord]) INTO new_opts
      FROM generate_series(1, n) AS ord;

      new_idx := NULL;
      FOR i IN 0 .. n - 1 LOOP
        IF (new_opts -> i) = correct_text THEN
          new_idx := i;
          EXIT;
        END IF;
      END LOOP;

      IF new_idx IS NULL THEN
        new_qs := new_qs || jsonb_build_array(q);
      ELSE
        new_qs := new_qs || jsonb_build_array(
          jsonb_set(jsonb_set(q, '{options}', new_opts), ARRAY[ci_field], to_jsonb(new_idx))
        );
      END IF;
    END LOOP;

    UPDATE exam_question_sets SET questions = new_qs WHERE id = s.id;
  END LOOP;
END $$;