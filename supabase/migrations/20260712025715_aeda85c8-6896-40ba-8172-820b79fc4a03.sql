-- Drop the built-in "lovable_ai" free-tier gateway cap tracking. The
-- built-in gateway has been replaced by an operator-configured
-- OPENROUTER_API_KEY default provider with no per-user usage caps, so this
-- table and its RPCs are no longer read or written anywhere in the app.
DROP FUNCTION IF EXISTS public.increment_gateway_usage(UUID);
DROP FUNCTION IF EXISTS public.add_gateway_output_tokens(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.increment_gateway_image_usage(UUID);
DROP TABLE IF EXISTS public.gateway_usage_counters;
