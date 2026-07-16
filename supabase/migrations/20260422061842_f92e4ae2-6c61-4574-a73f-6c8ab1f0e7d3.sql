
-- =========================================
-- Per-track quiz questions
-- =========================================
CREATE TABLE public.quiz_questions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  question TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  correct_index INTEGER NOT NULL,
  explanation TEXT,
  difficulty TEXT NOT NULL DEFAULT 'easy',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_quiz_questions_track ON public.quiz_questions(track_id, position);
ALTER TABLE public.quiz_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authed students can read quiz questions"
  ON public.quiz_questions FOR SELECT TO authenticated USING (true);

-- =========================================
-- Per-track quiz attempts
-- =========================================
CREATE TABLE public.quiz_attempts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  track_id TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 5,
  passed BOOLEAN NOT NULL DEFAULT false,
  answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_quiz_attempts_user_track ON public.quiz_attempts(user_id, track_id, created_at DESC);
ALTER TABLE public.quiz_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own quiz attempts"
  ON public.quiz_attempts FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- =========================================
-- Weekly exam question sets (50 MCQs each)
-- =========================================
CREATE TABLE public.exam_question_sets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  week_label TEXT NOT NULL,
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_seed BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exam_sets_active ON public.exam_question_sets(is_active, created_at DESC);
ALTER TABLE public.exam_question_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authed students can read exam sets"
  ON public.exam_question_sets FOR SELECT TO authenticated USING (true);

-- =========================================
-- Certification exam attempts
-- =========================================
CREATE TABLE public.exam_attempts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  set_id UUID NOT NULL REFERENCES public.exam_question_sets(id),
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | passed | failed
  mcq_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  mcq_score INTEGER NOT NULL DEFAULT 0,
  mcq_total INTEGER NOT NULL DEFAULT 50,
  selected_agent_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  selected_swarm_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  agent_eval JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { score, perAgent: [{id,name,passed,feedback}] }
  swarm_eval JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { score, perSwarm: [{id,name,passed,feedback}] }
  evaluator_feedback TEXT,
  improvement_areas JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_eligible_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exam_attempts_user ON public.exam_attempts(user_id, created_at DESC);
CREATE INDEX idx_exam_attempts_user_set ON public.exam_attempts(user_id, set_id);
ALTER TABLE public.exam_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own exam attempts"
  ON public.exam_attempts FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_exam_attempts_updated_at
BEFORE UPDATE ON public.exam_attempts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================================
-- Issued certificates
-- =========================================
CREATE TABLE public.certificates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  attempt_id UUID NOT NULL REFERENCES public.exam_attempts(id) ON DELETE CASCADE,
  verification_code TEXT NOT NULL UNIQUE,
  name_on_cert TEXT NOT NULL,
  organization TEXT,
  mcq_score INTEGER NOT NULL,
  agent_score INTEGER NOT NULL,
  swarm_score INTEGER NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_certificates_user ON public.certificates(user_id, issued_at DESC);
CREATE INDEX idx_certificates_code ON public.certificates(verification_code);
ALTER TABLE public.certificates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own certificates"
  ON public.certificates FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own certificates"
  ON public.certificates FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Public can verify certificates by code"
  ON public.certificates FOR SELECT TO anon, authenticated
  USING (true);
