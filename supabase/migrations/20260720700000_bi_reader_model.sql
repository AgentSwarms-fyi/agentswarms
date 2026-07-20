-- Reader AI model for BI dashboards.
--
-- The publisher picks a text model that signed-in viewers of a shared
-- dashboard use for the generative features (Ask AI over the widget
-- snapshots). Stored as an OpenRouter model id; NULL means the server's
-- default BI model. Enforcement happens per-user at /api/bi via the IAM
-- model gate — this column is the publisher's designation, and group
-- shares are validated against it when granted.
ALTER TABLE public.bi_dashboards ADD COLUMN ai_model text;
