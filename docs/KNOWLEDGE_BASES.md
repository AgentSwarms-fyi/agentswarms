# Knowledge bases: sources, scheduled sync & access control

> Part of the [AgentSwarms docs](../README.md#documentation).

A knowledge base is a named collection of documents that agents search by
meaning and quote with citations. Documents arrive four ways: file upload,
web-page ingestion, GitHub repository ingestion, and **connected services** —
Google Drive, Notion, SharePoint and Dropbox — which are synced on a schedule
and kept deduplicated. All four land in the same tables and the same
retrieval pipeline (pgvector embeddings with a keyword fallback for anything
not yet embedded).

The in-app page (`/docs/knowledge`) covers day-to-day usage; this document is
the operator's view — what the connectors need, what the sync engine
guarantees, and where the security boundaries sit.

## Connected services

| Provider     | Credentials                                                                                       | What syncs                                                                            | ACL mirroring                   |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| Google Drive | Access token, or refresh token + OAuth client id/secret for unattended syncs                      | A folder (subfolders to depth 5); Docs/Sheets/Slides exported as text/CSV; text files | Yes — per-file permissions      |
| Notion       | Internal-integration secret (share the pages with the integration)                                | Listed page ids and every page of listed databases                                    | No — API exposes none           |
| SharePoint   | Entra app registration: tenant id + client id + client secret (`Files.Read.All`, admin-consented) | A document library (or folder path); text-format files                                | Yes — per-item permissions      |
| Dropbox      | Access token, or refresh token + app key/secret                                                   | A folder path or the whole Dropbox; native content hashes                             | Yes — file members, best-effort |

Credentials are **token-based by design** (the platform's BYOK pattern). No
OAuth consent flow ships, because that requires operator-registered apps per
provider; the wizard states exactly which credential form supports unattended
scheduled syncs. Save-time validation runs against the real connector, so a
misconfigured source fails at save with instructions — not at 3am on its
first scheduled run.

Per-source caps: **500 items**, **400k characters per item**, folders to
depth 5. Every item the connector saw but did not ingest is recorded on the
source with a reason (unsupported type, cap, depth) — skipping is never
silent.

## Scheduled sync and the dedup contract

Schedules: `manual`, `hourly`, `daily`, `weekly`. Scheduled syncs run on the
same maintenance pass as BI refreshes and SaaS syncs (`/api/bi/cron` or the
in-process 60s scheduler), and claim each due source by atomically pushing
`next_sync_at` forward — of N app instances polling the same second, exactly
one syncs a given source.

Two levels make a schedule safe to run forever:

1. **Version skip.** Each document stamps the provider's change marker
   (modified time / revision / native hash). An unchanged marker skips the
   item **without downloading** — re-syncing a 400-file folder costs a
   listing.
2. **Content-hash skip.** Providers bump modified times on moves, permission
   edits and comment activity. Downloaded text is sha256-hashed; when it
   matches what is stored, the marker is refreshed and the document is **not
   re-chunked or re-embedded**. Embedding spend follows content change,
   nothing else.

Items deleted at the provider delete their documents here (chunks cascade).
A partial unique index on `(source_id, external_id)` makes duplicate
documents impossible even if both levels above were wrong. Each sync records
`+added ~updated =unchanged −removed` plus the skip list on the source row.

Failure policy: connectors **throw** with the provider's status and body
("Dropbox 401: invalid_access_token"), because an empty listing on a revoked
credential would otherwise read as "source is fine, zero documents" — and
delete every synced document as remotely removed. `embedding_failed` is a
distinct status: documents saved, semantic indexing incomplete, keyword
fallback active, owner notified.

## Access control

Two layers, deliberately separate:

- **Collection visibility** is IAM: owner-only row-level security plus
  read-only grants to users or groups ([IAM.md](./IAM.md)). Deny by default.
- **Per-source access scope** filters retrieval _inside_ a visible
  collection, for documents synced from a connected service:

  | Scope               | Effect                                                                                                             |
  | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | `inherit` (default) | Documents behave like uploads — collection visibility decides. All pre-existing documents work this way.           |
  | `private`           | Only the connecting user retrieves them, even inside a shared/granted collection.                                  |
  | `source_acl`        | Sharing mirrored per document from the provider: exact emails, `domain:example.com` entries, `*` for public links. |

Enforcement sits at the single retrieval choke point, covers the vector and
keyword paths alike, and runs **before** any reranking model sees candidate
text. The rules err toward deny:

- The source's owner always retrieves their own documents.
- A provider that exposes no ACL (Notion; some Dropbox plans) leaves
  documents owner-only, counted in the sync stats as `acl_unavailable`.
- Tenant-wide "anyone in the organisation" links match nobody but the owner —
  tenant membership cannot be verified from here.
- **Public embeds are anonymous**: they retrieve `inherit`-scope documents
  (and provider-public `*` ones) only, even though the embed executes under
  its owner's account for credential resolution.

## Security posture

- Connector credentials are encrypted at rest (AES-GCM via the same
  `crypto.server` module the SaaS connections use) and **never travel to the
  browser**: the management route returns explicit columns, the UI selects
  explicit columns, and editing a source with empty credential fields keeps
  what is stored.
- All connector traffic goes to fixed provider hosts over HTTPS with a 30s
  timeout; the only variable URLs are provider-returned download redirects.
- Deleting a source deletes its documents by default (their visibility may
  have depended on the source's scope). Keeping them is an explicit choice
  that converts them to plain collection documents.
- Embedding failures, sync failures and scheduled-sync errors surface as
  source status + owner notifications — the failure mode is loud, not an
  empty collection.
