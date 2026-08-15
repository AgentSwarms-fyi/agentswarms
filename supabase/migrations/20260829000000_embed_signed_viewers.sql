-- Signed viewers for embedded analytics: one embedded dashboard, scoped per
-- end customer.
--
-- THE GAP THIS CLOSES. An embed key is a capability token that lives in the
-- host page's HTML, so every visitor to that page holds the same one and sees
-- the same rows — the owner's. That is right for a public dashboard and wrong
-- for embedding analytics inside a product, where each customer must see only
-- their own data. Issuing one embed key per customer does not fix it: the keys
-- are equally public, so any customer can use any other customer's.
--
-- THE MECHANISM. The host's BACKEND mints a short-lived token naming the
-- viewer's attributes, HMAC-signed with a secret only the two servers hold,
-- and passes it into the iframe URL. /api/embed verifies the signature and
-- turns those attributes into row filters over the dashboard's stored results.
-- The browser can read the token; it cannot forge one.
--
--   viewer_secret          the shared HMAC secret, ENCRYPTED at rest with the
--                          same envelope as provider credentials. Owners hold
--                          RLS select on their own row, so the ciphertext is
--                          reachable from the client — the plaintext is
--                          returned exactly once, at generation, by a server
--                          function, and never stored in clear.
--   viewer_attributes      the attribute names each token MUST carry, each
--                          becoming a mandatory row filter on the widget
--                          column of the same name. Requiring them by name is
--                          what makes a host-side typo fail CLOSED: without
--                          this list, a token carrying `tenat` would produce
--                          no filter, and no filter renders as everything.
--   require_signed_viewer  when true, a request with no valid token is refused
--                          outright rather than served the owner's view.

ALTER TABLE public.embed_keys
  ADD COLUMN require_signed_viewer boolean NOT NULL DEFAULT false,
  ADD COLUMN viewer_attributes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN viewer_secret jsonb;

-- Two ways this setting could become a badge that vouches for nothing, both
-- refused at write time:
--
--   1. Requiring a signed viewer while naming nothing to scope by. A merely
--      valid token would then unlock the whole dashboard — authenticated
--      mistaken for authorized. The request path refuses that combination too
--      (viewerScopeFilters); this stops it ever being stored.
--   2. Setting it on an agent or swarm embed, where there are no result rows
--      to scope and nothing enforces it. A toggle that reads as "secured" and
--      does nothing is worse than no toggle.
ALTER TABLE public.embed_keys
  ADD CONSTRAINT embed_keys_signed_viewer_needs_attributes
  CHECK (
    NOT require_signed_viewer
    OR (
      resource_type = 'bi_dashboard'
      AND array_length(viewer_attributes, 1) IS NOT NULL
      AND viewer_secret IS NOT NULL
    )
  );

COMMENT ON COLUMN public.embed_keys.viewer_secret IS
  'Encrypted HMAC secret shared with the host backend that mints viewer tokens. Plaintext is shown once at generation and never stored.';
COMMENT ON COLUMN public.embed_keys.viewer_attributes IS
  'Attribute names every viewer token must carry; each becomes a mandatory row filter on the widget column of the same name.';
