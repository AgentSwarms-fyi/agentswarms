# Knowledge bases: sources, scheduled sync & access control

> Part of the [AgentSwarms docs](../README.md#documentation).

A knowledge base is a named collection of documents that agents search by
meaning and quote with citations. Documents arrive four ways: file upload,
web-page ingestion, GitHub repository ingestion, and **connected services** —
Google Drive, Notion, SharePoint, Dropbox, Confluence and a public **website** — which are synced on a schedule
and kept deduplicated. All four land in the same tables and the same
retrieval pipeline: pgvector embeddings, optional Postgres full-text search
fused alongside them, and a keyword scan that still covers any document not yet
embedded.

The in-app page (`/docs/knowledge`) covers day-to-day usage; this document is
the operator's view — what the connectors need, what the sync engine
guarantees, and where the security boundaries sit.

## Scanned documents and images

A PDF with a text layer is extracted in the browser and stored as text. A
PDF whose pages are pictures — fewer than forty characters of text layer per
page — and any image file (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) is
**read with a vision model**: the browser draws each page to a JPEG at
reading size, sends a few pages at a time to the server, and the server asks
the instance's vision model to transcribe each page as the uploading user,
through the same internal channel every other model call uses. So the model
rules in IAM apply (a model the role may not use refuses the upload with the
model named), the budget applies, each page leaves an execution trace under
the agent name **Document OCR**, and each batch leaves a `kb.document.ocr`
audit event with the page range, the model, the characters read and the
cost. The stored document carries a `[page N]` marker per page and records
`{ ocr: { pages, model, cost_usd } }` in its metadata.

Two instance settings govern it, under **Admin → Developer runtime →
Document intelligence** with env fallbacks: the **vision model**
(`DOCUMENT_VISION_MODEL`, default `openrouter/google/gemini-3-flash-preview`;
it must accept images) and **pages per document**
(`DOCUMENT_VISION_MAX_PAGES`, default 200). A document over the limit is
refused before its first page is read. A page the model reads as empty is
dropped; if every page is, the upload reports it rather than adding an empty
document. The transcription prompt forbids description, commentary and
translation, and asks for tables as rows with `|` between cells.

## Connected services

| Provider     | Credentials                                                                                       | What syncs                                                                                                                                      | ACL mirroring                   |
| ------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Google Drive | Access token, or refresh token + OAuth client id/secret for unattended syncs                      | A folder (subfolders to depth 5); Docs/Sheets/Slides exported as text/CSV; text files                                                           | Yes — per-file permissions      |
| Notion       | Internal-integration secret (share the pages with the integration)                                | Listed page ids and every page of listed databases                                                                                              | No — API exposes none           |
| SharePoint   | Entra app registration: tenant id + client id + client secret (`Files.Read.All`, admin-consented) | A document library (or folder path); text-format files                                                                                          | Yes — per-item permissions      |
| Dropbox      | Access token, or refresh token + app key/secret                                                   | A folder path or the whole Dropbox; native content hashes                                                                                       | Yes — file members, best-effort |
| Website      | None — a public site                                                                              | Pages from the sitemap (`lastmod` is the change marker), else same-site links followed from the start URL; robots.txt honoured; up to 500 pages | No — public content             |
| Confluence   | Cloud: email + API token. Data Center: personal access token. The host decides which.             | Every page in the listed spaces; `version.number` is the change marker; storage-format macros flattened to text                                 | No — not read                   |

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
- RPCs `match_kb_chunk_ids` (pgvector nearest neighbours: ids and similarities),
  `kb_chunks_by_ids` (the rows, parent-aware) and `keyword_kb_chunks` (FTS).
  Search and fetch are separate calls because the search may happen outside this
  database — see below. `match_kb_chunks_v2`, which did both, and the original
  `match_kb_chunks` are left in place for compatibility.

Parent citations get a 4,000-character budget rather than the 560 used for
ordinary snippets — reusing the smaller cap would trim a parent down to about
14% of itself and quietly deliver flat chunking under a different name.

### Where the vectors are searched

By default, in your Postgres: `kb_chunks.embedding` is a `vector(1536)` with an
HNSW cosine index, and the permission check is the row-level security already
protecting those rows. For most deployments that is the right answer — one thing
to run, one thing to back up, and a knowledge base that cannot half-exist
because two systems disagree.

Set `VECTOR_STORE=qdrant` and `QDRANT_URL` to search them in Qdrant instead.
The reason to is **capacity, not availability**: an HNSW index wants RAM, and by
default it wants it from the same instance serving your traces, audit, BI
results and every OLTP query. Past a few million chunks it is the largest thing
in there, and the only way to feed it is to resize the whole database. Qdrant is
a place to put the index that scales — and replicates — on its own.

It is **not** a way to survive losing Postgres. Every hit is hydrated from
`kb_chunks`, so a database outage takes retrieval with it wherever the vectors
live. The availability that is real runs the other way: losing **Qdrant**
degrades retrieval to keyword search rather than breaking it, because the text
never left Postgres.

**Qdrant holds vectors and two ids. That is all.** The chunk text, the document
it came from, the parent passage and who may read it stay in Postgres. Three
things follow, and they are the reason the split is drawn here:

- **Hybrid retrieval is unaffected.** The keyword half is Postgres full-text
  search over the same chunks, and it does not know or care where the vectors
  went.
- **The index is disposable.** A Qdrant that loses its volume costs a re-index,
  not a restore. There is no backup guidance for it because it is not a system
  of record.
- **An external store cannot leak a document.** A search returns ids, which are
  then fetched through the caller's own database client — so row-level security
  applies to the answer, not just to the question. A store that returned an id
  from somebody else's knowledge base gets nothing back.

| Setting              | Default                 | What it does                                   |
| -------------------- | ----------------------- | ---------------------------------------------- |
| `VECTOR_STORE`       | `pgvector`              | `pgvector` or `qdrant`                         |
| `QDRANT_URL`         | —                       | e.g. `http://qdrant:6333`                      |
| `QDRANT_API_KEY`     | —                       | Sent as `api-key`; omit if the server has none |
| `QDRANT_COLLECTION`  | `agentswarms_kb_chunks` | Created on first use, 1536-dim cosine          |
| `QDRANT_REPLICATION` | `1`                     | Copies per shard. **2+ for HA**, cluster only  |
| `QDRANT_SHARDS`      | `1`                     | Shards per collection                          |

**One Qdrant node is not high availability.** A single node is the right shape
for a laptop or a small install, and losing it degrades retrieval to keyword
search rather than breaking it — but surviving the loss of a node means a Qdrant
cluster with `QDRANT_REPLICATION` at 2 or more. Admin → Developer runtime → AI services
reports the replication the collection **actually** has, so the difference
between what was asked for and what was placed is visible.

Selecting `qdrant` without `QDRANT_URL` logs an error and uses pgvector. It does
not fail to start: the vectors are still in `kb_chunks` and retrieval still
works.

### Re-indexing an external store

Admin → Developer runtime → AI services → **Re-index** drops every vector in the store and
writes them back from `kb_chunks`. It is idempotent, and it is the answer to
every way an external index can drift: a restored-from-empty volume, a store
switched on after documents were already embedded, a delete that happened while
it was unreachable. The same page shows chunks-in-Postgres beside
vectors-in-the-store, which is how you notice you need it.

Re-indexing does **not** re-embed. It moves vectors that already exist; a
document with no embedding stays keyword-only until it is indexed.

### Which provider embeds

Embeddings come from a **connected model provider** — the same place the chat
models come from. There is no separate embeddings key, and in particular no
dependency on an OpenAI account: an install whose models come from Gemini,
Ollama or vLLM embeds through that provider too.

`DEFAULT_EMBED_PROVIDER` is **OpenRouter**, which is the suggested default
rather than a requirement. Resolution order:

1. the user's own OpenRouter integration,
2. the operator's `OPENROUTER_API_KEY` (no per-user setup — the same key that
   makes chat work out of the box),
