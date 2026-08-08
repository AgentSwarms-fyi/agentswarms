# Knowledge bases: sources, scheduled sync & access control

> Part of the [AgentSwarms docs](../README.md#documentation).

A knowledge base is a named collection of documents that agents search by
meaning and quote with citations. Documents arrive four ways: file upload,
web-page ingestion, GitHub repository ingestion, and **connected services** —
Google Drive, Notion, SharePoint and Dropbox — which are synced on a schedule
and kept deduplicated. All four land in the same tables and the same
retrieval pipeline: pgvector embeddings, optional Postgres full-text search
fused alongside them, and a keyword scan that still covers any document not yet
embedded.

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

## Chunking modes and hybrid retrieval

Three settings change what is stored and what is searched. The first two are per
**document** (they describe how it was built); the third is per **knowledge
base** (it describes how the collection is queried).

### Chunking mode — per document

| Mode           | Embedded       | Sent to the model  | Extra storage                              | Index cost                   |
| -------------- | -------------- | ------------------ | ------------------------------------------ | ---------------------------- |
| `flat`         | the chunk      | the same chunk     | none                                       | embeddings only              |
| `parent_child` | small children | the child's parent | one `kb_chunk_parents` row per parent      | embeddings only              |
| `qa`           | a question     | question + answer  | none (the question lives on the chunk row) | **one LLM call per passage** |

`parent_child` exists because retrieval and generation want opposite chunk
sizes. Children are cut from their parent and never across it, so expanding a
match to its parent always returns a superset of the text that matched. Parents
do not overlap each other — overlapping parents would send the model the same
sentences twice whenever two neighbouring children both matched.

`qa` generates pairs with `OPENROUTER_API_KEY` (model `google/gemini-2.5-flash`)
and embeds the **question**, so a user's question is compared against a
question rather than against prose. Generation failures are reported per
document and never silently downgraded to flat chunks: a collection that
disagreed with its own settings would be undebuggable.

**Changing the mode does not rewrite existing chunks.** Re-chunking means paying
to embed the document again, so it is an explicit action — _Re-index with these
settings_ in the Chunking tab, which stamps the new settings onto each document
and rebuilds its rows. Documents added after the change use it already.

### Retrieval mode — per knowledge base

`knowledge_bases.retrieval_settings` holds `{"mode": "...", "semantic_weight":
0..1}`. `NULL` means semantic-only, which is what every collection did before
this existed — upgrading changes no answers until someone opts in.

| Mode       | Runs                                                      |
| ---------- | --------------------------------------------------------- |
| `semantic` | pgvector only                                             |
| `hybrid`   | pgvector **and** Postgres FTS over the same chunks, fused |
| `keyword`  | Postgres FTS only                                         |

Hybrid matters for tokens embeddings blur together: error codes, part numbers,
SKUs, surnames. Before this, keyword search only ever looked at documents with
**no** embeddings, so an exact term inside an embedded document could not rescue
a weak semantic match.

Scores are normalised within each list before weighting, because cosine
similarity (~0.3–0.9) and `ts_rank` (~0.0–0.3) are not comparable numbers. A
chunk found by both retrievers scores above one found by only one. When several
knowledge bases are searched at once the most keyword-leaning setting wins — a
collection configured for hybrid was configured that way for a reason.

Changing retrieval mode needs **no** re-embedding: it changes how the existing
index is queried, not how it was built.

### Schema and indexes

- `kb_chunk_parents` — parent passages; RLS mirrors `kb_chunks` policy for
  policy, including the IAM sharing policy. A reader who could see children but
  not parents would be silently degraded to child-only context rather than shown
  an error.
- `kb_chunks.parent_id`, `.chunk_kind` (`text` | `qa`), `.question`.
- `kb_chunks.fts` — a generated `tsvector` over `question || content`, with a
  GIN index. Generated so it cannot drift from the text it indexes. The question
  is included because a Q&A answer often does not contain the words someone
  would search for.
- RPCs `match_kb_chunks_v2` (parent-aware vector match) and `keyword_kb_chunks`
  (FTS). The original `match_kb_chunks` is left in place for compatibility.

Parent citations get a 4,000-character budget rather than the 560 used for
ordinary snippets — reusing the smaller cap would trim a parent down to about
14% of itself and quietly deliver flat chunking under a different name.

### Which provider embeds

`DEFAULT_EMBED_PROVIDER` is **OpenRouter**, resolved in this order:

1. the user's own OpenRouter integration,
2. the operator's `OPENROUTER_API_KEY` (no per-user setup — the same key that
   makes chat work out of the box),
3. the operator's `OPENAI_API_KEY`,
4. any other connected provider with an OpenAI-compatible `/embeddings` endpoint.

Step 2 is the one that was invisible: the settings dialog only ever offered a
provider the _user_ had connected, so an instance with `OPENROUTER_API_KEY` set
and no personal integration displayed OpenAI as the default while the server
was already embedding through OpenRouter.

OpenRouter embedding models offered, all confirmed against the live endpoint to
return 1536 dimensions (the pgvector column width):

| Model                           | Native | $/1K tokens |
| ------------------------------- | ------ | ----------- |
| `openai/text-embedding-3-small` | 1536   | 0.00002     |
| `openai/text-embedding-3-large` | 3072   | 0.00013     |
| `google/gemini-embedding-001`   | 3072   | 0.00015     |
| `qwen/qwen3-embedding-8b`       | 4096   | 0.00001     |
| `qwen/qwen3-embedding-4b`       | 2560   | 0.00002     |

**Verify before adding to that list.** OpenRouter does not expose embedding
models through its public `/models` catalogue, so a plausible id is not evidence
that one exists — two `nvidia/*` nemotron ids were offered here and both
returned `404 No endpoints found`. Prices were measured from OpenRouter's own
billed `usage.cost` (2026-08-08) because the community dataset that
`scripts/refreshPrices.ts` vendors does not cover them; a model with no price
makes budgets silently stop accumulating, which `tests/unit/pricingCoverage.test.ts`
enforces.

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
