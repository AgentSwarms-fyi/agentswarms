
-- Retroactively pass the QA test account's most recent failed attempt and
-- issue a certificate so the LinkedIn add-to-profile flow can be tested.
DO $$
DECLARE
  v_user_id uuid;
  v_attempt_id uuid := '2cb12642-b3f6-400f-b3b8-4c31c0bb12bf';
  v_cert_exists boolean;
  v_code text;
  v_display text;
BEGIN
  SELECT user_id INTO v_user_id FROM public.exam_attempts WHERE id = v_attempt_id;
  IF v_user_id IS NULL THEN RETURN; END IF;

  UPDATE public.exam_attempts
  SET status = 'passed',
      mcq_score = 50,
      mcq_total = 50,
      agent_eval = jsonb_build_object('score_pct', 100, 'per_item', '[]'::jsonb, 'feedback', 'Test-account override.'),
      swarm_eval = jsonb_build_object('score_pct', 100, 'per_item', '[]'::jsonb, 'feedback', 'Test-account override.'),
      evaluator_feedback = 'Test-account override: full marks granted for QA flow.',
      improvement_areas = '[]'::jsonb,
      next_eligible_at = NULL,
      submitted_at = COALESCE(submitted_at, now())
  WHERE id = v_attempt_id;

  SELECT EXISTS(SELECT 1 FROM public.certificates WHERE attempt_id = v_attempt_id) INTO v_cert_exists;
  IF NOT v_cert_exists THEN
    SELECT COALESCE(display_name, 'Certified Practitioner') INTO v_display
    FROM public.profiles WHERE user_id = v_user_id LIMIT 1;
    v_code := 'ASW-' || EXTRACT(YEAR FROM now())::text || '-' || upper(substr(md5(random()::text), 1, 6));
    INSERT INTO public.certificates(user_id, attempt_id, mcq_score, agent_score, swarm_score, name_on_cert, verification_code)
    VALUES (v_user_id, v_attempt_id, 100, 100, 100, COALESCE(v_display, 'Certified Practitioner'), v_code);
  END IF;
END $$;