3. any other connected provider with an OpenAI-compatible `/embeddings`
   endpoint.

Documents embedded before this change carry an `openai_builtin` stamp, which
named the operator's OpenAI key. That key is no longer read; the stamp now
resolves to a connected provider serving the **same vector space**
(`text-embedding-3-small`, via your OpenAI integration or OpenRouter), so
existing collections stay searchable without a re-index. If neither is
connected, those collections need a re-embed under a provider you do have —
answering them from a different vector space would return confident nonsense
rather than an error.

### The real constraint is at most 1536 dimensions

`kb_chunks.embedding` is `vector(1536)`, and ingest hard-validates the width, so
a provider is usable here only if it returns **1536 dimensions or fewer** —
natively, or by honouring the OpenAI `dimensions` parameter. A narrower vector
is zero-padded to the store's width; a wider one is refused, because it cannot
be truncated without changing what it means. That is a stronger condition than
"has an embeddings API", and it is measured rather than assumed: every model
below was probed against the live endpoint.

Native widths vary a lot, and the parameter is what makes them fit:

| Model                           | Native | With `dimensions: 1536` |
| ------------------------------- | ------ | ----------------------- |
| `openai/text-embedding-3-small` | 1536   | 1536                    |
| `openai/text-embedding-3-large` | 3072   | 1536                    |
| `google/gemini-embedding-001`   | 3072   | 1536                    |
| `qwen/qwen3-embedding-8b`       | 4096   | 1536                    |
| `qwen/qwen3-embedding-4b`       | 2560   | 1536                    |

