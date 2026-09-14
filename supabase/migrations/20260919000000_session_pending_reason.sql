-- Why a sandbox is still starting, when the runtime knows.
--
-- On Kubernetes a pod that no node can take stays Pending, and Pending looks
-- exactly like "the image is still pulling" from the outside. The scorer's
-- readiness wait therefore ended in "The scorer did not become ready", which
-- sends an operator to look at the scorer — while Kubernetes had already
-- written the answer into a PodScheduled condition: 0/3 nodes are available,
-- insufficient memory.
--
-- NOT `error`, which the row already has. A pod waiting for room is not
-- failing: it becomes schedulable the moment the cluster autoscaler adds a
-- node, and recording it as an error would both mislead the reader and invite
-- the UI to paint a failure over something that is about to work. This is the
-- latest explanation for a session that is STILL STARTING, and it is cleared
-- the moment it starts.
ALTER TABLE public.notebook_runtime_sessions
  ADD COLUMN IF NOT EXISTS pending_reason text;

COMMENT ON COLUMN public.notebook_runtime_sessions.pending_reason IS
  'Why this session is still starting, in the runtime''s words — an unschedulable pod''s condition on Kubernetes. Cleared when it starts. Never an error: a pending pod is one the cluster has not placed yet.';
