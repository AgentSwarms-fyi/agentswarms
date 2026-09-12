-- Where a binary classifier draws the line.
--
-- Until now it decided by argmax, which is a threshold of 0.5 that nobody
-- chose. That is the right default and the wrong one for most real decisions:
-- missing a fraudulent order and declining a good customer do not cost the
-- same, and the person who knows the ratio is the operator, not the trainer.
--
-- ON THE VERSION, NOT IN THE ARTIFACT, so moving the line does not mean
-- retraining. The trainer measures what every operating point would cost (the
-- sweep in the version's metrics) and the operator picks one; prediction reads
-- it at run time.

ALTER TABLE public.ml_model_versions
  ADD COLUMN IF NOT EXISTS decision_threshold double precision,
  ADD COLUMN IF NOT EXISTS positive_label text;

COMMENT ON COLUMN public.ml_model_versions.decision_threshold IS
  'Binary classification only: the probability at or above which positive_label is predicted. NULL means argmax, the previous behaviour. Changing it does not retrain — the artifact is untouched.';
COMMENT ON COLUMN public.ml_model_versions.positive_label IS
  'Which class the threshold is about. NULL uses the second class, which is what the trainer sweeps.';