A model that _ignores_ the parameter returns its native width. If that width
is over 1536 it fails at ingest — after the documents are saved, leaving the
collection answering from keyword search alone. Since that cannot be predicted from a model id, don't:
**RAG settings → Test embedding** calls the provider once and reports the width
it actually returned. Use it before committing a collection to a model,
especially for a self-hosted Ollama or vLLM where the served model is your
choice rather than ours.

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
- Token-based connector traffic goes to fixed provider hosts over HTTPS with a
  30s timeout; the only variable URLs there are provider-returned download
  redirects. Two connectors are different by design and take a host you supply:
  Confluence (your own site URL, Cloud or Data Center) and the website
  connector, which fetches your start URLs and same-site links on a 20s
  timeout.
- Deleting a source deletes its documents by default (their visibility may
  have depended on the source's scope). Keeping them is an explicit choice
  that converts them to plain collection documents.
- Embedding failures, sync failures and scheduled-sync errors surface as
  source status + owner notifications — the failure mode is loud, not an
  empty collection.

## Use cases

### Index your own documentation site

Support agents should answer from the public docs, and the docs change weekly.

1. Open **Knowledge**, create a knowledge base, and click **Add Source →
   Website**. Give one or more start URLs; optionally a sitemap URL, path
   prefixes to stay inside (for example `/docs`), and a page cap (100 by
   default, 500 at most). No credential is needed.
2. Run the sync. The crawler reads `robots.txt` and skips what it forbids,
   stays on the same site, prefers the sitemap when there is one and otherwise
   follows links breadth-first. Each page's version is the sitemap `lastmod`,
   else the ETag, else a content hash.
3. Put the source on a schedule. A later sync re-fetches only pages whose
   version changed and removes pages that disappeared — the dedup contract
   above applies to crawled pages exactly as to files.

A sync result such as _5 documents indexed, 12 skipped by robots.txt_ is
normal for a marketing site whose robots rules exclude most of it; narrow the
path prefixes to the documentation tree.

### A Confluence space, with the code blocks intact

Engineering keeps runbooks in Confluence; the on-call agent needs them.

1. **Add Source → Confluence.** Enter the site URL, the space keys to sync,
   and an API token — plus the account email for Confluence Cloud. Cloud and
   Data Center are told apart from the URL and authenticated accordingly.
2. Pages arrive as text converted from Confluence's storage format; code
   macros keep their bodies, which is what makes a runbook useful to an
   agent.
3. Restrict who can retrieve from it by sharing the knowledge base read-only
   with the on-call group — see [Access control](#access-control).

### Share it, and delete it safely

1. Share a knowledge base with a user or group from **Admin → IAM → Access**.
   Recipients' agents can search it; nobody but the owner can change it.
2. Deleting a knowledge base asks first — the dialog names what goes with it:
   every document, chunk and connected source, and the agents wired to it lose
   their knowledge. There is no undo, which is why there is a dialog.

### Embed on your own hardware

Air-gapped deployments can embed with Ollama or vLLM instead of a hosted
model. The only hard constraint is width: the store is 1536-dimensional, so a
model that emits narrower vectors is zero-padded (exact for cosine similarity)
and a wider one is refused with a clear error — see
[The real constraint is at most 1536 dimensions](#the-real-constraint-is-at-most-1536-dimensions).
