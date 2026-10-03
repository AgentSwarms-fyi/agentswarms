# Adversarial pass — running log

A module-by-module hunt for the failures that do not announce themselves: a
number that is wrong rather than missing, a badge that outlives what it vouched
for, a message that names a cause it cannot support, an empty state that claims
there is nothing when the truth is that nothing could be read.

Each pass drives the real UI against the real database and **checks what the
screen says against what the data says**. A page that renders without an error
has not been tested; it has been visited.

## Method

1. Load the page in the browser, capture console and network.
2. Enumerate every control: tab, filter, toggle, menu, dialog, empty state.
3. For every displayed figure, compute the same figure independently from the
   database and compare. A match is the evidence; a plausible-looking number is
   not.
4. Push each control to its edges: zero rows, one row, a range with no data,
   a deleted referent, a value that is null for a legitimate reason.
5. Log what is found, fix it with a regression test, mutation-verify the test.

### Mutation testing needs a green baseline

A mutation run reports a mutant as "caught" when the suite fails with it
applied. If the suite was ALREADY failing, every mutant is reported caught and
the whole run means nothing — it measures the standing failure, not the test.

This is not hypothetical: a run of fourteen mutants over the claim verifier
came back thirteen-for-thirteen with the control also caught, which is the only
visible symptom. The cause was a stale source assertion left red by a rename
two steps earlier. **The control failing is the tell** — a control that gets
caught means the baseline is red or the tests are anchored on a comment, and
either way the run is void.

Assert the baseline is green before mutating, and keep a control in every run.

### Source-anchored tests must pin the USE, not the definition

Three separate mutants have now survived a green suite by leaving a definition
in place and severing its use: an ontology token budget nothing sent, a schema
fetch an `if (false)` could disable, and a claim check whose result was
replaced with an empty list. A `toContain("someHelper(...)")` assertion passes
in all three cases. Assert the call site and the branch it feeds.

### Failing one read on purpose

Several findings depend on making exactly one read fail in the live page. The
recipe, after module 16 spent a whole pass on getting this wrong:

- Patch `window.fetch` with a wrapper that **records every URL it sees and
  every URL it failed**. The record is the evidence.
- Re-trigger the read with a **client-side remount** —
  `__TSR_ROUTER__.navigate` away and back — which re-runs mount effects while
  leaving `window` intact. **Never reload the page: a reload destroys the
  patch**, the read then succeeds, and the screen tells you nothing.
- Report every probe beside the same measurement with the injection disarmed,
  down the identical path. A probe whose control also fails has measured
  nothing.

**A failed-read finding requires positive proof the injection took effect** —
the wrapper naming the request it failed, or a probe of what the read returned.
Never infer it from what rendered.

## Severity

- **S1** — states something false, or lets a wrong number reach a decision.
- **S2** — hides something true (silent failure, swallowed error, misleading empty).
- **S3** — correct but confusing, or a control that does nothing.
- **S4** — cosmetic.

## Coverage map

| #   | Module              | Route                      | Pass | Date       | Findings                                                                          |
| --- | ------------------- | -------------------------- | ---- | ---------- | --------------------------------------------------------------------------------- |
| 1   | Dashboard           | `/dashboard`               | ✅ 1 | 2026-08-16 | 5 (2×S1, 1×S2, 2×S3)                                                              |
| 2   | Documentation       | `/docs`                    | ✅ 1 | 2026-08-16 | 4 (2×S1, 1×S2, 1×S1 self-inflicted)                                               |
| 3   | Agent Builder       | `/agents`                  | ✅ 1 | 2026-08-16 | 3 (2×S1, 1×S2)                                                                    |
| 4   | Knowledge Base      | `/knowledge`               | ✅ 1 | 2026-08-16 | 1 (1×S1)                                                                          |
| 5   | Agent Chat          | `/playground`              | ✅ 1 | 2026-08-16 | 2 (1×S1 self-inflicted, 1×S2); guardrails verified live                           |
| 6   | Agent Swarms        | `/swarms`                  | ✅ 1 | 2026-08-16 | 1 (1×S2)                                                                          |
| 7   | MCP Builder         | `/mcp-builder`             | ✅ 1 | 2026-08-16 | 1 (1×S2)                                                                          |
| 8   | AI Analyst          | `/ai-analyst`              | ✅ 1 | 2026-08-16 | 0 — held; no live turn (over budget cap)                                          |
| 9   | Data Catalog        | `/data-sql`                | ✅ 1 | 2026-08-16 | 2 (1×S1, 1×S3)                                                                    |
| 10  | Semantic Layer      | `/semantics`               | ✅ 1 | 2026-08-16 | 1 (1×S1) + one wrong hypothesis, recorded                                         |
| 11  | Metrics             | `/metrics`                 | ✅ 1 | 2026-08-16 | 2 (2×S2) + one hypothesis dropped                                                 |
| 12  | BI Workspace        | `/bi`                      | ✅ 1 | 2026-08-16 | 1 (1×S1) — widget count read the page-1 mirror                                    |
| 13  | Developer workspace | `/notebooks`               | ✅ 1 | 2026-08-17 | 4 (1×S1, 2×S2, 1×S3) — failed reads rendered as absence                           |
| 14  | Prompt Library      | `/prompts`                 | ✅ 1 | 2026-08-17 | 2 (1×S1, 1×S3) — empty claim on a failed read; `#tag`                             |
| 15  | Skill Library       | `/skills`                  | ✅ 1 | 2026-08-17 | 1 (1×S1) — same failed-read claim; guard added                                    |
| 16  | Integrations        | `/integrations`            | ✅ 2 | 2026-08-17 | 1 (1×S2) — re-audited with proof; the retracted S1 was real, at S2                |
| 17  | Web Embedding       | `/embeds`                  | ✅ 1 | 2026-08-17 | 0 — counts exact; disable, expiry and allow-list proven                           |
| 18  | Secrets             | `/secrets`                 | ✅ 1 | 2026-08-17 | 2 (1×S1, 1×S2) — empty claim on a failed read; skeleton for ever                  |
| 19  | MCP Servers         | `/mcp`                     | ✅ 1 | 2026-08-17 | 1 (1×S1) — derived counts read 0 on a failed read; pin was decorative             |
| 20  | Model Registry      | `/model-registry`          | ✅ 1 | 2026-08-18 | 1 (1×S1) — four false claims, and a sync button that acts on them                 |
| 21  | Analytics           | `/analytics`               | ✅ 1 | 2026-08-18 | 3 (1×S1, 2×S2) — a silent row cap made every KPI wrong                            |
| 22  | Swarm Traces        | `/analytics/observability` | ✅ 1 | 2026-08-18 | 2 (1×S1, 1×S2) — empty claim, and onboarding shown to an onboarded account        |
| 23  | Traces & Logs       | `/traces`                  | ✅ 1 | 2026-08-18 | 1 (1×S1) — the capped page presented as the population; error paths already sound |
| 24  | Audit Log           | `/audit`                   | ✅ 1 | 2026-08-18 | 2 (2×S1) — exculpatory empty claim; non-uniform silent truncation                 |
| 25  | Budgets             | `/budgets`                 | ✅ 1 | 2026-08-18 | 3 (1×S2, 2×S1) — skeleton-forever, false empty, caps shown unset                  |
| 26  | Monitoring          | `/monitoring`              | ✅ 1 | 2026-08-18 | 2 (1×S3, +R36) — health claimed over an empty probe set; then over a STALE one    |
| 27  | Prompt Compare      | `/prompt-compare`          | ✅ 1 | 2026-08-18 | 1 (1×S1) — the model that failed fastest was crowned fastest                      |
| 28  | Evaluations         | `/evaluations`             | ✅ 1 | 2026-08-18 | 2 (2×S1) — "0% pass" on an unscored run; false empty on a failed read             |
| 29  | Image Playground    | `/image-playground`        | ✅ 1 | 2026-08-18 | 1 (1×S1) — false "none connected", memoised for the whole session                 |
| 30  | IAM                 | `/admin/iam`               | ✅ 1 | 2026-08-18 | 1 (1×S3) — unrecoverable failed load; every read already checked                  |
| 31  | Developer runtime   | `/admin/runtime`           | ✅ 1 | 2026-08-18 | 1 (1×S2) — toast-only error, then a permanently blank page                        |

## Findings

<!-- newest first -->

### 2026-10-03 — R235: a grantee kept the access and lost the restrictions

**Severity: high.** Enforcing a share takes two reads — the viewer's group memberships, and the
grants on the resource. Four surfaces did those two reads privately, and the enforcement file says
what that habit costs, in a comment written after an earlier incident: *"Four private copies of one
access rule is what let the snapshot path fail open for months."* R53 guarded the two copies in
`iam.server`. Two of the others were still open.

**BI direct query** (`routes/api/bi.direct-query.ts`) dropped both errors. An empty grant list is
not a refusal there: `mergeGrantRowFilters([])` returns `null` and `intersectColumnMasks([])`
returns `[]`, so the viewer's **live warehouse query** ran with no row filter and no column mask —
every row and every column the owner can see. The access check above it is an RPC whose failure
reads as `null`, so access itself fails closed; the viewer was legitimately through the door, and
only the limits that make that access safe disappeared.

**The semantic layer** (`utils/semantic/policy.server.ts`) had already guarded its grants read, with
a comment saying exactly why. The membership read beside it was not guarded, and it carries just as
much: a restriction granted to a GROUP yields no applicable grant when the membership list cannot
be read, and this function's own contract reads "no applicable grant" as "no share-level
restriction exists".

The other two copies were checked rather than assumed. `bi.functions` guards its grants read and
answers "This dashboard is not shared with you" when the list is empty, and `sharedDatasets` returns
an empty dataset: both fail CLOSED, so neither exposes anything. They are on the queue for their
message — a failed read answered as "not shared with you" is the milder half of this class — not
for a hole.

**Fixed** by giving the two reads one guarded home, `readApplicableGrants` in `utils/iam.server.ts`,
beside `resolveGrantedResourceIds`, which has done it correctly since R53. Either read failing
throws; BI direct query answers **503** and does not run the query; the semantic layer lets the
throw reach the caller, which already treats it as "refuse". Access and restriction now fail closed
together or not at all.

Seven mutants, seven caught, control survived. One is worth recording: a mutant that set the grants
to `[]` in the catch and left an unreachable `return json(503)` further down **survived** the first
version of the test, which asserted that a 503 appeared somewhere nearby. The assertion now pins the
catch block itself — that the refusal is its first act, and that nothing downgrades the grants on
the way past. A test that looks for a string in a neighbourhood is not testing control flow.

**Not proved in the UI, and why.** The grantee side needs a second account, which is the same
blocker recorded for R225; the owner side cannot show it, because the whole block is inside
`if (!isOwner)`. What did run: `semanticTrust`'s differential test, which compiles a grantee's query
against the real engine and asserts it returns different numbers from the owner's, still passes, as
do the other 105 tests over these paths.

### 2026-10-03 — Smoke of the real image after R232, R233 and R234

No new defect in what was driven. Image `d39419dc1c93`, built from `c6592999` and started as a real
container: a paused bar race survived a dashboard Refresh that demonstrably re-ran the query (the
widget's stamp went "1h ago" → "just now"); a guarded agent refused its blocked pattern with 422
and, once deleted, the identical request was refused with `agent_not_found` instead of being
answered; an Iceberg publish landed 4 records in 1 file, confirmed against the catalog's own
metadata rather than the toast; and an ETL run through the sandbox gateway loaded its 108 rows in
41 s. The app's log carried one error line, which is the guardrail refusal itself. No staging was
left in the bucket. Full table in `docs/UI_TEST_RESULTS.md`.

Worth recording for the next image check: `_lakehouse_con` is absent from the shipped `dist`
entirely, which is R232 visible in the artefact rather than in a test.

### 2026-10-03 — R234: a chat turn ran without the guardrails its agent was carrying

**Severity: high.** `/api/chat` loads the agent row for the trace label, the built-in tool
toggles, the per-tool allow-lists (MCP servers, SQL tables, ML models, n8n workflows) **and the
guardrails**. It read that row with `const { data: a } = await …`, dropping the error, under a
comment saying the trace label is non-critical.

That comment was true once. It stopped being true when the allow-lists and the guardrails moved
onto the same read, and the handling never followed — the classic shape this sweep is looking for:
not a wrong calculation, a sentence that outlived its data. A read that failed left every default
standing, and both defaults are the permissive end:

- `enabledToolsFromToggles({})` returns `undefined`, which its own doc comment says callers treat
  as "the registry's default set" — so an agent restricted to two tools got the lot.
- `parseGuardrails(undefined)` returns `DEFAULT_GUARDRAILS`, where input filtering, output
  filtering, PII, profanity, content safety, citation checking and the hallucination heuristic are
  **all off** and every pattern list is empty.

The turn then ran and looked entirely normal. Nothing in the UI, the trace or the logs said the
agent had been reduced to an unguarded assistant.

**Proved in the UI.** A real agent, `R234 guardrail probe`, with input filtering on and the
pattern `r234-forbidden-token` blocked. Sending that phrase returned **422, "Input was blocked by
a prompt-injection guardrail."** The agent was then deleted in a second tab and the identical
message sent again from the chat page that still held its id: **200, and the model answered.** The
delete dialog's own words are "Sites embedding this agent and API calls that reference it will
stop working" — they did not stop; they carried on without the guardrails the agent was deleted
with. Both runs are in `docs/UI_TEST_RESULTS.md`.

**Fixed** by making the configuration something a turn either has or refuses on. The decision is
`agentConfigRefusal` in `src/utils/agents/agentConfigGate.ts`, deliberately outside a 2,000-line
route handler, because that is where this kind of thing goes back to sleep. A failed read, a
client that could not be built and a read that threw all answer **503 `agent_unreadable`**; a row
that is simply not there answers **404 `agent_not_found`**, which is a different sentence and
makes the delete dialog's promise true. After the fix the same deleted-agent request returns
`{"error":"agent_not_found", …}` on the wire, and a live agent's guardrail still fires.

Two things worth keeping in mind for the next one of these. `failedRead` normalises a thrown cause
with `||` and not `??`: a client that throws `""` or `0` would otherwise produce a read whose
error is falsy, which is this very defect in miniature, and a mutant proved the test caught it.
And the same file's sibling, `embed.chat.ts`, had three reads of the same shape — the embed's own
agent, its swarm, and a node's linked agent. The first two already refused, but with the sentence
"The embedded agent no longer exists", which a failed read cannot support and which an owner would
act on by rebuilding something that was never gone; those now answer 503 with a message that says
what actually happened. The third failed open exactly like the chat route, silently dropping the
knowledge base the embed is meant to cite along with the guardrails its publisher set.

Eleven mutants, eleven caught, control survived.

### 2026-10-03 — R233: a bar race restarted, and un-paused itself, on any dashboard re-render

**Severity: moderate.** `BarRace` (`src/components/bi/BiChartParts.tsx`) built its frames in a
`useMemo` over the `rows` prop and reset its playback in an effect keyed on that frames array:

```ts
useEffect(() => {
  setIdx(0);
  setPlaying(true);
}, [frames]);
```

A dashboard hands its widgets a new `rows` array on every render — changing a filter, a poll, a
refresh after a write, a session refresh near expiry. Each one produced a new array, so the memo
rebuilt, so the effect fired: the race jumped back to its first frame for no reason the viewer
could see, and a race they had **paused** started playing again. The pause is the whole point of
the control; a chart that overrides it is worse than one without it.

The advance timer had the same key, which is a second symptom with a different shape: its deps
were `[playing, idx, frames, frameMs]`, so each re-render cleared the pending timeout and started
a new one. A dashboard re-rendering faster than `frameMs` (1100 ms by default) left the race
frozen on its first frame while the button said it was playing.

The fix states what the position actually means. `idx` is an index into the frame list, so it
stays valid exactly as long as that list does — not as long as the array object does. Playback
moved to `useRacePlayback` (`src/lib/racePlayback.ts`), keyed on the frames' own labels, and the
timer keyed on the frame count. The same series arriving again changes nothing; a re-aggregation
that rewrites the numbers under the same periods holds its place; a genuinely different series
starts from the beginning, playing.

Proved in the UI both ways, because "it stayed put" is only evidence if the same steps moved it
before: the pre-fix bundle was built and deployed to the container first, and a race paused on 2014
was **playing again, at 2017** after a plain dashboard Refresh. With the fix, the same Refresh took
the widget's stamp from "5m ago" to "just now" — the rows did re-arrive — and left the race paused
on the same frame. Table in `docs/UI_TEST_RESULTS.md`.

This is the fourth of this family after R215, R218 and R219, and the first where the state reset
was not a form: `tests/unit/useRacePlayback.test.ts` runs the hook under the same minimal React
stand-in, extended with `useState`, `useMemo` and effect cleanups so a timer can be driven. Five
mutants caught, control survived.

### 2026-10-03 — R232: `lakehouseAttachFn` deleted

Not a defect in behaviour, so no severity: the removal of a function that builds a DuckLake attach
out of engine credentials. It was how a sandbox used to reach the lakehouse, and after R227 moved
ETL to the gateway, R230 the Spark lakehouse target and R231 ML, nothing in `src` called it. Found
by checking which of R231's code a real image carried — `_lakehouse_con` was absent from
`/app/dist` entirely, because the bundler had already dropped it.

The two tests that still named it called it themselves, which is why the suite never noticed: a
test that invokes dead code keeps it alive and proves nothing about the product. One had no
subject any more and went with it; the other now pins the **absence** across every generated
program (ETL, Spark, ML, Spark query), so reaching for an attach again fails there rather than
putting a credential back in a sandbox. The DuckDB extension bake stays, because a notebook may
use `duckdb` with `httpfs` or `postgres` and that is the user's own code.

### 2026-10-03 — Smoke of the real image after R231

No new defect in what was driven. Image `036a0cb5b128`, built from `c7b1405e` and started as a
real container: a training job reported "read 836 row(s), sampled to 250" and produced v9 on 200
rows, its artifact landing through the presigned PUT; a batch prediction with that version wrote
242 rows, all of the one region asked for and all scored; an Iceberg publish landed 4 records the
catalog's own metadata confirms; and an ETL run through the gateway still loads its 108. No errors
or warnings, and no staging left in the bucket. Full table in `docs/UI_TEST_RESULTS.md`.

**Found by the image, not by the tests: `lakehouseAttachFn` is dead code.** Checking which of the
round's code the container carried showed `_lakehouse_con` absent from `/app/dist` entirely — the
bundler had dropped it, because after R230 moved the Spark lakehouse target to the gateway and
R231 moved ML, nothing in `src` calls it any more. Only two tests still reference it. It is a
function that builds a DuckLake attach from engine credentials, which is exactly the kind of thing
that gets picked up again by someone adding a feature, so it is on the queue to delete rather than
left lying around.

### 2026-10-03 — ML training, prediction and scoring, with no lakehouse credential

Tests: `tests/unit/mlLakeManifest.test.ts` (10: the SELECT a run reads, sampling against refusing,
a worker's slice, an assemble step's artifacts, a prediction's read/write/model) and the gateway's
bounded reads and artifact rules in `tests/unit/sandboxLake.test.ts` (28 in all, real DuckDB). The
mutation run caught 14 of 14, and the control survived.

#### R231 · S1 · ML sandboxes held the lakehouse's catalog and storage credentials

**Found** as the last of the owner's scoped-credentials decision. ETL lost its credentials in
R227 and the Spark cluster in R230, but a training job, a prediction and a warm scorer still
received `ETL_LAKEHOUSE_CATALOG` and the object store's key and secret: they read their source
over an engine connection, wrote their scored rows the same way, and moved model artifacts with
an fsspec client built from those keys. A model's own code is generated, but anything else in the
image ran with the same environment.

**The fix.** The app does all of it (`src/utils/ml/lakeManifest.ts` over sandboxLake.server):
- the source SELECT is built server-side, which puts a prep step's own SQL through the SQL
  editor's checks for the first time;
- the app counts, samples (repeatable reservoir, so a re-run reads the same rows) and refuses —
  a forecast's series over the limit is refused rather than sampled, and so is a prediction batch
  — all over the rows the OWNER may see;
- a data-parallel worker's hashed share is part of the SELECT the app declares for it;
- scored rows are staged and loaded like any other target;
- artifacts travel through a new `lake_artifact` call: one URL, one declared key, one method,
  asked for when it is needed because a training job can outlive a URL minted at its start.

`_lakehouse_con` and `_s3fs` are gone from the ML program entirely.

**Driven after** (hot deploy), on `revenue_facts plan classifier`:
- **Train new version** with the row limit set to 100: v8 trained, random_forest, F1 100%, and
  its own note reads **"Trained on a 100-row sample of 836 rows."** — the app counted 836, sampled
  100, and said so;
- the v8 artifact is in the lake bucket, ~55 KB, written through the presigned PUT;
- **Batch prediction** with v8, `analytics.revenue_facts where region = 'APAC'` →
  `analytics.r231_pred`: succeeded, 242 rows in 13 s;
- the table: 242 rows, 1 distinct region, that region `APAC`, and all 242 scored — so the WHERE
  was applied by the app and every row got a prediction;
- the **Audit Log** shows the app doing the work, attributed to the owner:
  `ml.train.start` → `lakehouse.sandbox_read analytics.revenue_facts 100 rows` →
  `ml.train.succeeded`, then `ml.predict_query` →
  `lakehouse.sandbox_read analytics.revenue_facts 242 rows` →
  `lakehouse.sandbox_commit analytics.r231_pred`;
- no errors or warnings in the app log, and the bucket held no staging prefix afterwards.

**A test that got stronger rather than re-anchored.** `mlReasonCodes` checks that every
underscore-prefixed call in the ML program has a definition — it was written after a patch script
added calls whose definitions never reached the file. It carried an allow-list of names that come
from the prelude, which would have grown with this change. It now takes the definitions from the
prelude's own source as well, and asserts that all three ML bundles prepend it: a bundle that
forgot `lakeGatewayFn()` fails there instead of with a NameError inside somebody's batch.

### 2026-10-03 — Smoke of the real image after R225 to R230

No new defect. Image `4c02cc12cc32` was built from `be1407c7` with `docker compose build
agentswarms` and started with `docker compose up -d agentswarms`, and the six rounds since the
last image build were driven on it: R225's node guard refuses an unshared schema by name, R226's
table-function refusal holds for a write, R227's sandbox reports no lake-related variables at
all, R230's Spark sandbox reports a scoped session credential and no catalog, the loaded table
matches its source exactly, and an Iceberg publish lands 4 records the catalog's own metadata
confirms. The app logged no errors or warnings throughout. Full table in
`docs/UI_TEST_RESULTS.md`.

Two things this confirmed that earlier rounds had left open:
- the **session sweep** really does take a dead session's staging. R230 noted leftovers and
  reasoned they were the sweep's business; the bucket now holds one prefix with one `_SUCCESS`
  marker, the older ones having been swept, including the failed run's parts.
- the **runtime image** did not need rebuilding, checked rather than assumed: nothing under
  `docker/notebook-runtime` has changed since the last image build, and the generated program is
  served by the app, so an app-only build is the whole change.

### 2026-10-03 — The Spark cluster's credentials, scoped to one run

Tests: `tests/unit/stsScopedCredentials.test.ts` (7: the policy's prefixes, actions and bounded
listing, the plan's file prefixes, the required-vs-fallback switch), plus the gateway's
cluster-written loads and the Spark codegen's session-token handling in
`tests/unit/sandboxLake.test.ts` and `tests/unit/sparkCredentialScope.test.ts`. The mutation runs
caught 14 of 14 and 1 of 1, and the controls survived.

#### R230 · S1 · The Spark cluster held the lakehouse's own credentials

**Found** as the second half of the owner's decision. A sandbox has held no lakehouse credential
since R227, but the Spark cluster still had the lake's permanent keys and, for an ETL lakehouse
target, the catalog's connection string as well: its executors write object storage themselves,
so there is no app in the middle the way there is for a sandbox.

**The fix.** The cluster gets a credential the STORE limits, minted per run through STS
AssumeRole with a session policy (`src/utils/lakehouse/sts.server.ts`):
- an ETL lakehouse target may write, read back and delete under that run's own staging prefix and
  nothing else; the app loads the batch the sandbox names and deletes what it loaded;
- a Spark lakehouse query may read the directories of the files its governed plan resolved;
- listing is bounded to the same prefixes, and nothing is granted on the bucket itself.

Neither path carries the catalog any more. The ETL target's load moved to the gateway, which also
removed the staging cleanup the sandbox used to do with the lake's keys, and with it the s3fs and
DuckDB the Spark half needed for the lake: a lakehouse-only pipeline now asks for the same
packages on either engine.

A store without STS keeps the engine's credentials and says so once per process;
`LAKEHOUSE_STS_REQUIRED=true` makes it a refusal. The policy is enforced by the store, which was
checked against this deployment's MinIO before any of this was written (R227's note: a session
scoped to one prefix read inside it, 200, and was refused outside it, 403).

**Driven after** (hot deploy), `r227_gateway` on the **Spark engine**, `analytics.bi_demo_sales`
→ `analytics.r227_out`:
- Succeeded, 41 s, 108 rows → 1 target;
- the Custom Python probe inside the sandbox listed its lake-related variables as
  `ETL_LAKEHOUSE_S3_ENDPOINT, _KEY_ID, _SECRET, _SESSION_TOKEN, _URL_STYLE, _USE_SSL, STAGE_URL`
  — **no `ETL_LAKEHOUSE_CATALOG`**, and a session token, so the credential was a scoped one;
  its undeclared read, stage and commit were refused by name as before;
- `r227_out` against the source: 108 rows, 0 extra, 0 missing;
- that check itself ran **on the Spark cluster** (the result carried the spark badge), so the
  query path's scoped read credential is in the same proof;
- in the bucket, the run's staged Parquet was gone after the load; Spark's own `_SUCCESS` marker
  stays until the session sweep takes the prefix, and the earlier FAILED run's parts stay too,
  which is what a failed commit should leave.

**Found driving it, twice.**
- **Every Spark lakehouse run refused to start, silently.** Minting needs the session whose prefix
  it scopes to, and `resolveRunEnv` is also called with no session: once to fail a start fast, and
  again on every log read to collect the values the output must not carry. The unguarded mint made
  the first throw — "Run now" did nothing — and would have made the second issue a credential per
  log read, one the sandbox never held, so it would have scrubbed nothing. Both are now guarded on
  the session, and a test pins it.
- **"A load is 1 to 256 staged parts."** The route rebuilt each load field by field and left
  `prefix` out, so a cluster-written load — which names its batch rather than its files — fell
  into the numbered-parts path and asked for zero of them. The unit tests called the gateway
  directly and never saw the route. Pinned now.

**Also fixed.** A staged file that could not be deleted after its load was swallowed by a bare
`catch`, so a bucket could grow by every run with nothing to read about why. It warns now, which
is how the two surviving `_SUCCESS` markers above were confirmed to be the sweep's business
rather than a failure.

### 2026-10-02 — Storage credentials on the shared Spark cluster

Tests: `tests/unit/sparkCredentialScope.test.ts` (5 tests: every S3A option set in a compiled
Spark pipeline and a compiled Spark lakehouse query builds its own client; a SQL step's scope,
allowed and refused, and refused at compile). The mutation run caught 6 of 6, and the control
survived.

#### R229 · S1 · The shared Spark cluster served a call with whichever storage credentials it saw first

**Found** designing scoped credentials for Spark. Generated Spark code passes storage credentials
per read and per write as Hadoop options, so that no key sits in the cluster's shared
configuration. Hadoop caches one S3A client per bucket per JVM, keyed without the credentials,
and the cached client keeps the ones that built it.

**Proof (live cluster, `spark-connect` 4.2.0)**, a Spark Connect client reading the lake's
`analytics/r227_out` files:
1. with the lake's keys: read, 540 rows;
2. then with keys that do not exist: **read, 540 rows**;
3. wrong keys with `fs.s3a.impl.disable.cache=true` on the call: refused, AccessDenied;
4. the lake's keys with the same flag: read, 540 rows.

So any later call on the cluster to a bucket some earlier call had opened was served with the
earlier call's keys: a user's storage connection with the lake's, or with another user's.

**The fix.** Every S3A option set the generated code passes (`_lake_s3_options` and `_s3_options`
in Spark pipelines, `_s3` in Spark lakehouse queries) sets `fs.s3a.impl.disable.cache`, so each
call is served with its own keys. A SQL step on Spark, which runs on the same cluster, is one
SELECT over its input `t`: a file read in place of a table and any statement are refused at save
and at compile (`sparkSqlScopeRefusal`). Restart Spark Connect once after upgrading so no client
cached before the fix survives.

**Driven after** (hot deploy, Spark Connect restarted): a lakehouse query on the Spark cluster
from the Lakehouse page answered 108 rows, 3 regions; right after it, the same wrong keys against
the same bucket were **refused**. `r227_gateway` on the Spark engine succeeded with 108 rows. Its
probe step reported the `ETL_LAKEHOUSE_*` variables present on that engine, as the status table
in `docs/SANDBOX_LAKEHOUSE_ACCESS.md` says, and the gateway refusals held.

### 2026-10-02 — An ETL sandbox with no lakehouse credential

Tests: `tests/unit/sandboxLake.test.ts` (15 tests, real DuckDB: a governed read staged as Parquet
and read back, a grantee's read through the owner's policy, the preview cap, stage URLs, append,
merge and replace commits with cursors, all-or-nothing rollback, a keyless merge refused, the
staging sweep, the session channel's pins), `tests/unit/etlLakeManifest.test.ts` (4 tests), and
the ETL compiler tests updated to the new program. The mutation run caught 13 of 13, and the
control survived.

#### R227 · S1 · An ETL sandbox held the engine's catalog and storage credentials

**Found** as the owner's decision after R225: every check the server makes before a run bounds
what the generated code asks for, but the sandbox received `ETL_LAKEHOUSE_CATALOG` and the
object store's key and secret, and code in the sandbox (a Custom Python node, any library) runs
with the same environment. With them it could read every table's metadata and files.

**The fix.** The app does the lakehouse work (`src/utils/lakehouse/sandboxLake.server.ts`, design
in `docs/SANDBOX_LAKEHOUSE_ACCESS.md`). The sandbox asks over its session channel for a declared
read (run as the owner through `governSelect`, the SQL editor's checks and policies, staged as
Parquet behind a presigned GET), a stage (presigned PUTs under its own prefix) and a commit (the
app loads the staged rows, and the run's cursors, in one transaction). What a run may ask for is
pinned on its session when it fetches its environment (`src/utils/etl/lakeManifest.ts`), and every
call is served from the pin. Reads of a shared table under a policy now work through the policy;
R225's refusal of them is lifted, and writing one stays refused.

Before writing a design, the object store was probed: this deployment's MinIO issues short-lived
credentials limited to one prefix (HEAD inside the prefix 200, outside 403, the engine key 200 on
both). The catalog cannot be scoped the same way, which is why the sandbox gets no catalog access
at all rather than a narrower one.

**Driven** (hot deploy), on a new pipeline `r227_gateway`, `analytics.bi_demo_sales` → Lakehouse
table `analytics.r227_out`:
- **Code** shows `_lake_call`, `_lake_read('…')` and `_lake_stage(…)`, and no catalog string;
- node **Preview data**: 50 of 108 sampled rows, with the column types as before;
- **Run now**, Replace: Succeeded, 108 rows; `r227_out` has 108 rows and an EXCEPT both ways
  against the source is 0 and 0;
- Append: 216 rows over 108 keys; Merge on `month, region`: 108 rows over 108 keys, 0 missing;
- a Custom Python node between them printed, from inside the sandbox, **"lake-related env names:
  none"**, and its calls for an undeclared read, an undeclared stage and an undeclared target's
  commit were each refused by name; the run still loaded its 108 rows;
- the lake bucket held no `_sandbox_staging/` prefix after the runs.

A second pipeline `r227_stream`, Streamed rows (push) → `analytics.r227_stream` (append),
continuous, exactly-once:
- batch 1 (3 rows) and batch 2 (2 rows) loaded over 13 ticks, then the run was cancelled;
- batch 3 (1 row) was pushed and the pipeline started again: its log read **"exactly-once:
  resumed 1 cursor(s) committed with the last load"**, and it loaded 1 row;
- `r227_stream`: 6 rows, 6 distinct ids 1–6, notes `batch-1,batch-2,batch-3`.

**Not driven:** the grantee side of a policed read, which needs a second account; the tests hold
it with real DuckDB (a reader's staged rows are filtered and masked).

**Found driving it: a commit every poll.** Cancelling a continuous run does not stop the
pipeline, so the schedule sweep restarted `r227_stream` and it ran 69 quiet ticks. Each tick
called the commit with nothing in it, and the Audit Log filled with blank
`lakehouse.sandbox_commit` events, one every five seconds. A tick now commits only when it loaded
rows or moved a position, and the app answers an empty commit without opening the engine or
writing an event. After the fix, a continuous run of 14 ticks with one pushed row wrote exactly one
`lakehouse.sandbox_commit → analytics.r227_stream`. The reads and commits also show in the Audit
Log as `lakehouse.sandbox_read` (with the row count) and `lakehouse.sandbox_commit` (with the
tables), attributed to the pipeline's owner.

Docker Desktop stopped during the round (the engine's VM went down under the gate and a running
sandbox); it was restarted with `docker desktop restart`, and the run queued across the restart
failed with "The run never acquired a sandbox session" until the stale continuous run was
cancelled. Neither was the gateway.

#### R228 · S1 · A merge whose rows had lost their key column emptied the target table

**Found** writing the gateway's commit test. A lakehouse merge deleted the incoming keys and then
inserted: `DELETE FROM t WHERE (id) IN (SELECT id FROM _src)`. When the frame no longer had the key
column (a Select columns or Rename step upstream), `id` inside the subquery bound to the target's
own column, the subquery became correlated, and the DELETE matched every row. The table was
emptied and the keyless rows inserted, and the run reported success.

**Proof.** Real DuckDB in the test: the statement as the sandbox ran it, against a source with no
`id` column, leaves 0 of 2 rows.

**The fix.** The gateway's merge qualifies the incoming keys (`_in."id"`), so a missing key fails
to bind, and checks the staged rows' columns first: "Target "…": the rows to merge have no "id"
column, which its primary key needs — nothing was loaded". The Spark engine's lakehouse target
still runs the bare statement until it moves to the gateway.

### 2026-10-02 — A table function inside a write statement

Tests: `tests/unit/lakehouseWriteTableFunctions.test.ts` (4 tests: the table-function list read
from a real DuckDB in memory with the engine's own query, every write shape scanned with the real
`calledNames`, and the runner's order). The mutation run caught 5 of 5, and the control survived.

#### R226 · S0 · The SQL editor ran a table function when it sat inside a write

**Found** while designing the sandbox gateway, whose commits run through the engine: the write
branch of `runLakehouseStatement` imports `writeSubSelect` and never calls it. A SELECT's table
functions are found in DuckDB's own parse (`json_serialize_sql`) and refused. DuckDB will not
serialize a write, so a write's reads were checked by `tableRefs`, a text scan that sees only
`schema.table` names. A table function in a CREATE TABLE … AS, an INSERT … SELECT, or any
subquery of a write ran with the engine's own access: its files on disk and the lake's storage
credential, past every grant and policy.

**Proof (before, hot deploy of R225).** In the SQL editor, owner's account, own schema:
- `SELECT * FROM read_text('/etc/hostname')` → **"read_text() is not available here — query
  lakehouse tables, or use a lake view for raw files"**;
- `CREATE TABLE analytics.r226_probe AS SELECT filename, content FROM read_text('/etc/hostname')`
  → **1 row(s), Count 1**;
- `SELECT filename, content FROM analytics.r226_probe` → `/etc/hostname`, `24798c87e4c5`: the app
  container's own host name.

The probe table was dropped. Nothing else was read.

**The fix.** `assertNoTableFunctions` runs last in the write branch, before anything executes and
after the refusals that need no engine (the first gate caught it ahead of the Iceberg mount's own
refusal, which a test pins). `calledNames` lists every
name the statement calls (bare, double-quoted or dotted, outside comments and string literals),
and each is compared with every table function the engine lists in `duckdb_functions()`, so a
function an extension adds is covered the day it loads. It fails closed: a failed read of the list
is not cached and is not "none", and a table that shares a table function's name is refused too.
Materialized views and SQL models were not affected: both run their SELECT through the AST check
before building.

**Driven after** (hot deploy of R226): the same CREATE TABLE … AS read answered **"read_text() is
not available here — query lakehouse tables, or use a lake view for raw files"**, the SELECT's
message. Ordinary writes still run: `CREATE TABLE analytics.r226_after AS SELECT upper('ok') AS
note, 1 AS n` and `INSERT INTO analytics.r226_after SELECT 'gen', range FROM range(2, 5)` left 4
rows (`OK,gen,gen,gen`). The table was dropped.

### 2026-10-02 — An ETL pipeline's lakehouse nodes, checked by their schema field only

Tests: `tests/unit/etlLakehouseGuard.test.ts` (7 tests, real DuckDB in memory parsing the
queries with the SQL editor's table walk, the owners' policies stubbed). The mutation run caught
4 of 4, and the control survived.

#### R225 · S1 · A pipeline's lakehouse source read any schema, and shared tables past their policy

**Found** by the lakehouse policy survey, re-run after R224's report was cut off. A pipeline's
lakehouse nodes run in a sandbox, and before a run or a node preview the server checked one
thing: that each node's own `schema` field named a schema the pipeline's owner could reach. So:
- a source in **query mode** ran its SQL as written. A node naming the owner's own schema could
  query a schema nobody had shared with them;
- a **shared table** with a row filter or column masks set by its owner was read whole. The
  policy is applied by the lakehouse engine's query rewrite, which the sandbox does not run;
- a **target** could write a shared table that the lakehouse keeps read-only for everyone but its
  owner once a policy covers it.

**Proof.** The grantee side needs a second account. The tests hold it with real DuckDB parsing
each query: `SELECT * FROM private.salaries` from a node whose schema is `mine` is refused with
`No access to schema "private"`; `read_parquet('s3://…')` is refused; a table-mode source, a
query and a target over a shared table with a policy are each refused; the owner's own read and a
shared table with no policy pass.

**The fix.** `lakehouseNodesRefusal` (`src/utils/lakehouse/pipelineGuard.server.ts`) runs before
the sandbox is given the catalog's credentials:
- every schema a source query reads goes through `assertSchemasAllowed`, as the SQL editor's do;
- the tables each node reads or writes are collected, and a table in a schema another user owns
  that carries that owner's policy is refused, with a message saying where the policy does hold;
- the run and the node preview both throw the refusal before `ETL_LAKEHOUSE_CATALOG` is set.

**Still open.** The sandbox holds engine-level catalog and storage credentials, so code that a
node does not declare (custom Python) is bounded by those credentials, not by these checks. The
owner chose scoped per-run credentials as the fix; that is the next piece of work.

### 2026-10-02 — A reader's SUMMARIZE, and the policy that was never loaded

Tests: `tests/unit/lakehouseSummarizePolicy.test.ts` (6 tests, real DuckDB in memory: the table
walk, the policy rewrite run over a SUMMARIZE, and what comes back). The mutation run caught 3 of
3, and the control survived.

#### R224 · S1 · A reader's SUMMARIZE ran past the owner's row filter and column masks

**Found** by a survey of every path that reads a lakehouse table for someone who does not own
it (after R223). Before a reader's statement runs, the lakehouse names the tables it reads and
loads their owners' policies. `selectReferencedTables` named none for any statement whose first
word was DESCRIBE, SUMMARIZE or SHOW. For DESCRIBE and SHOW that is right: they return a shape,
not rows. SUMMARIZE returns min, max, approximate distinct count, average, quartiles and a count
for every column, so for a reader:
- no policy was loaded;
- the statement ran as written, over the rows the filter hides;
- a masked text column's min and max were two real values.

DuckDB parses SUMMARIZE as a SELECT whose `SHOW_REF` holds the table, so the walk the function
uses finds it; only the first-word shortcut skipped it.

**Proof.** The grantee side needs a second account, which these rounds do not create. Real DuckDB
holds it (`analytics`-shaped table, a filter `region = 'EMEA'` and a mask on `email`):
- `SUMMARIZE sales.orders` as written gives email min `ana@example.com`, max `cy@example.com`,
  count 3;
- through the rewrite, which the fix now reaches, it gives min and max NULL and count 1.

The UI shows the root cause from the owner's side. On the R223 deploy, Lakehouse → **Spark
cluster** → `SUMMARIZE analytics.r211_double` answered **"This statement reads no lakehouse table
(schema.table), so there is nothing for Spark to do"**. That is the same function telling Spark
the statement reads nothing that told the policy layer so. On the lakehouse engine, the owner's
SUMMARIZE showed the `note` column's min and max as real text, what a masked column would have
shown a reader.

**The fix.**
- SUMMARIZE names its tables like any SELECT; only DESCRIBE and SHOW skip the walk.
- A statement that a policy covers, but whose rewrite replaced nothing, is refused instead of run
  as written.
- Spark refuses DESCRIBE, SUMMARIZE and SHOW by name ("SUMMARIZE is the lakehouse engine's; Spark
  SQL has no such statement — run it here"), where SUMMARIZE used to fall into "reads no table".

**Driven after** (hot deploy of R224): the owner's SUMMARIZE on the lakehouse engine returned
its 2 rows as before. On Spark it read "SUMMARIZE is the lakehouse engine's; Spark SQL has no
such statement — run it here." The engine picker was set back to Lakehouse engine.

**The survey's report was cut off.** Its first named finding, "ETL pipelines, including run and
node preview", came without detail, and the agent then stopped on an API error. The queue
records that the survey is to run again.

### 2026-10-02 — A shared table's policy, left behind on the way out

Tests: `tests/unit/lakehousePolicyFailClosed.test.ts` (10 tests: the real policy loaders against a
client whose reads fail one table at a time, and the real publish guard).
`tests/unit/lakehouseAccessCheck.test.ts` now finds Iceberg's schema check in the guard. The
mutation run caught 4 of 4, and the control survived.

#### R223 · S1 · Iceberg publish copied a shared table past its owner's policy; a failed policy read ran queries unfiltered

**Found** by a triage of the 298 single-row reads, and the list reads, that keep `data` and drop
`error` (sweep 7, after R222). Two holes in one guard:

- **Iceberg publish.** A schema shared with a reader is read by them through the owner's row
  filter and column masks: the editor rewrites their SELECT, a write that reads a policed foreign
  table is refused, and Spark refuses one. `icebergPublish` checked only that the reader could see
  the schema (`accessibleSchemas`), then copied the raw table with `INSERT ... SELECT` into a
  catalog the reader owns. Every row, every column unmasked, readable from then on by anything
  that speaks Iceberg.
- **The policy reads.** `loadPolicies`, `loadTagPolicies` and `lakehouseAssetTags` (five reads)
  kept `data` and dropped `error`, and `data ?? []` made a failed read "no policy". Every caller
  then ran unpoliced: the editor's rewrite, the refusal of a write that copies a policed table, an
  UPDATE or DELETE by a grantee, Spark, and the Delta Sharing snapshot handed to an external
  recipient.

**Proof.** This deployment has one account, and these rounds do not create accounts, so the
grantee side cannot be driven in the UI. The tests hold the defect half, against the real
functions:
- with the policy table's read refused, the old loader returned an empty map, where it now throws;
- a reader of a shared schema whose table has a policy got no refusal, where now the guard refuses
  them, and the handler asks it before anything is copied.

The UI holds the regression half: the owner still publishes their own table whole.

**The fix.**
- **`rowsOf`** (`policies.server.ts`) throws on a failed read, so a policy that cannot be read is
  an error and every caller fails closed.
- **`icebergPublishRefusal`** (`src/utils/lakehouse/publishGuard.server.ts`): the owner publishes
  whole; a reader is refused a table under a policy ("…has a security policy set by its owner,
  which an Iceberg copy cannot carry — only the owner can publish it."), and so is a reader whose
  policy cannot be read.

**Driven after** (hot deploy of R223): Lakehouse → `analytics.r211_double` → Publish to Iceberg →
`local_rest`, namespace `r181`, table `r223_owner_publish` → "Published 4 row(s) to
r181.r223_owner_publish". The first attempt failed in the catalog with SQLITE_BUSY, the dev
catalog's known lock (memory: restart `aswarm-iceberg-rest`); it went through after the restart.

**Also from the triage, queued:** agent chat taking a failed agent read for "every tool, no
guardrails"; BI direct query and the semantic layer's share policy losing grant filters on a
failed group read; SCIM and Admin → IAM skipping the superadmin protection; budget caps; and
others. The queue's sweep 7 lists them.

### 2026-10-02 — One failed poll, and a running Spark query is called cancelled

Tests: `tests/unit/sparkQueryPoll.test.ts` (10 tests: the server's read against a failing
client, and the editor's wait driven with scripted replies). The mutation run caught 5 of 5, and
the control survived.

#### R222 · S2 · A failed read stopped the editor watching a Spark query that went on to finish

**Found** picking up sweep 3's leftovers ("a cause named that the evidence cannot support"). The
Lakehouse editor runs a Spark query by polling its row every two seconds. It took a `null` reply
for "The query is gone — it may have been cancelled elsewhere." But:
- a cancelled query keeps its row, with status `cancelled`, which the loop already handles;
- nothing deletes these rows;
- `loadOwned` dropped the read's `error`, so a failed read answered `null` too.

So the message's cause was never true. Its only real trigger, a failed read in a run of minutes,
stopped the editor watching a query that was still running. Cancel used the same read, and
answered "not cancelled" for a query it never looked at.

In the UI (hot deploy of R221): Lakehouse → engine **Spark cluster** →
`SELECT n, count(*) AS c FROM analytics.r211_double GROUP BY n ORDER BY n`, Run. One poll's id
was rewritten in flight to a random UUID, so the server's own lookup found nothing: the same
`null` a failed read produced. After the 4th poll the editor stopped polling and showed **"The
query is gone — it may have been cancelled elsewhere."** History then listed the query as
**3 rows · 20253 ms**: it had finished.

(A first, unforged run had taken 342 s, most of it a cold sandbox and schema inference. It also
finished.)

**The fix.**
- **Server:** `loadOwned` throws on a failed read. The editor's poll and Cancel see an error, not
  an absent query. The sandbox's source route answers it with 503, not an absent query's 404.
- **Editor:** the wait is `pollSparkQuery` (`src/lib/sparkPoll.ts`). A failed poll is retried.
  After five in a row it stops and says the query "may still be running; History shows it when it
  ends". A truly absent query reads "The server has no record of this query.", with no cause.

**Driven after** (hot deploy of R222):
- **Polls 3 and 4 failed** (rejected in flight as "Failed to fetch"): the editor kept polling and
  showed **3 row(s)**, with n 1 → 2, 2 → 1, 3 → 1.
- **Poll 3 forged to a missing id:** "The server has no record of this query."

### 2026-10-02 — AI docs, and the owner and tags being typed are gone

Tests: `tests/unit/catalogAssetSheetEdits.test.ts` (2 tests). The mutation run caught 1 of 1, and
the control survived.

#### R221 · S2 · AI docs in the catalog asset drawer cleared unsaved owner, status and tags

**Found** by the same survey as R220. The asset drawer fills its form (owner, status, tags,
column tags, description) in an effect keyed on the `asset` prop. **AI docs** writes the
description and columns, then calls `onSaved` with them, and the catalog gives `selected` a new
object for the patch. So the effect ran again and put the saved values over everything typed but
not saved. A Save and a restore replace the object the same way.

In the UI (hot deploy of R220): Data Catalog → re-crawl the Lakehouse catalog source →
`analytics.r211_double` (R211's fixture). Owner `r221 owner` and tag `r221-tag` were typed and
not saved, then AI docs pressed. "Documentation generated" — and owner and tags read **empty**.
Only the generated description was in the form.

**The fix.** The form is filled when a different asset opens: the effect is keyed on `asset?.id`.
AI docs still sets the description itself, and the patch still updates the list.

**Driven after** (hot deploy of R221): the same steps kept **`r221 owner`** and **`r221-tag`**
through "Documentation generated". **Save** → "Saved"; after a page reload, the list shows the
tag and the drawer the owner, tag and description.

**Cost.** Two AI docs calls on the dialog's default model (Server default).

### 2026-10-02 — A session refresh, and the knowledge base embeds with the default model again

Tests: `tests/unit/userObjectKeySweep.test.ts` (4 tests: the knowledge page's fix, and a ratchet
over hooks keyed on the user object). `tests/unit/tokenReloadSweep.test.ts` (R125's negative
sample now has a body, so it can fail). `tests/unit/kbEmbedProbe.test.ts` found the provider
picker by the flag this round renamed; it is anchored on the provider itself now (a mutant that
drops the probe reset is caught). The mutation runs caught 5 of 5 and 1 of 1, and the controls
survived.

#### R220 · S2 · A session refresh replaced the embedding model the user had picked

**Found** by a survey of every effect that copies a prop or a load into state the user edits
(sweep 6, after R219). `useAuth()` hands out a new `user` object on every auth event, a refresh
included, and thirteen hooks were keyed on it. One of them, on **Knowledge Bases**, reloads
the connected providers into a new `Set`. That runs the embedding default again, and the default
stands back only once a *provider* has been picked, not a model.

In the UI (image `6a12aae557e9`): R192 add-source → RAG Settings → Embedding, provider OpenRouter
untouched, and the model changed to `openai/text-embedding-3-large`. After a forced session
refresh the model read **`openai/text-embedding-3-small`**.

The model is page state that every upload, re-index and new knowledge base uses. So about an hour
into a session, documents would be embedded with a model the user had replaced. Their vectors sit
in the same 1536-wide space as the others, so nothing fails; retrieval just compares unlike
vectors.

**The fix.**
- The providers reload when the user's **id** changes (`[userId]`), not their object.
- Picking a model also marks the choice as the user's (`embedChoiceTouched`, renamed from
  `embedProviderTouched`), so the default never replaces it.

**The guard.** `tests/unit/userObjectKeySweep.test.ts` is R125's ratchet for the user object.
The twelve other hooks keyed on it were read; each re-reads a list, a profile or a status (the
budget page saves each field as it is typed). Building it showed that R125's own negative
sample, `useCallback(() => x, [tokenRef, signedIn])`, had no `}` before its list, so the pattern
could never match it and the test could not fail. It and the new file's samples now have bodies.
The mutation run loosens both name matchers to prove those samples now bite.

**Driven after** (hot deploy of R220): the same pick held through a forced refresh, and **Add
Document** reads "embedded with OpenAI text-embedding-3-large (→1536d) — via OpenRouter".
Nothing was uploaded.

### 2026-10-02 — A session refresh, a deck's choices and a connector's edit undone

Tests: `tests/unit/useResetOnOpen.test.ts` (6 tests; its list of dialogs filled on open gains
both). The mutation runs caught 1 of 1 each, and their controls survived.

#### R218 · S3 · Export to PowerPoint re-ticked a widget the user had unticked

**Found** in R217's survey. The deck dialog ticks every exportable visual in an effect keyed on
`[open, exportable]`. `exportable` is a memo over the `pages` prop, and the dashboard passes
`pages={pages.map(…)}`, a new array on every render. In the UI, on the Salesforce dashboard (image
`51931edc73b7`):
- untick **Win Rate**, click into Instructions and type, and wait 40 s: it stays unticked. Clicks
  and typing in the dialog do not re-render the dashboard.
- force a session refresh: **Win Rate is ticked again**. The Instructions text, which that
  effect does not set, survives.

A refresh comes about hourly, and when a tab regains focus near expiry. A deck exported after
one includes visuals the user had taken out.

#### R219 · S2 · Editing a knowledge-base connector: a session refresh undid the edit

**Found** in the same survey. The connector wizard fills its form in an effect keyed on
`[open, editing]`, and the knowledge page passes `editing={{ id, kind, label, … }}` inline. No
connector existed, so one was made for the round: a **Website** connector `r219 web` on
`https://example.com`, at most 1 page, saved without syncing ("Source connected"). Then **Edit
connection**, the label changed to `r219 web edited`, and a forced session refresh: the label
read **`r219 web`** again. The same refill sets the settings, schedule and access scope back,
and empties the credential fields, so a token being pasted into a Notion or Drive connector
would vanish.

**The fix.** Both dialogs fill their form through R215's `useResetOnOpen`, once, when they
open, from that render's props.

**Driven after** (hot deploy of R218 and R219):
- **Deck:** untick Win Rate, refresh: **still unticked**. Reopening starts from every visual
  again, as designed.
- **Connector:** `r219 web edited`, refresh: **held**. Save → "Source updated", and the Sources
  list reads `r219 web edited`.

**Sweep 6's list is done.** Every `}, [open, …]);` effect was read with its call site. Six take
props that hold still (state, a memo, a Map entry) or load a list once. R217, R218 and R219
fixed the three that refilled a form from something that changes while the dialog is open.

### 2026-10-02 — A session refresh, and the groups being shared untick themselves

Tests: `tests/unit/tokenReloadSweep.test.ts` (32 tests: two dialogs join R125's fixed list, its
matcher now knows `accessToken`, and one more hook is reviewed). The mutation run caught 4 of 4,
and the control survived.

#### R217 · S2 · A session refresh put the saved share groups back over the ones being ticked

**Found** opening sweep 6, "a form that resets under the user". R125 swept every hook keyed on
the session token, which changes on each refresh (about hourly, and when a tab regains focus
near expiry). Its matcher took `token` and `access_token`. Listing every dependency with a token
in its name found three spelled `accessToken`, which it never saw:
- the BI dashboard's **Publish & share** load;
- the AI Analyst's **Share this analyst** load;
- the model registry picker's (it loads once, so it is only reviewed).

Both share dialogs reload the groups and the saved shares when the token changes, and put the
saved set over the ticks, which are kept until **Save**. In the UI, the session refresh was
forced as in R120: `expires_at` five seconds out, then `visibilitychange`.
- **Salesforce dashboard → Publish & share:** tick `sheets-share-test`, unsaved, then the refresh.
  The box was **unticked** again, and "Save group access" would have written the old set.
- **AI Analyst → Lakehouse analyst → Share this analyst:** the same, **unticked**.

So a group being given access is quietly left out; and one being removed keeps access, because its
tick comes back.

**The fix.** Both loads read the token through `useTokenRef` and are keyed on `signedIn`, as R125
did for twenty-two others. `tests/unit/tokenReloadSweep.test.ts` matches `accessToken` too, so
its ratchet now counts that spelling.

**Driven after** (hot deploy of R217):
- **Analyst:** tick, refresh: **still ticked**; closed without saving.
- **Dashboard:** tick, refresh, still ticked; **Save group access** → "Group access updated";
  reopened → ticked.
- **Restore:** then unticked, saved ("Group access updated"), reopened → unticked. The dashboard's
  sharing is as it was.

**Also driven, not yet fixed:** the dashboard's **Export to PowerPoint** dialog re-ticked an
unticked widget ("Win Rate") after the same refresh, because it takes `pages={pages.map(…)}`. It
is the queue's next item.

### 2026-10-02 — A double Enter to the analyst, two analyses, two threads

Tests: `tests/unit/singleFlight.test.ts` (the guarded list gains the analyst's ask). The mutation
run caught 2 of 2, and the control survived.

#### R216 · S2 · A double Enter ran the AI Analyst twice and saved two threads

**Found** last in sweep 5's queue. The analyst's input, Ask and starter chips are disabled while
`busy`. `askQuestion` set `busy` only after `await resolveScope()`, and checked a `busy` read from
the render that called it. For a warehouse analyst, `resolveScope` fetches the warehouse schema
the first time on a page, which is long enough for a second Enter to submit the form again.

In the UI: Lakehouse analyst (gpt-4o-mini, the built-in Lakehouse connection), fresh page, New
analysis, `r216 before: how many rows are in analytics.fct_region_revenue?`, Enter twice. The page
sent:
- **two** `/api/warehouse/schema` calls;
- **two** `/api/warehouse/query` calls;
- **two** inserts into `ai_analyst_threads`.

The thread picker then listed the question **twice**: two analyses paid for, two threads saved.
(The picker also holds an older thread, "Which 10 orders in analytics.revenue_facts…", three
times; it predates this round and was not traced.)

**The fix.** `askQuestion` is wrapped in R211's `useSingleFlight`. The flag is set at the call,
before the schema fetch, and Enter, Ask and the starter chips all reach it.

**Driven after** (hot deploy of R216): the same steps for `r216 after: …` sent **one** schema
call, **one** query and **one** thread insert, and the picker lists `r216 after` once.

**Sweep 5 is closed.** Every keyboard path its survey listed now shares its button's guard:
R211 to R216 put sixteen handlers on `tests/unit/singleFlight.test.ts`'s list.

### 2026-10-01 — A click in a dialog, and the form fills itself again

Tests: `tests/unit/useResetOnOpen.test.ts` (4 tests: the hook under a minimal stand-in for
React's effect dependencies, and the dialog's use of it). The singleFlight list gains the
dialog's Enter path. The mutation run caught 5 of 5, and the control survived.

#### R215 · S2 · Add metric to dashboard refilled its form on every click inside it

**Found** while driving R214. On **Semantic Layer → SaaS Sales model → Query**, run a query and
press **Add to dashboard**. On the real image `0ed734402123`:
- Type `r214 metric` as the title, then click the dialog's description text. The title read
  **"SaaS Sales model"** again, and the BI project list was fetched again: one refetch per click.
- Click the BI project select to choose **＋ New BI project…**. The form refilled under the
  click, and the select's elements were replaced as the browser tool reached them ("ref is
  stale"). The project snapped back to the first in the list.

So a custom title, a chart type or a new project could not be set reliably, and the Enter path
R214 guards elsewhere could not even be reached here.

**Why.** The dialog filled its form in an effect keyed on `[open, userId, payload]`. The
Semantic Layer builds `payload={…}` inline, so every render of the page handed the dialog a new
object, and the effect ran again. A click inside the dialog re-rendered the page; what in the
page re-renders on such a click was not traced, because the dialog has to hold its form whatever
its parent does.

**The fix.**
- **`useResetOnOpen(open, reset)`** (`src/hooks/use-reset-on-open.ts`) runs `reset` when `open`
  turns true and at no other time. It reads the `reset` of that render, so the form is filled
  from the props the dialog opened with.
- The dialog fills its form through it.
- Its `submit` is wrapped in `useSingleFlight`, which closes R214's Enter gap for this dialog.

**Driven after** (hot deploy of R215):
- Typed `r215 metric`, then clicked the description twice: the title held, and the dashboards
  were fetched **once** since opening.
- A wrong project pick ("Reconciled titles") held too. Then End + Enter picked ＋ New BI
  project…, which held.
- `r215 metric after` and Enter twice: **one** toast, and one project `r215 metric after` with
  1 widget, titled **r215 metric** (`d385a565…`).

**The class.** Many dialogs fill their form in an effect keyed on `open` and on props. The
queue's sweep 6 lists the ones whose extra dependency could be an inline object.

### 2026-10-01 — A double Enter in a name field, two of everything

Tests: `tests/unit/singleFlight.test.ts` (22 tests; the guarded list gains nine handlers, and one
test pins the MCP builder's `finally`). The mutation run caught 11 of 11, and the control
survived.

#### R214 · S2 · Nine create dialogs made two of what they name for a double Enter

**Found** fourth in sweep 5's queue. Each dialog's create button is disabled while it saves.
Enter in the name field called the same handler with no check, and the name clears only after
the save. Driven on the real image `0ed734402123` (R213), name `r214 before` and Enter twice:

| Surface | What came back |
| --- | --- |
| Sheets → New workbook | **Two** workbooks (`c5a31d30…`, `89258bfb…`) |
| BI → New BI project | **Two** "Empty dashboard" cards |
| BI → New folder (no guard on Add either) | **Two** folder rows |
| BI → Manage workspaces | **Two** workspaces, "Workspace created" twice |
| BI → Reports → New report | **Two** reports |
| MCP Builder → New server | **Two** servers (`02a6d942…`, `9890ce5c…`) |
| Workbench → BI agent answer → Add to dashboard → New BI project | **Two** projects `r214 widget before`, "Added to …" twice |
| ETL → New pipeline (`r214_before_toast`) | One pipeline, and the toast **duplicate key value violates unique constraint "etl_pipelines_user_id_name_key"** |
| Evaluations → New dataset (`r214 before toast`) | One dataset, and the toast **duplicate key value violates unique constraint "eval_datasets_user_id_name_key"** |

The MCP builder's create also set `creating`, awaited, and cleared it after, with no `try`: a call
that threw left the button disabled until a reload.

**The fix.** Every one of the nine handlers is wrapped in R211's `useSingleFlight`, so the
button and the key share one guard. The MCP builder's create clears `creating` in a `finally`
and toasts a thrown error.

**Driven after** (hot deploy of R214), name `r214 after` and Enter twice:
- **One** workbook, BI project, folder, workspace ("Workspace created" once), report and MCP
  server.
- **One** `r214 widget after` project ("Added to …" once).
- ETL and Evaluations: one each, and **no** toast.

**Moved out.** The Semantic Layer's Add metric to dashboard has the same Enter path, but its
form resets on every click inside the dialog (the queue's next item), so its "before" could not
be driven. Its guard ships with that fix.

**Cost.** The BI agent answers came from Gemini Flash models on the configured Google provider:
two answers, after the free OpenRouter models were rate-limited and Gemini 3.1 Flash Lite
returned 503.

### 2026-10-01 — A double Shift+Enter, a cell run twice

Tests: `tests/unit/singleFlight.test.ts` (12 tests: `sharedFlight`, and the guarded list gains the
Workbench and the notebook) and `tests/unit/cellRunKey.test.ts` (4 tests, driving CodeMirror's
own keymap dispatch). The mutation run caught 11 of 11, and the control survived.

#### R213 · S2 · A notebook cell ran twice for a double Shift+Enter, and a Workbench query twice for a double Ctrl+Enter

**Found** third in sweep 5's queue. Reading the notebook's run path found three faults where the
queue listed one.

- **A cell ran twice.** The cell's run button is `disabled` while it runs, and Shift+Enter called
  the same `runCell` with no check. In the fixture notebook `r213 double run`, cell 6 holds
  `n = globals().get("n", 0) + 1; print(n)`. With the kernel ready after one run (output 1), a
  double Shift+Enter printed **2 and then 3**, 59 ms apart: two executions on the kernel.
- **A run during the kernel start failed.** `ensureKernel` stored the runtime before `start()`
  had connected, so a second call took it and ran on it, and it answered **"Server runtime not
  connected"** at once. A double Shift+Enter on a fresh page showed that error in the cell while
  the first run was still starting the kernel. When a start failed, the cell showed "The server
  runtime is unavailable." rather than the start's reason, because `runCell` read
  `runtimeError` from the render before the start.
- **Every Shift+Enter added a blank line.** CodeMirror's standard keymap binds Shift-Enter to
  "insert a newline", and it handles the key in the editor before the event reaches the wrapper
  `div` that ran the cell. After the rounds above, the cell had grown from 2 lines to 7, and
  autosave had kept them.

The Workbench had the first fault: Run Query is `disabled={running}`, and Ctrl+Enter called
`handleRun()` with no check. Its queries are read-only, so a double press costs a second query, a
second Recent queries row and a second audit row. A quick query (`SELECT 213`, about 30 ms) is
over before the second key, so it proves nothing either way. With
`SELECT sum(i % 7) … FROM range(200000000)` (about 2.5 s) on the R212 build, a double Ctrl+Enter
left **two** Recent queries rows, 4099 ms and 6641 ms: the second waited behind the first in the
browser's one DuckDB worker.

**The fix.**
- **`sharedFlight` / `useSharedFlight`** (`src/lib/singleFlight.ts`): one run per key. A call for
  a key already in flight joins that run and gets its result. Cells are keyed by id, so one
  cell's run never holds up another's, and Run all reaching a cell already running waits for it.
- **`runCell` and `ensureKernel`** are both shared flights. `ensureKernel` returns the start's
  reason on failure, and `runCell` shows that reason.
- **`cellRunKey`** (`src/lib/cellRunKey.ts`) binds Shift-Enter in the editor's own keymap at
  `Prec.highest`, so the run is the binding that handles the key, and no line is inserted.
- **The Workbench's `handleRun`** is wrapped in R211's `useSingleFlight`.

**Driven after** (hot deploy of R213):
- **Notebook, fresh page:** a double Shift+Enter gave no error, and one run printed **1**.
- **Notebook, kernel ready:** a double Shift+Enter printed **2** (one run). A later single
  Shift+Enter printed **3**, so the guard releases. The source stayed at 2 lines throughout.
- **Workbench:** the slow query with a double Ctrl+Enter left **one** row, on two separate
  deploys of the fix: 2474 ms, then 3829 ms.

The R212 build was restored from a stash only to take that Workbench "before", then R213 was
rebuilt and deployed again.

### 2026-10-01 — A double Enter, two live SCIM tokens, one secret shown

Tests: `tests/unit/singleFlight.test.ts` (6 tests; the list of guarded keyboard paths gains the
mint). The mutation run caught 2 of 2, and the control survived.

#### R212 · S2 · A double Enter in the SCIM token label minted two live tokens

**Found** second in sweep 5's queue. On **IAM → SSO → Provisioning (SCIM)** the Mint token button
is `disabled={busy}`, and Enter in the label field called the same `mint()` with no check. The label
is cleared only after the server answers, so both calls sent it. In the UI, with the label
`r212 before` and Enter twice:
- the table listed **two** live tokens labelled `r212 before`, both "never" used, 0 requests;
- the "copy it now" banner showed **one** secret, the second.

The first token is a live provisioning credential whose secret no one ever saw. Both rows look the
same, so an admin who revokes "the extra one" has even odds of revoking the token the identity
provider holds, and provisioning stops.

**The fix.** `mint` is wrapped in R211's `useSingleFlight`, so the button and the key share one
guard, and a second Enter while the first mint is in flight does nothing. A later mint, for
rotation under the same label, still works; the guard releases when the call settles.

**Driven after** (hot deploy of R212): the label `r212 after` and Enter twice listed **one** token
`r212 after`, one banner, and the label field cleared. All three fixture tokens were then revoked
from the same tab (no one holds their secrets); the rows are kept, and the card reads
"3 revoked tokens".

### 2026-10-01 — One INSERT, Ctrl+Enter twice, two rows

Tests: `tests/unit/singleFlight.test.ts` (5 tests: the guard, and the list of surveyed keyboard
paths it now covers). The mutation run caught 5 of 5, and the control survived.

#### R211 · S1 · The Lakehouse editor ran a statement twice for a double Ctrl+Enter

**Found** opening sweep 5, "a guard only the button honours". R207's double Enter in the swarm
Versions dialog was a class, so a survey read every keyboard path into a write or a costly action
(`tests/unit/singleFlight.test.ts` names the queue's list). It found fourteen where the key
skipped the button's in-flight guard, and none that submitted a state the button refuses. This is
the worst.

The Lakehouse editor's Run is `disabled={running}`, and Ctrl+Enter in the editor called the same
`run()` with no check. `run()` runs any statement, so a double key writes twice. In the UI, with a
fixture table `analytics.r211_double` (kept):
- `INSERT INTO analytics.r211_double VALUES (1, …)`, then Ctrl+Enter twice;
- `SELECT count(*)` read **2**.

The ask bar's Enter called `generate()` the same way past `disabled={generating}`: an LLM call
twice.

**The fix.** `src/lib/singleFlight.ts`:
- **`singleFlight(fn)`** runs `fn` once at a time. Its flag is set at the call, not in React state,
  so two key events in one tick cannot both pass it. It is released when the run settles, failed
  or not.
- **`useSingleFlight`** wraps a component's handler and always calls the latest one.

The editor's `run` and `generate` are both wrapped, so the button and the key share one guard.

**Driven after** (hot deploy of R211): the same INSERT for n = 2 with Ctrl+Enter twice answered
Count 1, and `SELECT n, count(*) … GROUP BY n` read **1 → 2 rows (before), 2 → 1 row (after)**.

### 2026-10-01 — count(*) 6000 beside "9,994 rows"

Tests: `tests/unit/queryGate.test.ts` (5 tests: a table filled in batches and read mid-load, a
failed load, the engine's wiring). The mutation run caught 6 of 6, and the control survived.

#### R210 · S2 · A browser query read a table half filled, or called a loading table missing

**Found** smoking the real image `5330adc25b2f` (R209). The Workbench's first
`SELECT count(*) FROM saas_sales` answered **6000**, while the explorer beside it said
**9,994 rows**, and the same query a minute later 9994.
- **The cause.** `materialise` fills a table 500 rows at a time with an await between batches, so
  6000 is 12 of the 20. Nothing kept a query from running in between, and it read the rows
  inserted so far without a word.
- **Earlier still.** On a fresh load, run at once, the same query said **"Catalog Error: Table
  with name saas_sales does not exist!"** while the rows were being fetched.
- **Who was exposed.** Every browser query: the Workbench, local BI charts, data prep, the BI
  agent, document generation.

The race is the old engine's as much as the new one's; the smoke happened to land in it.

**The fix.**
- **`src/lib/queryGate.ts`.** A load holds queries until it settles, failed or not, and a query
  waits for every load held when it starts.
- **`browserDuckdb.ts`.** `registerBrowserTables` holds its load, and `runBrowserSql` waits
  before it queries.
- **`sqlEngine.ts`.** `hydrateFromSupabase` holds the whole hydration, the row fetches before any
  table exists included.

**Driven after** (hot deploy of R210): on two fresh loads, the same query run at once showed
"Starting the SQL engine…" and answered **9994** after 6.4 s and 6.9 s. It did not say the table
was missing, and it did not answer part of it.

**Seen in the same smoke, not this code.** The real image's first Publish to Iceberg failed:
"Failed to commit Iceberg transaction: Request returned HTTP 500". The catalog's log said
`SQLITE_BUSY: database is locked`, and a retry under a new name failed the same way. The catalog
(`aswarm-iceberg-rest`, a JDBC catalog on SQLite) held a lock in its own process since some time
after the 11:48 publish; no journal was left on disk. A restart of that container released it, and
the next publish committed. The toast surfaced the 500 but not the lock, which the catalog's
response does not carry.

### 2026-10-01 — One query, DATE in the browser and TIMESTAMP on the server

Tests: `tests/unit/duckdbEnginesParity.test.ts` (12 tests: the browser's wasm build, run under
Node, beside the server's `@duckdb/node-api`). Against the old build it fails 3 of 12: the minor
version, and `date_trunc` on a TIMESTAMP and on a DATE. The 9 that agree on both builds are the
control.

#### R209 · S2 · The Workbench's two engines were different DuckDB versions

**Found** as R197's leftover. On the Workbench, `SELECT typeof(date_trunc('month', TIMESTAMP
'2026-01-15 10:00:00')), date_trunc(…), version()` answered:
- on "Local (in-browser)": **DATE · 2026-01-01 · v1.4.3**;
- on "Lakehouse": **TIMESTAMP · 2026-01-01 00:00:00 · v1.5.5**.

The browser ran `@duckdb/duckdb-wasm` 1.32.0, which bundles DuckDB 1.4.3; the server ran
`@duckdb/node-api` 1.5.5. The type a column comes back as decides how the charts read it (R197):
a DATE's text is a label, a TIMESTAMP's a time. So the same monthly query drew labels from one
engine and a time axis from the other, and the in-app docs said so as a known difference.

**The fix.** `@duckdb/duckdb-wasm` 1.33.1-dev57.0, the build npm's `latest` tag names, published
2026-06-22. It bundles DuckDB **1.5.4**: probed in a scratch install before the project took it,
beside `next` (1.33.1-dev65.0, DuckDB 1.5.6, newer than the server). Its worker and wasm file
names, its Arrow (^17) and its API are the old ones', so the app's imports are unchanged. It adds
`qs` and its helpers as dependencies. The test runs the wasm build the browser loads, in its Node
form, beside the server's, and holds them to one minor version and to the same result types
across date, interval, division, rounding, aggregate and strftime expressions.

**Driven after** (hot deploy of R209):
- **Local now answers** **TIMESTAMP · 2026-01-01 00:00:00 · v1.5.4**, with time zone UTC
  (R195), TIMESTAMPTZ `2026-09-30 22:30:00+00` and DATE `2026-09-30` (R197) as before.
- **The BI builder on Local,** `date_trunc('month', strptime("Order Date", '%m/%d/%Y'))` against
  `count(*)` over `saas_sales`, drew a time axis (2022-07 … 2025-12), as the server's does. R197
  recorded the old engine's labels, `2022-01-01, 2022-02-01, 2022-03-01`.

### 2026-10-01 — "1 file added" for a file search could not find

Tests: `tests/unit/kbSourceAndIndex.test.ts` (6 tests), and `kbAddSourceWrites.test.ts`, whose
slice ended at the old toast. The mutation run caught 9 of 9, and the control survived.

#### R208 · S2 · Add Source said nothing of a failed index, and an uploaded file read as a manual paste

**Found** in R192's leftovers. In the kept knowledge base "R192 add-source":
- **The labels.** Its uploaded `r192-*.txt` sources read **"MANUAL · Manual paste"** and their
  documents carried a **"Manual"** badge. An uploaded text file is stored as kind `manual`, the
  only kind the table's check allows for text, and the page named every `manual` source a paste.
- **The silent index.** `r208-one.txt`, added with the browser's fault injector failing the embed
  call, was announced **"1 file added"**. The dialog called the embed step and looked at nothing
  it returned: a thrown call went to the console, and a skipped one (no embedding key) went
  nowhere. The document sat "Pending embedding", found by keyword only.

**The fix.**
- **`src/lib/kbIndexNote.ts indexNote`** turns the embed step's outcome into a sentence: a failure
  with its reason, a skip for want of a key, or warnings. The dialog toasts "… added, not fully
  indexed" with it, on the File and Manual paths alike.
- **`src/lib/kbSourceLabel.ts`** names a `manual` source with an upload's filename in its config a
  **File** and an "Uploaded file". A real paste, which records no filename, stays "Manual paste".
  No migration.

**Driven after** (hot deploy of R208):
- **The labels.** Every uploaded `.txt` read **"FILE · Uploaded file"**, and its document **File**.
- **The embed failing.** `r208-two.txt` was announced **"1 file added, not fully indexed · Not
  indexed yet: Failed to fetch. Re-index retries; until then it is found by keyword only."**
- **The embed working.** `r208-three.txt` was "1 file added", "Indexed · 1 chunk".

### 2026-10-01 — One name, two versions; one click, no version

Tests: `tests/unit/swarmVersionGuards.test.ts` (4 tests, by source as R190's). The mutation run
caught 5 of 5, and the control survived.

#### R207 · S2 · The swarm Versions dialog saved twice on a double Enter and deleted without asking

**Found** in R190's survey and queued as read in the source, not yet driven. Driven on the canvas
of "R109 chat echo" with the browser's fault injector answering the version insert and delete
itself, so nothing was written or removed:
- **"R207 double enter" and two Enters** sent **two inserts, 16 ms apart**. Enter called *Save
  version* past the button's `disabled={saving}`, and the second key lands before React
  re-renders.
- **The trash icon** sent its DELETE on the first click, with no confirm, and the list read "No
  versions yet". Beside it, Restore asks first, and so does the component library's delete. A
  deleted snapshot cannot be got back.
- **A failed delete** said "Could not delete version" without the reason.

**The fix** (`SwarmVersionsDialog.tsx`):
- A ref, set before the first await and cleared after it, lets one save through at a time.
- The trash opens "Delete “<label>”? This snapshot (n nodes) is removed for good and cannot be
  restored afterwards. The canvas is not changed.", with Cancel and Delete.
- A failed delete gives its reason.

**Driven after** (hot deploy of R207, the same injector): two Enters sent **one** insert. The
trash opened the confirm with no request sent; Cancel left the version; Delete sent one DELETE.
The real "Autosave 1:00:42 AM" version is still in the database, since every delete was answered
in the browser.

### 2026-10-01 — Agent Chat with no conversation and no word why

Tests: `tests/unit/chatConversationStart.test.ts` (4 tests, by source as R191's). The mutation run
caught 6 of 6, and the control survived.

#### R206 · S2 · A first conversation that could not be saved left the page unusable and silent

**Found** from the queue ("the first conversation's auto-insert, whose error is dropped (worth a
round: does the page stay usable?)"). It does not.
- **Agent Chat makes a conversation** for an agent you have not chatted with. It read the
  insert's data and dropped its error.
- **New Chat** read `error` and never looked at it.
- **Without a conversation** the message box and Send are disabled (`!activeConvo`).

Driven on the real image `a4f99b7a55be` with the browser's fault injector (the agent's
conversations read as `[]`, the insert answering 500):
- no toast and no conversation;
- the message box disabled under **"Ask a question, share a task, or try a starter below."**;
- New Chat made a second failing insert and changed nothing.

**The fix** (`playground.tsx`): both inserts look at their error. A failure keeps its reason, toasts
"Could not start a conversation" or "Could not start a new chat", and the empty chat says "A
conversation could not be started, so there is nowhere to write yet: <reason>." with **Try
again**, which runs New Chat. A success clears it.

**Driven after** (hot deploy of R206):
- **The same injection.** The toast and the centre gave the reason, with Try again; New Chat
  toasted its own.
- **With the injector cleared,** Try again made one "New Chat" conversation (kept), made it active,
  enabled the message box, and the starters came back.

### 2026-10-01 — The year of an empty cell was 1899

Tests: `tests/unit/sheets1900Dates.test.ts` (5 tests: the serials both ways, the grid's formulas,
a table sheet's SQL both ways). The mutation run caught 9 of 9, and the control survived.

#### R205 · S1 · Serials before 1900-03-01 counted from the wrong day, and DATEDIF from formula.js's

**Found** as the last grid items R198's probe queued. In the workbook "R205 1900 dates" (kept):

| Formula | Grid | Excel |
| --- | --- | --- |
| `YEAR`, `MONTH`, `DAY` of a blank | **1899, 12, 30** | 1900, 1, 0 |
| `TEXT(1,"yyyy-mm-dd")` | **1899-12-31** | 1900-01-01 |
| `DATE(1900,3,1)-DATE(1900,2,28)` | **1** | 2 |
| `DATEDIF(DATE(1900,2,28),DATE(1900,3,1),"d")` | **0** | 2 |

- **Serials.** Every serial counted days from 1899-12-30, which is Excel's count only from
  1900-03-01 (serial 61). Before that, Excel counts 1900-01-01 as 1 and keeps Lotus 1-2-3's
  1900-02-29 as 60, and a blank, serial 0, is 1900-01-00.
- **DATEDIF** went to formula.js, which turns serials into dates and back by two rules that
  disagree around that day. Its 1900-03-01 to 03-02 was 2 days, in UTC as well as UTC+4.

**The fix.**
- **`values.ts dateSerial` and `serialParts`** count Excel's way below 61: 1 to 59 are 1900-01-01
  to 02-28, 60 is 02-29, 0 is 1900-01-00, and the weekday runs on from serial 1 (a Sunday, by
  Excel's count). From 61 nothing changes.
- **DATEDIF in days** is the difference of the serials, with #NUM! for a start after the end. Its
  calendar units still go to formula.js.
- **A table sheet's SQL** counts a date and reads a serial with the same one-day step before
  1900-03-01.

**Driven after** (hot deploy of R205): row 1 read **1900, 1, 0**, 1900-01-01, **1900-01-01**, 1,
the difference as serial **2**, and DATEDIF **2**. Row 2: `TEXT(60,"yyyy-mm-dd")` **1900-02-29**,
`DAYS` across it **2**, and DATEDIF from 03-01 to 03-02 **1**.

### 2026-10-01 — "Not configured" on a lakehouse that works

Tests: `tests/unit/prepSaveAs.test.ts` (4 tests). The mutation run caught 8 of 8, and the control
survived.

#### R204 · S1 · Data Prep's Save as said "not configured" while loading and after a failed read

**Found** in Phase D's survey ("a cause named that the evidence cannot support") and queued for a
BI round. Driven in BI → Data preparation with the browser's fault injector on the
lakehouse-tables server call (`_serverFn/0d66356b…`):
- **Held 20 s.** The palette's lakehouse list was a skeleton. The *Save as* select was disabled
  and titled **"The lakehouse is not configured on this deployment"**, on a deployment whose
  lakehouse lists 58 tables.
- **Failed.** The palette said **"Could not list lakehouse tables."**: the `.catch(() =>
  setLake("error"))` dropped the reason, and nothing could read the list again (the reload button
  reloaded local datasets only). *Save as* still said "not configured".

**The fix.** `src/lib/prepSaveAs.ts saveAsHint` titles the select by what is known:
- loading: "Checking the lakehouse…";
- a failed read: "The lakehouse tables could not be read: <reason>. A local dataset can still be
  saved.";
- "not configured" only when the server says so.

The tab keeps the error's message and shows it in the palette with **Try again**, and the reload
button reads the lakehouse list again too.

**Driven after** (hot deploy of R204):
- **Held 15 s.** "Checking the lakehouse…", then enabled with its usual title when the call
  returned.
- **Failed.** A first injection answered 500 with a hand-made body, which is not the server
  function's wire format, so the client failed reading `schemas` and that is what the palette
  quoted. The realistic failure, the request itself failing, read "Could not list lakehouse
  tables: Failed to fetch" with Try again, and the same reason in the title.
- **Try again**, with the injector cleared, listed the 58 tables and enabled *Save as*.

### 2026-10-01 — A finished chart that would not add, and nothing saying why

Tests: `tests/unit/biBuilderReady.test.ts` (6 tests), and `tests/journey/semanticToDashboard.test.ts`,
whose guard pinned the old inline condition and now pins the `metricBlocker` wiring. The
mutation run caught 9 of 9, and the control survived.

#### R203 · S1 · "Add to dashboard" stayed disabled for a missing title, silently

**Found** in R196 and queued. Driven again in the BI project "R196 dates":
- Build a chart, then a query `SELECT * FROM (VALUES ('North', 12), ('South', 7)) v(region,
  orders)`, then Run (2 rows · 2 cols).
- The columns were chosen and the bar chart was drawn in the pane, but **Add to dashboard** stayed
  disabled, with no title attribute and no text.
- The one thing missing was the widget title. Its empty box showed its placeholder, "Revenue by
  month", in grey, which reads as a title already given.

**The fix.** `src/lib/biBuilderReady.ts` names the first thing missing, in the order the pane is
filled:
- a query to write, then to run;
- the columns to chart (or, for an ontology, the map);
- the title.

A governed metric goes model, metrics, Preview, title. The pane disables the button on that same
answer and shows it beneath, and the placeholder reads "e.g. Revenue by month".

**Driven after** (hot deploy of R203): the empty pane said "Write a query or pick tables, then
Run it."; with the query typed, "Run the query to see its rows."; with the chart drawn, "Give the
widget a title."; with "Orders by region" typed, the button was enabled and the line gone. The
pane was closed without adding, so the kept project is unchanged.

### 2026-10-01 — A paid call at "~$0.0000" beside "~$0 means no known price"

Tests: `tests/unit/usdFormat.test.ts` (4 tests: the format, and a survey of `src` that fails on a
cost written with 3 to 8 places). The mutation run caught 10 of 10, and the control survived.

#### R202 · S2 · A cost under half a hundredth of a cent read as zero, and each page wrote cost its own way

**Found** from the queue's Phase E item, "Prompt Compare rounds cost to four places".
- **Prompt Compare.** On the real image, Gemini 2.5 Flash against GPT-5 Mini on "Reply with the
  single word OK." showed Flash's call (7 tokens in, 1 out) as **~$0.0000**. The page's own note
  says "older models without a known price show ~$0", so a priced model read as an unpriced one.
- **Traces.** The same call read **$0.0000**, the same as the `openrouter/free` rows that cost
  nothing, and so did its detail.
- **The other pages.** About 25 places wrote cost: most with `toFixed(4)`, the playground's trace
  with `toFixed(6)`, Evaluations with "$0" for zero, and the spend panel with "$0.00".
- **Analytics.** The charts rounded their data to 4 places, so a model's sub-cent total was drawn
  as 0.

Reading the stored row directly to prove the cost was non-zero would have meant taking the
session token and API key out of the page, and the session's classifier refused that. The
evidence is from the UI alone: the paid model's call against the free ones, and the same call
on a second surface after the fix.

**The fix.** `src/lib/usd.ts formatUsd` is the one format:
- No figure is "—" and zero is "$0.00".
- From $1, two grouped decimals; from a cent, four.
- Under a cent, two significant digits without a trailing zero.
- `~` marks an estimate.

Every per-call and per-row cost goes through it: Prompt Compare, Traces (row and detail), the
playground's trace, swarm runs, Team Spend, the audit log, run observability, the dashboard, the
knowledge base's OCR toast, the lakehouse's AI-functions title, Evaluations, the spend panel and
the integration test's message. Analytics keeps the true figures and formats them in the
tooltip. Budgets and totals keep whole cents.

**Driven after** (hot deploy of R202):
- **Prompt Compare.** The same prompt read Flash **~$0.0000046** and Mini **~$0.00016**.
- **Traces.** Those calls read **$0.000005** and **$0.00016**, the earlier Flash calls
  **$0.000005**, and the free model's rows **$0.00**.
- **The trailing zero.** A first cut wrote the stored 0.000005 as "$0.0000050", so trailing
  zeros under a cent are now trimmed.

**Left, for the queue:** the database keeps six places (`NUMERIC(10,6)`), so that call is stored
as $0.000005, about 9% over its $0.0000046. A total over many such calls carries the rounding.
Changing it is a migration.

### 2026-10-01 — 12,345,678,901 shown as "1.234567890e+1"

Tests: `tests/unit/sheetsBigNumbers.test.ts` (9 tests: Excel's answers, and the table's CEILING,
FLOOR and TEXT held to the grid over about 1,400 values), `sheetsGridTableParity.test.ts` (its
QUEUED rows emptied), `sheetsGridExcelText.test.ts` (one pin corrected). The mutation run caught
10 of 10, and the control survived.

#### R201 · S2 · Numbers at the edge of 15 digits: one shown as about 12, quotients a hair off, formats past 15 digits

**Found** following R200's QUEUED rows, in workbook "R201 big numbers" (kept): a grid row and a
table sheet over a lakehouse query with the same values.

| | Grid | Table | Excel |
| --- | --- | --- | --- |
| 12345678901.005 in General | **####** | **1.234567890e+1** | 12345678901 |
| `CEILING(0.0000000001,1)` | **0** | **0** | 1 |
| `CEILING(5.0000000001,1)` | **5** | **5** | 6 |
| `CEILING(12345678901.005,1)` | **12345678901** | 12345678902 | 12345678902 |
| `TEXT(1.5E+21,"0")` | **1** | 1500000000000000000000 | 1500000000000000000000 |
| `TEXT(12345678901234567,"#,##0")` | **…234,568** | **…234,568** | 12,345,678,901,234,600 |

- **The worst is the first.** General used `toPrecision(10)`, which writes an exponent of its own
  for eleven whole digits ("1.234567890e+10"). The trailing-zero trim then cut the exponent's last
  digit, so the table showed a number of twelve billion as about 12. The grid measured the long
  string, found it too wide and showed ####. 1.5E-07 showed as "1.500000000e-7".
- **CEILING and FLOOR.** The grid snapped a quotient within 1e-9 × itself of a whole number, which
  at 1.2e10 is a band of about 12. The table rounded the quotient to 9 places, which loses a tenth
  of a billionth.
- **Formats.** The grid's number format wrote `toFixed`, which from 1E+21 is exponent text that
  "0" read as 1; below that it writes the binary's own digits past the 15th, as the table's
  `format()` did.
- **A test helper.** The parity test's `shown()` rounded to 9 places and made the table's right
  12345678902 read as 12345678902.000002. It now shows 15 digits.

**The fix.**
- **General** (`values.ts`) takes 11 digits from 1E+10 and goes to scientific notation whenever
  toPrecision would, with a two-digit exponent.
- **Number formats** (`format.ts excelFixed`) past 15 digits write the 15 and then zeros.
- **CEILING, FLOOR and the .MATH forms** read the quotient at 15 digits: `functions.ts quotient15`
  in the grid, and `compile.ts quotient15Sql` in a table. The SQL takes R200's fast path: only a
  quotient within its 15th digit of a whole number is read from its digits.
- **A table's TEXT** past 15 digits writes the 15 digits and zeros, with thousands separators
  through HUGEINT.

**Driven after** (hot deploy of R201): the grid row read **1, 6, 1.4, 12345678902,
1500000000000000000000, 12,345,678,901,234,600**, and G1 and H1 (12345678901.005 and twice it)
read **12345678901** and **24691357802** where they had shown ####. The table read amount
**12345678901**, ceil_tiny **1**, ceil_five **6**, text_long **12,345,678,901,234,600**.

**Checked and left alone.** MROUND(1.3, 0.2), Microsoft's own example, is 1.4 in both engines.

### 2026-10-01 — ROUND(1.005, 2) is 1 in a table and 1.01 in the grid beside it

Tests: `tests/unit/sheetsExcelRounding.test.ts` (13 tests: Excel's answers, and the compiled SQL
against the grid's TypeScript over about 2,100 values), and `sheetsGridTableParity.test.ts` (new
rows and formulas). The mutation run caught 19 of 19, and the control survived.

#### R200 · S2 · A table sheet rounded the binary and wrote 17 digits, where the grid and Excel do neither

**Found** by R199's second probe, which added the rows 0.01+0.075, 1.005 and "o'neil 2-way" to
the grid-vs-table parity test. In the UI, workbook "R200 table rounding" (kept): a grid sheet and
a table sheet (a lakehouse query) hold the same values and formulas.

| Formula | Table sheet | Grid | Excel |
| --- | --- | --- | --- |
| `ROUND(1.005,2)` | **1** | 1.01 | 1.01 |
| `TEXT(1.005,"0.00")` | **1.00** | 1.01 | 1.01 |
| 0.01+0.075 `&""` | **0.08499999999999999** | 0.085 | 0.085 |
| `TRUNC(0.29,2)` | **0.28** | **0.28** | 0.29 |
| `PROPER("o'neil 2-way")` | **O'neil 2-way** | O'Neil 2-Way | O'Neil 2-Way |

- **The table.** DuckDB's `round()` rounds the stored binary, a number became text with
  DuckDB's 17 digits, and PROPER split at spaces only.
- **The grid.** It had its own error. TRUNC cut the binary (0.29 × 100 is 28.999999999999996).
  ROUND guarded float noise with an absolute 1e-9 after scaling, which rounds 2.674999999999 up
  to 2.68 and is smaller than a large amount's binary error.

**The fix.** One rule in both engines, Excel's: take the 15 significant digits, shift them by d
places as decimal text (which is exact), round, and shift back.
- **The grid.** `format.ts excelRound` serves ROUND, ROUNDUP, ROUNDDOWN, TRUNC (now ROUNDDOWN, as
  in Excel) and every number format.
- **The table.** `compile.ts excelRoundSql` does the same steps in SQL, `numberTextSql` writes a
  number as the grid's `numberText` does, and PROPER splits the text into runs of letters and of
  anything else.
- **The sweep.** It holds the SQL to the TypeScript over about 2,100 values: decimals ending in
  5, sums, tiny and huge numbers, and d from −3 to 5.

**Three first cuts were wrong, and the tests caught each:**
1. **The lambda's name.** It was `p`, the same name the column SQL gives its row. `p.d` read the
   row's column, and `TRY` turned the error into a blank.
2. **Speed.** Writing every row as text cost 18 times `round()` over a million rows. Now most
   rows take plain arithmetic: when the scaled value is clear of the half by more than any
   15-digit or binary error could move it, plain rounding gives the same answer. Only rows on
   the edge are worked out from their digits.
3. **Subqueries.** A lambda that read its argument directly broke a whole-column total
   (`/SUM([rate])`): DuckDB refuses a subquery inside a lambda. Short arguments are now written
   out, and long ones are bound once.

Measured over a million rows (DuckDB 1.5.5):

| | ROUND(x,2) | Number in text |
| --- | --- | --- |
| Random doubles | 75 ms (`round()` 67) | 846 ms (17 digits each, all worked out from their digits) |
| Three-place decimals | 209 ms (`round()` 64) | 216 ms (cast 79) |

**Driven after** (hot deploy of R200): the table read round2 **1.01**, text2 **1.01**, joined
**0.085**, trunc2 **0.29** and proper **O'Neil 2-Way**, the same as the grid, whose F1
`=TRUNC(0.29,2)` now reads **0.29**. A new column `=ROUND([@price]*[@rate]/SUM([rate]),2)`, over
a whole-column total, reads 1.01.

**Found beside it, for R201** (numbers past 15 digits): the parity test lists these rows as
QUEUED.
- **CEILING.** The grid snaps a quotient within 1e-9 × itself of a whole number, so
  `CEILING(12345678901.005, 1)` is …901 there, where Excel gives …902. The table gives
  12345678902.000002.
- **Large numbers in a format.** A grid number format past 1E+21 writes toFixed's exponent text:
  `TEXT(1.5E+21,"0")` gives "1". The table writes every binary digit, where Excel stops at 15.

### 2026-10-01 — 2.67 from TEXT, 2.68 from ROUND, in the same row

Tests: `tests/unit/sheetsGridExcelText.test.ts` (5 tests). The mutation run caught 7 of 7, and the
control survived.

#### R199 · S2 · The grid's number formats rounded the binary, not the number Excel shows

**Found** by R198's probe, among the grid's own differences from Excel. In the UI, workbook
"R199 grid text" (kept), row 1:

| Cell | Formula | Grid | Excel |
| --- | --- | --- | --- |
| A1 | 2.675 | 2.675 | 2.675 |
| B1 | `=TEXT(A1,"0.00")` | **2.67** | 2.68 |
| C1 | `=ROUND(A1,2)` | 2.68 | 2.68 |
| D1 | `=PROPER("ÉCOLE normale")` | **éCole Normale** | École Normale |
| E1 | `=TEXT(A5,"0.00")`, A5 blank | **(empty)** | 0.00 |

The grid disagreed with itself in B1 and C1.
- **Rounding.** 2.675 is stored as 2.67499999999999982…. ROUND already guarded against float noise,
  but the number formatter, which TEXT and every formatted cell use, called `toFixed` on the
  stored binary.
- **PROPER.** A letter was `[a-z]`, so "É" counted as a word break.
- **TEXT of a blank.** The blank went to the formatter as nothing, not as 0.

**The fix:**
- **`excelFixed`** (`lib/sheets/format.ts`) rounds the 15 significant digits Excel keeps. It scales
  their decimal text by a power of ten, which is exact, so `0.01+0.075` (0.08499999999999999 in
  binary, 0.085 to Excel) formats as 0.09. Every number format with decimals goes through it.
- **PROPER** treats any letter, in any script (`\p{L}`), as a letter. As before, a letter whose
  capital is two letters (`ß`, `ﬁ`) stays as it is. The first cut turned a word-initial "ß" into
  "SS", which the old `[a-z]` never did, so that was kept.
- **TEXT** reads a blank as 0.

**Driven after** (hot deploy of R199): B1 2.68, D1 École Normale, E1 0.00. A1 formatted
**Number** (`#,##0.00`) shows 2.68. F1 `=0.01+0.075` shows 0.085, and `=TEXT(F1,"0.00")` 0.09.
`=PROPER("ß straße ÑANDÚ")` is "ß Straße Ñandú".

**What a second probe found, for R200.** It was run with new parity rows (0.01+0.075, 1.005,
"o'neil 2-way", "ÉCOLE normale"). The table sheet's compiled SQL differs from the grid and from
Excel on four formulas:
- A number in text is `0.08499999999999999` (LEN 19), where the grid and Excel give 0.085.
- `ROUND(1.005,2)` is 1, where the grid and Excel give 1.01.
- `TEXT(1.005,"0.00")` is 1.00, where the grid and Excel give 1.01.
- PROPER splits on spaces only, so `o'neil 2-way` is `O'neil 2-way`, where the grid and Excel give
  `O'Neil 2-Way`.

### 2026-10-01 — "bob: 0" in a table sheet, "bob: " in the grid beside it

Tests: `tests/unit/sheetsGridTableParity.test.ts` (42 tests, grid engine against the compiled SQL on
DuckDB), with `sheetsSqlCompile.test.ts`. The mutation run caught 8 of 8, and the control
survived.

#### R198 · S2 · A table sheet's calculated column read a blank as 0 outside arithmetic

**Found** as sweep 4's grid-vs-table item. A grid sheet evaluates a formula in the browser's
engine; a table sheet compiles the same Excel to DuckDB SQL (`lib/sheets/sql/compile.ts`). A
probe ran 75 formulas over the same seven rows both ways. Most of what differs is documented (a
table column has no error values; text in a database is never blank), but these were not:
- **A blank number was "0" in text.** `CONCAT(blank, blank)` gave "0", `[@n]&""` gave "0", and
  `LEN(blank)` gave 1. The docs already promised a blank "counts as 0 in arithmetic and as "" in
  text".
- **MIN, MAX and AVERAGE counted a blank reference as 0.** `AVERAGE([@n], 1)` was 0.5 and
  `MIN([@n], 1)` was 0, where Excel and the grid ignore the empty reference and give 1 and 1.
- **`MROUND(-2.5, 0.5)` gave −2.5,** where Excel gives #NUM! for signs that differ.

**In the UI,** workbook "R198 blanks" (kept): a table sheet over a lakehouse query with bob's
amount blank, and a grid sheet holding the same values and formulas. The table read
`bob: 0 | 0.5`; the grid read `bob:  | 1`.

**The fix** (`lib/sheets/sql/compile.ts`):
- **Text.** A bare number column that is NULL reads as "" in `toText`.
- **MIN, MAX, AVERAGE.** Over a row's values they take `referencedNumber`: a reference to a blank,
  text or TRUE/FALSE is NULL and skipped. MIN and MAX of nothing are 0. An AVERAGE of nothing is
  blank, which stands in for #DIV/0! under the table rule.
- **MROUND** with differing signs gives NaN, which a table cell shows as `#NUM!` through the shared
  formatter, as it already did for a negative to a fractional power.

**A first cut turned NaN into a blank as well.** In the UI, the table sheet already showed NaN as
`#NUM!`, which is right, so that part was reverted. One existing expectation that pinned the blank
as "0" changed, with a comment.

**Driven after** (hot deploy of R198): the table read `bob:  | 1 | #NUM!`, the same as the grid. A
new column `=MROUND(-[@amount],0.5)` read `#NUM!` for alice and 0 for bob. All 57 Sheets test files
(775 tests) pass.

**Grid-side differences the probe found, for R199:**
- `PROPER("ÉCOLE")` gives "éCole".
- `TEXT(2.675, "0.00")` gives "2.67" where Excel gives 2.68.
- `TEXT(blank, "0.00")` gives "" where Excel gives 0.00.
- `YEAR(blank)` gives 1899 where Excel gives 1900.

### 2026-10-01 — `1640995200000` in the Workbench, text on the server

Tests: `tests/unit/engineTemporalText.test.ts` (8 tests). The mutation run caught 11 of 11, and
the control survived.

#### R197 · S1 · The browser engine wrote dates as epoch milliseconds

**Found** as R196's queued item, on the real image `cad98aaa39f9`:
- **The grid.** Arrow hands DATE and TIMESTAMP to JavaScript as epoch milliseconds, and the browser
  engine passed them on. On "Local (in-browser)", the Workbench grid for
  `date_trunc('month', strptime("Order Date", '%m/%d/%Y'))` and its day read
  `1640995200000 | 1641254400000`; the server engine writes `2022-01-01 00:00:00` and `2022-01-04`.
  A CSV export writes whatever the grid holds.
- **The charts.** The auto axis relabels only numbers, so one query shape was labelled two ways. A
  builder preview over the local `saas_sales` read "2022-01-01, 2022-02-01, 2022-03-01", while the
  lakehouse tile from R196 read "2026-02-01 00:00:00, 2026-03-01 00:00:00".

**The fix** (`lib/duckdbValues.ts`, `lib/browserDuckdb.ts`, `lib/biChartMath.ts`):
- **`arrowTemporalKind`** tells a DATE, TIMESTAMP and TIMESTAMPTZ field apart by Arrow type id, with
  the type's name as a fallback.
- **`formatTemporal`** writes the value the way the server engine does: `2022-01-04`,
  `2026-09-30 22:30:00.25`, `2026-09-30 22:30:00+00`. `runBrowserSql` uses both.
- **`hasRawDateValues`** now counts the engines' TIMESTAMP text, a date with a time down to the
  second, as raw, so the auto axis labels it like an epoch.

**A first cut went too far.** It counted a bare `2026-01-05` as raw as well, and an existing test
failed. That test pins the rule that a bare day may be a `strftime` label someone chose, and text
cannot tell it from a DATE. The rule stands, with a test and a mutant for it.

**Seen while driving it:** the browser engine is DuckDB **1.4.3** and the server's **1.5.5**.
`date_trunc('month', <TIMESTAMP>)` returns a DATE in the browser and a TIMESTAMP on the server,
so over a long span the server's axis relabels and the browser's does not. Queued.

**Driven after** (hot deploy of R197):
- **The grid** read `2022-01-01 | 2022-01-04 | 16`, and a probe gave `2026-09-30 22:30:00.25 |
  2026-09-30 22:30:00+00 | 2026-09-30`.
- **The lakehouse tile** at AUTO read "2026-01-01, 2026-02-01, 2026-03-01". The browser preview read
  "2022-01-01, 2022-02-01, 2022-03-01", as before.

### 2026-10-01 — January charted as December, east of UTC

Tests: `tests/unit/chartDateUtc.test.ts` (6 tests; runs at `Asia/Dubai`). The mutation run caught
7 of 7, and the control survived.

#### R196 · S2 · A server-run tile moved every month back one for a viewer at UTC+4

**Found** following R195's leftover, the two value formats:
- **The two forms.** The browser engine hands a TIMESTAMP to the chart as an epoch number, and the
  server engine as text, `2026-01-01 00:00:00`. `parseDateValue` passed that text to
  `new Date`, which reads a date-time with no offset as the viewer's local time. At UTC+4 that is
  20:00 UTC the day before.
- **The unit probe** (`TZ=Asia/Dubai`): `"2022-01-01 00:00:00"` bucketed to month `2021-12`, while
  `"2022-01-01"`, `"…+00"` and the epoch all gave `2022-01`.
- **In the UI.** A new fixture BI project, "R196 dates" (kept), got a line chart on the lakehouse:
  `SELECT date_trunc('month', CAST(placed_on AS TIMESTAMP)) AS month, count(*) AS orders FROM
  analytics.stg_revenue GROUP BY 1 ORDER BY 1`. At DATE GRAIN month it labelled the three months
  **2025-12, 2026-01, 2026-02**. The Lakehouse page's answer to the same SQL: 2026-01-01 272,
  2026-02-01 273, 2026-03-01 291.
- **The scope.** Every month moved back one, for every viewer east of UTC, on every tile a server
  computes (lakehouse tiles live, and any tile after a scheduled refresh). The same tile run in the
  browser was right. The generated lakehouse dashboards were not affected, because their values
  carry an offset or are dates.

**The fix** (`lib/biChartMath.ts`): `parseDateValue` reads text without an offset as UTC
wall-clock time, the zone the engines run in since R195. It leaves alone what `new Date` already
reads as UTC (`2026`, `2026-01`, `2026-01-01`) and anything carrying Z, ±hh[[:]mm], GMT or UTC.
A written date such as `11/9/2024` now names that calendar day for every viewer. The 37 BI,
chart, report and date test files (622 tests) pass at UTC+4.

**Driven after** (hot deploy of R196): the same chart at month grain read **2026-01, 2026-02,
2026-03**, and at day grain 2026-01-01, 2026-02-01, 2026-03-01. It was added to the project as
"Orders by month (naive TIMESTAMP, R196)". Seen in passing: *Add to dashboard* stays disabled until
the chart has a title, and nothing says so.

### 2026-10-01 — One query, two engines, two days

Tests: `tests/unit/engineTimeZone.test.ts` (4 tests). The mutation run caught 5 of 5, and the
control survived.

#### R195 · S2 · "today" was tomorrow in the Workbench and today on a schedule

**Found** as sweep 4's second round. Local datasets run on DuckDB in two places: in the browser
(WebAssembly) for the Workbench and Ask AI, and on the server for scheduled refreshes, prep flows,
the semantic runner and the agents' `sql_query`. The Data Catalog Workbench offers both engines in
one editor. At 01:40 in a UTC+4 browser (21:40 UTC), one query:

```sql
SELECT current_setting('TimeZone') AS tz, current_date AS today,
       CAST(TIMESTAMPTZ '2026-09-30 22:30:00+00' AS DATE) AS order_day, DATE '2026-09-30' AS plain_date
```

- "Local (in-browser)": `Etc/GMT-4 | 1790812800000 | 1790812800000 | 1790726400000`, that is,
  today and the order's day both **2026-10-01**.
- "Lakehouse · AgentSwarms": `Etc/UTC | 2026-09-30 | 2026-09-30 | 2026-09-30`.

The browser engine takes the viewer's zone (ICU reads it from the browser), and the server engines
take the container's. A "today" or "orders per day" tile therefore counted different rows in the
Workbench than in its scheduled refresh. An agent answering from the same data named a different day
from the one the person had just seen.

**The fix** (`lib/duckdbValues.ts`, `lib/browserDuckdb.ts`, `utils/data/duckdb.server.ts`,
`utils/lakehouse/core.server.ts`):
- **One constant,** `ENGINE_TIME_ZONE = "UTC"`.
- **The browser engine** sets it on its connection before it reports ready.
- **The local-dataset engine** sets it globally before its configuration is locked.
- **The lakehouse engine** sets it globally when the instance starts.

The server's two engines were already UTC, but only because their container was: an operator who
set `TZ` would have split them again. None of these settings is fatal, since an engine without ICU
has no zone setting and runs in UTC anyway. The test runs the local-dataset engine with `TZ` set
to `Asia/Dubai` before it starts.

**Driven after** (hot deploy of R195). The same editor and a similar query gave
`UTC | 1790726400000 | 1790726400000 | 2026-09-30 22:30` in the browser and
`UTC | 2026-09-30 | 2026-09-30 | 2026-09-30 22:30` on the lakehouse. The lakehouse now reports
`UTC` rather than `Etc/UTC`, which shows the explicit pin is live. The days agree.

**What is still different,** for R196: the browser writes a DATE as epoch milliseconds
(`1790726400000`) where the server writes `2026-09-30`. The two formats reach the charts
differently: V8 reads the server's naive `2026-09-30 22:30:00` as local time, and the browser's
epoch as UTC.

### 2026-10-01 — Prompt Compare: "Est. cost —" while the server sent the cost

Tests: `tests/unit/promptCompareCost.test.ts` (4 tests), with `tests/unit/chatStream.test.ts`. The
mutation run caught 6 of 6, and the control survived.

#### R194 · S2 · The page built to compare cost showed none, beside Traces showing it

**Found** smoke-testing the real image `6b8a7e784718` (R191–R193). This is the first round of sweep 4,
"two surfaces, two answers":
- **The run.** Prompt Compare ran Gemini 2.5 Flash against GPT-5 Mini ("Reply with the single
  word OK.") and showed "Est. cost — / —" and "Tokens ~1 / ~1". The footnote under it says "Cost
  and token counts come from the server".
- **Traces for the same calls:** gpt-5-mini 13/55 tokens, $0.0001; gemini-2.5-flash 7/1, $0.0000.
- **The raw bodies,** tee'd in the browser, each arrived as one chunk ending `data: [DONE]` and then
  the platform's `event: cost`: Flash `{"costUsd":0.0000046,"tokensIn":7,"tokensOut":1}`, Mini
  `{"costUsd":0.00012325,"tokensIn":13,"tokensOut":60}`, about 27 times Flash. The one comparison
  the page exists to make was blank.
- **The cause.** The page had its own copy of the stream reader, and it did `break` at `[DONE]`.
  Nothing read the rest of the buffer after the loop. The playground had fixed the same bug in its
  own reader, with a comment ("Do NOT stop reading here…"), and every other reader in `src` does
  `continue` there; this copy never got the fix.

**The fix** (`lib/chatStream.ts`, `routes/_authenticated/prompt-compare.tsx`):
- **One reader.** Prompt Compare reads the stream with `readChatStream`, the one the swarm executor
  uses, which gains an optional `delta` callback so the page can show the text as it streams.
- **A test over every reader in `src`.** None may `break` at `[DONE]`. A `return` from a per-line
  `consumeLine` skips the line and is allowed.

**Driven after** (hot deploy of R194): the same run showed "Est. cost ~$0.0000 / ~$0.0001" and
"Tokens 7/1 / 13/55". That is what the streamed cost events carried, and the Traces rows agree
(13/55, $0.0001; 7/1, $0.0000). R27's ranking was re-checked on the same image with a third panel
refused: "(ranking excludes 1 did not answer)", and the failed panel's 0.1s was not crowned.

### 2026-10-01 — "AI credits exhausted" for a budget cap

Tests: `tests/unit/chatFailure.test.ts` (6 tests). The mutation run caught 8 of 8, and the control
survived.

#### R193 · S2 · The platform's refusals, blamed on the provider

**Found** as Phase D's first item, the survey for sweep 3 ("a cause named that the evidence
cannot support"). The survey searched the app's own strings for asserted causes ("may have",
"because the", "is not configured", "no API key"); R191's "The request may have failed before the
trace row was written" was already one. The playground's chat failure handling was the next:
- **Every 402 was "AI credits exhausted".** The chat route answers 402 `budget_exceeded` itself
  when a monthly cap is reached (`ENFORCE_BUDGET_CAP`), before any provider is called. The
  playground showed "AI credits exhausted · This model can't be used right now because the AI
  credits are exhausted. Pick another model and we'll continue this chat with full context." It
  offered five models, every one of which the same cap refuses. The route's own sentence ("You
  have reached your monthly AI budget ($5.00). (spent $5.12 of $5.00 this month.)") appeared
  nowhere.
- **Every other failure was prefixed with the provider's name.** The route's 403
  `model_not_allowed` read "openrouter: Your administrator has not allowed
  openrouter/openai/gpt-4o-mini for your account…", putting the administrator's rule in the
  provider's mouth.

The cap is opt-in through `.env`, and it was not switched on. So the route's exact bodies were
answered from the browser, on "Sample · SQL Reviewer" in R191's fixture conversation, on the hot
deploy of R192. What was under test is how the client reads a real response shape; the route's
side is covered by its own tests.

**The fix** (`lib/chatFailure.ts`, `routes/_authenticated/playground.tsx`):
- **`classifyChatFailure`** reads the parsed body. The route marks its own refusals with a code
  in `error` and the sentence in `message`: `budget_exceeded`, `model_not_allowed` and
  `conversation_too_large` are "platform". An upstream provider's failure carries only its
  sentence in `error`, and it still classifies by status and wording as before.
- **The playground** opens the fallback picker only for a provider's rate limit or credits. It
  names the provider only in front of the provider's own errors, so a platform refusal is shown
  as the route wrote it.

**Driven after:**
- **The budget body:** no dialog, and the toast "You have reached your monthly AI budget ($5.00).
  (spent $5.12 of $5.00 this month.)".
- **The model-rule body:** the toast "Your administrator has not allowed
  openrouter/openai/gpt-4o-mini …", with no provider name in front.
- **The control,** the route's upstream shape for a provider's 402 (`{error: "AI credits
  exhausted for this provider."}`): the picker, "AI credits exhausted", as before.

### 2026-10-01 — "2 files added", and a source reading "ok · 0 docs"

Tests: `tests/unit/kbAddSourceWrites.test.ts` (7 tests). The mutation run caught 14 of 14, and
the control survived.

#### R192 · S2 · A file that was not added, counted as added and listed as ok

**Found** as Phase C's last item, the add-source dialog from the write survey, on the hot deploy
of R191:
- **The File tab** writes a `kb_sources` row and then a `knowledge_documents` row per file. It
  dropped the document insert's error, and it toasted the number of files dropped in, not the
  number that landed. The setup was a fixture base, "R192 add-source" (kept), and two small .txt
  files, `r192-alpha.txt` and `r192-beta.txt`, with only the first document insert refused from
  the browser.
- **What came back:** "2 files added" and the dialog closed. The tabs read Documents (1) and
  Sources (2), and the Sources list showed "r192-alpha.txt · ok · 0 docs". A source said its file
  was there, and the file itself was gone from the dialog, so trying again meant finding it again.
  The Manual tab left the same orphan when its document insert failed.
- **The list, seen in passing.** With the base list's read held for six seconds, the page said
  "No knowledge bases yet." beside *New Knowledge Base* until the read landed. The error state
  was handled already (R76); loading was not.

**The fix** (`components/knowledge/AddSourceDialog.tsx`, `routes/_authenticated/knowledge.tsx`):
- **The document insert** keeps its error. A file whose document did not land takes its source back
  (`withdrawSource`); if that delete fails too, the source is set to `status = 'error'` with the
  reason.
- **The dialog counts what landed.** "1 of 2 files added", or "The file was not added" / "None of
  the N files were added", names each file that did not land with its reason, and keeps those
  files listed and the dialog open. The lists refresh either way.
- **The base list** has a loaded flag and uses `listState`, so until the read lands it says
  "Loading your knowledge bases…".

**The first after-drive found a fault in the fix.** With both the document insert and the
withdraw refused, the toast read "The file was added": the ternary had lost its "not". The lists
were not refreshed when nothing landed, so the source now marked as an error only showed after a
reload. Both were fixed, and a test and two mutants were added.

**Driven after:**
- **The list:** "Loading your knowledge bases…", then the bases.
- **Two files, one refused:** "1 of 2 files added · Not added, still listed here to try again:
  r192-gamma.txt: R192 injected: …". The dialog stayed open with gamma alone, and Sources rose by
  one. Add source again gave "1 file added", and gamma, delta and beta each have 1 doc.
- **Document and withdraw both refused:** Sources showed "r192-zeta.txt · error · 0 docs · The
  document was not saved: …" at once.
- **Source insert refused:** "The file was not added · Not added, still listed here to try again:
  r192-zeta.txt: …", with no new row.

### 2026-09-30 — "Trace not recorded" for a trace that was recorded

Tests: `tests/unit/playgroundReads.test.ts` (5 tests). The mutation run caught 11 of 11, and the
control survived.

#### R191 · S2 · The inspector blamed the request for a read that failed in the browser

**Found** as Phase C's next item, the client read survey's playground batch, driven on the real
image `c9e16c0b2b3b` with the reads refused from the browser:
- **The Trace tab** polls `execution_traces` for the last message's trace, eight times, 750 ms
  apart, and dropped every error. "Sample · SQL Reviewer" (`openai/gpt-4o-mini`) was sent "Reply
  with the single word OK." in a new chat, with the read refused. It answered "OK". After eight
  refused reads the tab said "Trace not recorded · The request may have failed before the trace
  row was written." The Traces page listed the trace at the top: "Sep 30 23:15:34 · Sample · SQL
  Reviewer · openai/gpt-4o-mini · 4.1s · 100/1 · ok". The one page built to show what really
  happened blamed the server for a failure in the browser.
- **The agent list.** The page was reached client-side with the read refused. The selector opened
  with no options under a pulsing "Pick an agent to begin"; the middle said "Select an agent to
  start · Choose an agent from the top bar". A normal load lists nine agents.

**The fix** (`routes/_authenticated/playground.tsx`):
- **The trace poll** keeps the last read's error. When it ends without a row after an error, the
  tab says "Trace not read · The trace could not be read, so this says nothing about whether it
  was recorded: …" with *Try again*. "Trace not recorded" is left for polls that read the table
  and found nothing.
- **The agent read** keeps its error and fills the list only from a read that worked. The bar shows
  an error mark in place of the pick hint. The middle says "Your agents could not be read · So
  there is nothing to pick yet: …" with *Try again*, which reads them again.
- **Where Try again sits.** The first after-drive put "Agents not read · Try again" in the bar,
  and with the inspector open it ran under the inspector's toggle. The bar is about 330 px wide
  there, and the picker takes 170 of it. The mark stayed in the bar and Try again moved to the
  middle.

**Driven after** (hot deploy of R191):
- **Agents:** refused, the mark and "Your agents could not be read … Try again"; lifted, Try
  again gave "Chat with Sample · Graph RAG Explorer (Acme Corp)".
- **Trace:** the same prompt in the same chat, with the read refused, gave "Trace not read …
  R191 injected: the GET did not reach the database · Try again". Lifted, Try again gave the trace:
  success, 2136 ms, $0.000018, 116 in / 1 out.

### 2026-09-30 — A restore promised as undoable, done without its undo

Tests: `tests/unit/swarmVersionWrites.test.ts` (5 tests). The mutation run caught 10 of 10, and
the control survived.

#### R190 · S2 · "Your current graph is saved as a snapshot first", when it was not

**Found** in R189's round, on the same dialog. `snapshotSwarmVersion` swallowed its insert error
("versioning is best-effort; never block a save"). That is right for the autosave on Save, its
first caller, and wrong for the other two. Driven on the hot deploy of R189, on "Approval
durability check", with the `swarm_versions` insert refused from the browser:
- **Save version**, named "R190 refused capture": the toast said "Version saved", the name was
  cleared, and the list still held only the Initial version.
- **Restore.** The canvas had a Set Variable node added (6 nodes, unsaved). *Restore* on the
  Initial version opened a confirm: 'The canvas will be replaced with this snapshot (5 nodes). Your
  current graph is saved as a snapshot first, so you can restore back.' Confirmed with the insert
  refused, it gave "Version restored — hit Save to keep it." and 5 nodes. Reopened with the refusal
  lifted, the history had no *Before restore* version. The 6-node graph was gone, and pressing
  Save, as the toast asks, would have made that permanent.

**The fix** (`lib/swarmVersions.ts`, `components/swarms/SwarmVersionsDialog.tsx`,
`routes/_authenticated/swarms.tsx`):
- **`snapshotSwarmVersion`** resolves to the insert's error message, or null. It prunes only after
  a version landed. The autosave still ignores the result.
- **Save version** shows "The version was not saved" with the error, and keeps the name for another
  try.
- **Restore** does nothing when the snapshot of the current graph did not land: "Nothing was
  restored · Your current graph could not be saved as a version first, so the restore could not be
  undone: …". The handler returns whether it restored, and the dialog stays open when it did not.

**Driven after:**
- **Save version:** under the refusal, "The version was not saved · R190 injected: the POST did not
  reach the database", with the name still in the field. Lifted and renamed, "R190 capture after
  retry" landed ("Version saved"; kept).
- **Restore:** with the node added and the insert refused, "Nothing was restored …"; the canvas kept
  its 6 nodes and the dialog stayed open. Lifted, the restore went through (5 nodes, dialog closed).
  The history then opened on "Before restore 10:46:35 PM · pre-restore · 6 nodes" (kept).

### 2026-09-30 — "Draft ahead" gone after a Publish, and three lists that read as empty

Tests: `tests/unit/swarmCanvasReads.test.ts` (7 tests). The mutation run caught 15 of 15, and the
control survived.

#### R189 · S2 · The one warning that deployed runs lag the canvas, gone after a failed re-read

**Found** as Phase C's third item, the rest of the client read survey's swarms batch: four reads
on the canvas and its dialogs dropped their errors. Driven on the hot deploy of R188, with each
read refused from the browser:
- **The published snapshot.** After a Publish the canvas re-reads what is live, to compare it with
  the canvas for the *Draft ahead* badge on the toolbar's Deploy button. On "R109 chat echo" (2
  nodes, no keys or schedules), Publish with that re-read refused: the toast said "Published —
  deployed runs now use this version", the snapshot went to null, and a node added afterwards (3
  against 2) drew no badge. The control, reloaded and the same node added: "Draft ahead · The
  canvas has changes that deployed runs are not using yet". Until a reload, every later edit was
  shown as live.
- **My components**, in the palette and in the Component library. Neither said anything when the
  read failed. So that the empty state would prove something, a component was authored first ("R189
  fixture first 100 chars", kept). Then the component was saved as v2 with the read refused: the
  save went through ('Saved "R189 fixture first 100 chars" (v2)'). The library then read "No
  components yet. Author one and it shows up in the palette.", the palette "None yet — author a
  reusable node.", and the component's palette button was gone.
- **The version history.** On "Approval durability check", which normally lists "Initial version ·
  autosave · 5 nodes": "No versions yet — Save the swarm or capture one above."

The snapshot is the one with teeth. The badge exists because a canvas edit does not reach API and
scheduled callers until it is published, and a failed read switched the badge off while the canvas
went on changing.

**The fix** (`routes/_authenticated/swarms.tsx`, `components/swarms/ComponentLibraryDialog.tsx`,
`components/swarms/SwarmVersionsDialog.tsx`):
- **The snapshot re-read** keeps its error. The snapshot stays unknown: keeping the old one would
  call a canvas that was just published "ahead". The Deploy button says *Live not checked*, with
  the error in its title, and opening another swarm clears it. In the UI that path is only Import
  or deleting the open swarm; the gallery reloads the page.
- **The component and version reads** keep their errors. Each list says "… could not be read, so
  this list says nothing about them: …" in place of its empty state, and shows no stale items
  under it.
- **The palette** reads its components once, so its message has *Try again*.

**Driven after:**
- **Versions:** "The versions could not be read, so this list says nothing about them: R189
  injected: the GET did not reach the database"; lifted and reopened, the Initial version.
- **Components:** saved as v3 under the refusal, both lists named the error; lifted, the palette's
  Try again brought the component back, and the reopened library listed it at v3.
- **Snapshot:** a refused Publish gave "Live not checked", and it stayed that way with the extra
  node added. Lifted, a second Publish gave "Draft ahead" for the 3-node canvas against the saved 2.

**Left for R190**, from the same dialog: *Save version* toasts "Version saved" whether or not the
insert landed, since `snapshotSwarmVersion` swallows its error for the autosave's sake. And
*Restore*, promised as undoable ("your current graph is saved first"), replaces the canvas even
when that safety snapshot failed.

### 2026-09-30 — A live swarm read "Not deployed", with Add schedule on

Tests: `tests/unit/swarmDeployReads.test.ts` (5 tests). The mutation run caught 10 of 10, and the
control survived.

#### R188 · S2 · "No schedules yet.", beside a form that adds the schedule again

**Found** as Phase C's third item, the client read survey's swarms batch, starting with the
deploy dialog: it reads the swarm's API keys, its schedules and its own row (the published
snapshot), and dropped all three errors. Driven on the real image `498ec3b7ec48`, on "Approval
durability check" (published, pinned 9/23/2026, 1:37:47 AM; schedules "R95 heartbeat", "R92
one-run probe", "R91 park probe (after)" and more):
- The dialog normally: "Published · pinned 9/23/2026, 1:37:47 AM"; the Schedules tab lists them.
- The schedules read refused from the browser, the dialog reopened: "Not deployed · No API keys or
  schedules yet."; the Schedules tab "No schedules yet." with Add enabled.

Two things are wrong at once. The state is computed from `keys.length > 0 || schedules.length >
0`, so any list that failed to load made a live, pinned swarm read "Not deployed". And the
schedules list invites the one action that does damage: a schedule added again runs the swarm a
second time on every tick, each run paying for its models.

**The fix** (`components/swarms/SwarmDeployDialog.tsx`, `lib/swarmPublish.ts`). Each read keeps
its error, and a list whose read failed is shown empty only behind its error. The deployment state
gains `unknown`, "Deployment not read · What this swarm has deployed could not be read, so this
panel says nothing about it.", used whenever any of the three reads failed. The keys and schedules
say "… could not be read, so this list says nothing about them: …" in place of "No … yet.", and
Add is off while the schedules are unread, saying why.

**Driven after.** The same refusal: "Deployment not read"; the Schedules tab "The schedules could
not be read, so this list says nothing about them: R188 injected: the GET did not reach the
database. Adding one is off until they can be: an existing schedule would run the swarm twice.",
Add disabled. Lifted and reopened: "Published · pinned 9/23/2026, 1:37:47 AM".

### 2026-09-30 — A node restricted to one table, shown as having no tables at all

Tests: `tests/unit/nodeInspectorReads.test.ts` (5 tests). The mutation run caught 13 of 13, and
the control survived.

#### R187 · S2 · "No tables yet. Upload a CSV", over a node that may only see `ecom_returns`

**Found** as Phase C's second item, the client read survey's "swarm node inspector (4)". The
inspector reads the caller's connected providers, tables, semantic models, ML models and MCP
servers once, when it opens, six reads in one effect, and dropped every error. Driven on the hot
deploy of R186, on "Embed E2E Mini Swarm", nothing saved: the Researcher node's SQL Query tool
on, `ecom_returns` ticked, "Node will only see 1 selected table."; the inspector closed and
reopened with the tables read refused from the browser → "Allowed tables (optional) · No tables
yet. Upload a CSV in Data & SQL Agents." The node's restriction was gone from view, and the page
invited a first upload to an account with a whole catalogue of tables. A refused providers read
would have marked every connected provider "(not connected)".

**The fix** (`components/swarms/NodeInspector.tsx`). Each read keeps its error, by list. A picker
whose list was not read says "<Your tables> could not be read, so this list says nothing about
them: <error>." ahead of its empty-account invitation, and "The node keeps its selection: …" for
whatever the node has chosen. The MCP selection is still pruned only from a list that was read.
With the providers unread, no provider is marked "(not connected)", and a line under the picker
says why.

**Driven after.** The same drive: "Your tables could not be read, so this list says nothing about
them: R187 injected: the GET did not reach the database. The node keeps its selection:
ecom_returns."; with the providers read refused too, "Your connected providers could not be
read, so none is marked as not connected: …". A first build ran the error into the next sentence
("…the database The node keeps…"); the error now ends as a sentence.

### 2026-09-30 — Evaluations: five reads that failed into absence, two deletes that failed in silence

Tests: `tests/unit/evalReadsWrites.test.ts` (8 tests). The mutation run caught 14 of 14, and the
control survived.

#### R186 · S2 · "running · 0/2 · Executing cases…", with nothing executing

**Found** as Phase C's first item: evaluations' five error-less reads (the client read survey) and
two deletes (the write survey). Driven on the hot deploy of R185, on a dataset made for it, "r186
evals" (two cases, `hello one` and `hello two`), run against "R109 chat echo" with the
"Contains expected text" evaluator, so no model was called ($0). Each PostgREST call was refused
from the browser with a 500 carrying "R186 injected: the <METHOD> did not reach the database":
- The run's results read: "Progress 2/2 · Pass rate 100% … No results.", no error.
- The dataset's case read: "r186 evals · 0 cases", New eval run disabled, beside a runs list
  saying "r186 evals · 2/2".
- A case delete, confirmed: nothing said, "2 cases", the case still listed.
- The dataset delete, confirmed: nothing said, the dataset still listed.
- The driver's case read as a second run started: "running · 0/2 · Run remaining 2 · Executing
  cases…", and nothing executed.
- The baseline's results read under Compare against: "vs baseline: 0 improved · 0 regressed · 0
  unchanged", both cases `only_b` ("— → pass 1.00"): a comparison against nothing.

**The fix** (`routes/_authenticated/evaluations.tsx`). The case read keeps its error: the count
reads "cases not read", the list is empty under "The cases could not be read, so this list says
nothing about them: …" with Try again. The results read does the same in place of "No results.".
The driver stops before building its queue when either of its reads fails, with "The run could
not carry on · Its cases could not be read: …", and "Executing cases…" now shows only while the
driver runs; a running run with no driver says "No case is executing now. Run remaining carries
on." The baseline read draws no comparison when it fails, and says "The baseline's results could
not be read: …" beside the picker. Both deletes say so when refused, and the dataset delete stops
there. The page already had a `compareError` for the list of comparable runs (module 28); the
baseline's own state is `baselineError`.

**Driven after.** Each refusal again: the error text in place of "No results."; the baseline
error and no comparison; "cases not read" with Try again, which, the fault lifted, brought back
"2 cases"; "The case was not deleted · R186 injected: …" with the case kept; "\"r186 evals\" was
not deleted · …" with the dataset kept; a third run's driver: the toast and "No case is executing
now", then Run remaining → 2/2, 100%.

### 2026-09-30 — A failed materialized-view rebuild, told only to a hovering mouse

Tests: `tests/unit/matviewBadgeFailed.test.ts` (6 tests). The mutation run caught 11 of 11, and
the control survived.

#### R185 · S3 · "materialized", over rows whose source was gone

**Found** as Phase B's third item, left open by R101 at S3. Driven on the hot deploy of R184, in
the Lakehouse:
- Query: `CREATE TABLE analytics.r185_base AS SELECT 185 AS id, 'base row' AS note` → `Count 1`.
- `SELECT * FROM analytics.r185_base` → Save as view → `analytics` / `r185_mv` / manual → "Built
  analytics.r185_mv — 1 row(s)".
- `ALTER TABLE analytics.r185_base RENAME TO r185_base_moved`; the `r185_mv` tab → Rebuild → the
  toast "Rebuild failed: Catalog Error: Table with name r185_base does not exist!", gone in
  seconds; the badge still `materialized`, its hover title "Last rebuild failed: …".
- Reloaded and reopened: `analytics.r185_mv · 1 row(s) · … · materialized · Rebuild`, and no word
  of a failure anywhere on the tab.

The rebuild keeps the previous rows on purpose, and the server's comment gives the reason:
"stale data a user can see and diagnose beats no data at all". Nobody could see it, and a
scheduled rebuild has no toast at all.

**The fix** (`lib/matviewBadge.ts`, `lakehouse.tsx`). One function decides what the badge says.
A rebuild whose last status is `error` reads "last rebuild failed", in the destructive colour,
beside a line with the error's first line as a sentence and the time of the rebuild the rows are
from (`last_refreshed_at`, which a failure leaves alone), or that the view has never been built.
The whole error stays in the hover title.

**Driven after.** The tab: `last rebuild failed` · "Catalog Error: Table with name r185_base does
not exist! These rows are from the rebuild of 9/30/2026, 7:52:16 PM."; the base renamed back,
Rebuild → "Rebuilt — 1 row(s) in 3497 ms", the badge `materialized`, no failure text.

### 2026-09-30 — A workflow's "succeeded" over a step that could no longer succeed

Tests: `tests/unit/workflowBadgeDrift.test.ts` (9 tests). The mutation run caught 13 of 13, and
the control survived; a first run left one mutant alive, a filter on undefined keys that
JSON.stringify already makes, and the filter was removed as dead code.

#### R184 · S2 · succeeded, for `SELECT * FROM analytics.r184_no_such_table`

**Found** as Phase B's second item, sweep item 2's workflow saves. Driven on the hot deploy of
R183:
- Workflows → New workflow `r184_badge` → SQL statement step `SELECT 184 AS r184` → Save
  ("Saved") → Run now: the list reads `r184_badge · manual · less than a minute ago · succeeded`.
- The statement → `SELECT * FROM analytics.r184_no_such_table` → Save; reloaded, the step holds
  that statement and the list still reads `succeeded`.

A save writes the graph and none of the run stamps, so the status described a graph that no
longer existed, and here one that could not succeed.

**The fix** (`lib/workflowDrift.ts`, `workflows.functions.ts` `workflowsList`,
`workflows.tsx`). Each run pins its graph on `workflow_runs.graph`. The list reads each
workflow's latest run, the one its status is about (a run writes "running" when it starts and
its outcome when it ends), and compares the graphs as a run executes them: a step's position
and label left out, and a parameter's description, with steps, arrows and parameters in one
order and every object's keys sorted, since Postgres stores `jsonb` in its own key order. When
they differ, the row says "changed since this run" under the name. With no run, or a read that
failed, it says nothing.

**Driven after.** The row marked; Run now → `failed` (the missing table), unmarked; the step
dragged up the canvas and saved, its new position stored → still unmarked; the statement set
back to `SELECT 184 AS r184` → "changed since this run" over `failed`. The two other workflows
stayed unmarked throughout.

### 2026-09-30 — An ETL pipeline's "Succeeded" over a definition that never ran

Tests: `tests/unit/etlChipDrift.test.ts` (11 tests), on the real compiler and the real
reconciliation sample. The mutation run caught 11 of 11, and the control survived.

#### R183 · S2 · Succeeded, for a table the pipeline had never written

**Found** as Phase B's first item, sweep item 2 (a badge that outlives what it vouched for), next
in line after R101. Driven on the real image `8651672bd6c6`:
- ETL Pipelines → New pipeline → `r183_chip` from "Orders ↔ payments reconciliation" → Settings:
  default destination "MinIO local etl demo" → Save → Run now → the run `Succeeded`, `309 rows →
  2 target(s)`.
- Build → the "Reconciled" target → Table `orders_reconciled` → `orders_reconciled_r183` →
  "Saved".
- ETL Pipelines: `r183_chip · last run 9/30/2026, 7:00:02 PM · 100% · Succeeded`. No run had
  written `orders_reconciled_r183`.

The save writes the definition and none of the run stamps, and the card showed
`last_run_status` as though it were about the pipeline on the row. A visual pipeline is also
recompiled by the current compiler at every run start, so an upgrade changes what runs next
with no edit at all, and the chip says nothing about that either.

**The fix** (`utils/etl/runDrift.ts`, `etl.functions.ts` `getEtlOverview`, `etl.tsx`). Each
run already pins the program it ran on `etl_runs.source_code`. The overview reads each
pipeline's latest finished run, the one that wrote the status, and compares its program with
the one a run started now would execute: the graph compiled by the current compiler for the
pipeline's engine, as the run start does, or a code pipeline's own source. When they differ, or
the graph no longer compiles, the card says "changed since this run" under the chip. With no
finished run, or a read that failed, it says nothing. The definition is read for this and left
out of the answer. No migration: R60 needed a trigger because a SQL model's build does not pin
its SQL, and an ETL run does.

**Also seen.** The first load after the fix marked five older pipelines: `matrix_transforms`,
`param_probe2`, `revenue_conform`, `kafka orders` and `sample_reconciliation`, last run between
8/30 and 9/18. None had been edited: the current compiler builds their graphs differently, so
their next run executes something their chips never checked. The fifteen others, including
`bi_seed` (9/22) and the 9/18 `*_live` pipelines, compile to what they last ran, which is also
the evidence the compiler is deterministic.

### 2026-09-30 — An Iceberg replace left the name empty, then empty-handed

Tests: `tests/unit/icebergReplaceInPlace.test.ts` (6 tests) and a rewritten
`tests/unit/icebergReplaceStaged.test.ts` (R107's cases, now over the swap), with
`iceberg.test.ts` and `icebergPublishColumns.test.ts` updated. The mutation run caught 22 of 22,
and the control survived; a first run missed a failed swap that also claimed the table "is as it
was", and the test now requires that claim to be absent.

#### R182 · S2 · No table for 0.9 s, then an empty one for 1.7 s

**Found** as Phase A's fourth item, queued by R107: "the swap is not atomic". Measured on the hot
deploy of R181, from the catalog's own log, since a poller loading the table starves the
development catalog's SQLite writer (R181). Lakehouse → `analytics.stg_revenue` → Publish to
Iceberg → `local_rest` / `r181` / `swap_target`, Replace it (drop, then create) → "Published 836
row(s)", and in the catalog:
- 13:54:39.456 `Dropped table: r181.swap_target`
- 13:54:40.375 `swap_target` committed: created, empty
- 13:54:42.076 `swap_target` committed: filled

A reader of the catalog found no table for 0.9 s and then an empty one for 1.7 s. A dashboard,
a Spark job or a mount reading at that moment sees a missing table or zero rows, and nothing
says the publish was still going.

**The fix** (`utils/lakehouse/iceberg.ts`, `iceberg.server.ts`, the dialog's label). Two paths,
chosen by the old table's columns as the engine reads them (`DESCRIBE`):
- The same names, order and types as the new data: `BEGIN; DELETE FROM t; INSERT INTO t …;
  COMMIT`. Driven: the catalog logged one commit (14:26:00.608) carrying a delete snapshot and an
  append snapshot, and no rename or drop. The table's current state went from the old rows to the
  new ones in that commit. A failed write rolls back and says the table keeps its old rows.
- Anything else, or no table yet: the new data is staged as before, then `BEGIN; ALTER TABLE IF
  EXISTS t RENAME TO t__replaced_<token>; ALTER TABLE staging RENAME TO t; COMMIT`, and the old
  table is dropped last. Driven twice: the renames landed 1.46 s apart (14:17:19.107 and
  20.571) and 0.39 s apart (14:31:32.219 and 32.613). The catalog applies them one after the
  other, so a reader can miss the table for that moment, but never finds it empty, and the new
  data is written once instead of twice. The extension accepts both renames in one transaction
  and checks a clash before sending either (probed). A swap that fails anyway rolls back, renames
  the old table back if it had moved, removes the staging table, and names where the old table is
  if it could not be put back.

**Not changed.** The REST catalog has no call that renames two tables at once, so a replace that
changes the columns keeps a short gap. The old rows of an in-place replace stay in the table's
history until the catalog expires its snapshots. The label now reads "Replace it (swap the new
table in)".

### 2026-09-30 — Every publish to Iceberg failed on a freshly built image

Tests: `tests/unit/icebergPublishColumns.test.ts` (6 tests), with `tests/unit/iceberg.test.ts` and
`tests/unit/icebergReplaceStaged.test.ts` updated to the new statements. The mutation run caught
13 of 13, and the control survived.

#### R181 · S2 · `Failed to create directory "data"`, on every publish

**Found** while preparing Phase A's fourth item, the replace's swap: the before-drive needed a
publish, and none worked. On image `817a8048bbf0`, built that afternoon with R178 to R180:
- Lakehouse → `analytics.stg_revenue` (836 rows) → Publish to Iceberg → `local_rest` / `r181` /
  `swap_target`, Refuse → `IO Error: Failed to create directory "data": Permission denied`. The
  catalog's log shows one lookup of `r181.swap_target` (404) and nothing else.
- The same into `local_rest` / `r107` / `r181_probe` → the same error. `r107` was made by this app
  in R107, where this path published; `r181` had been made over the REST API for a probe. The
  namespace was not the cause.

DuckDB (`@duckdb/node-api` 1.5.5-r.2) and the code around the publish had not changed since R107
published successfully on 2026-09-24. The iceberg extension had: an image bakes the build that
`INSTALL iceberg` fetches when it is built. Probed in the container with that build (45163a28)
and no storage credentials, so a write aimed at the right place answers S3's 403:
- A fresh connection, attached exactly as the app attaches `local_rest`: `CREATE TABLE … AS
  SELECT 1` → 403 on `s3://iceberg/r181/local_ctas/data/…`, the right place.
- The same after `LOAD ducklake` (not even attached), after attaching a DuckLake, after `USE
  lake`, after `USE memory`: `Failed to create directory "data"`.
- `CREATE TABLE … (id INTEGER)` then `INSERT`, with ducklake loaded, attached or in use: 403 on
  the table's own `s3://` location.
- `CREATE TABLE … AS … WITH NO DATA` and `… LIMIT 0`: the `data` error again.

This engine loads ducklake at boot and uses it on every connection, so every publish met it.

**The fix** (`utils/lakehouse/iceberg.ts`, `iceberg.server.ts`). A publish reads the source's
columns in order (`duckdb_columns()`, database `lake`), then creates the table with that column
list and inserts its rows by name. A replace does the same into its staging table, and again into
the old name after the drop. Types behave as before: checked on the extension one by one,
`UTINYINT`, `UBIGINT`, `ENUM` and `INTERVAL` are refused by the explicit create with the same
"not a valid Iceberg Type", and `HUGEINT`, `MAP`, `TIMESTAMPTZ`, lists, structs, `DECIMAL`,
`BLOB`, `UUID`, `TIME`, `DATE`, `DOUBLE` and `BOOLEAN` are accepted. A CREATE TABLE AS failed as
one statement and left nothing behind; this publish is two, so a create whose insert fails drops
the table it has just made. It can only be its own: a create refuses an existing name, and a
refused create drops nothing.

**Not changed.** The replace still drops the old table before the copy into its name (R182). The
drive also met the development catalog's `SQLITE_BUSY`: while a poller loaded the table 4 to 30
times a second, every commit into a replace's staging table was refused, and the old table stood
each time. The first attempt left its staging table, `swap_target__publishing_fe36c8e4`, because
its cleanup met the same lock. With the poller stopped the replace went through. That is the
fixture's SQLite store; the queue has it.

### 2026-09-30 — A swarm chat turn saved into the conversation on screen, not its own

Tests: `tests/unit/swarmChatTurnBinding.test.ts` (6 tests). The mutation run caught 15 of 15, and
the control survived.

#### R180 · S1 · Switching conversations mid-turn wrote one conversation over another

**Found** as Phase A's third item, left open by R109's entry in the queue: "the aborted turn's save
follows whichever conversation is selected when it lands". Driven on the hot deploy of R179, in
Chat on "Embed E2E Mini Swarm" (Researcher → Editor):
- "R180 turn one: name one planet in a single word." → a reply; the list holds one conversation,
  A.
- In A, "R180 turn two: and one moon?", and New chat a second later. The list then held two
  conversations titled "R180 turn one: …", the new one highlighted, over an empty screen that
  said "Run failed: signal is aborted without reason". The aborted turn had inserted a copy of A
  with turn two in it, and bound the empty screen to that copy.
- From that screen, "R180 in a new chat: name one star." → a reply, and still two conversations:
  the send wrote over the copy. Turn two was then nowhere; A held turn one and its reply.
- Reopening does the same. In A, "R180 turn four: and one asteroid?", the dialog closed a second
  later and reopened: a third "R180 turn one: …" conversation, highlighted over an empty screen
  with the same error. The comment above the dialog's effect said a turn survives closing and
  "reopening shows the reply"; reopening aborted it.
- Switching is the one that loses data. A turn inside a call that takes no abort signal runs on
  after the switch: an HTTP, tool or retrieve node calls a server function, and the run notices
  the abort only between nodes. To hold the turn inside such a call, the browser's `/api/chat`
  request was made to ignore the signal. In A, "R180 turn three: and one comet?", then the
  conversation "R180 in a new chat" (C) a second later: C opened with its own two messages. Ten
  seconds later C's list title read "R180 turn one: …", and C, reopened, held A's turn one, A's
  reply and "R180 turn three". C's own exchange was gone.

The turn saved with `chatIdRef.current`, the conversation on screen when it ended, and it reset
`running`, the live text and the Stop button's controller of whatever screen was there then.

**The fix** (`components/swarms/SwarmChatDialog.tsx`). The screen has a number that goes up
whenever the conversation on it changes: New chat, a switch, a reopen that starts afresh. A turn
takes that number, its conversation's id and its swarm when it starts. If the number has moved by
the time it ends, it saves into its own conversation (the user's message alone if it failed, with
the reply if it finished) and changes nothing on screen; a save that fails there is a toast naming
the conversation. A switch aborts the turn only after the conversation to go to has been read, so
a switch whose read fails (R109's "You are still in the conversation you had open") no longer
kills the turn it leaves you with. Reopening the dialog while this swarm's turn is running shows
that turn instead of aborting it.

**Not changed.** Leaving a conversation still ends its turn; closing the dialog still does not.
A turn in a call that takes no abort signal still runs to the end of that call before it stops,
and it bills that call.

### 2026-09-30 — A run parked at an approval could not be cancelled

Tests: `tests/unit/swarmParkedCancel.test.ts` (8 tests), with `tests/unit/recentRunsParked.test.ts`
and `tests/unit/swarmParkedRunWrites.test.ts` updated. R90's pin, that the resume never gates on
the word `suspended`, read the whole file, and the cancel requires that word on purpose; the pin now
reads the resume alone, and still fails when R90's gate is put back. The mutation run caught 20 of
20, and the control survived.

#### R179 · S2 · Thirty-five parked runs, and nothing on the page could stop one

**Found** as Phase A's second item, left open by R108's entry in the queue. The scheduled
"Approval durability check" swarm parks a run at its approval node each time it fires. Driven on
the hot deploy of R178:
- Swarms → Recent runs: rows `Approval durability check (schedule) · Awaiting approval · started
  12h ago`, and more back to `4d ago`, each with Open, Trace and Review approval, and no Cancel.
- The header: "Cancel a running run here; a run waiting for an approval goes on or stops when the
  approval is decided."
- The bell: `Pending approvals (35)`.

A decision on the approval was the only way to end one. Approving runs the rest of the swarm;
rejecting ends the run as an error, "Rejected at human-approval step", recorded as a rejection
of content nobody reviewed. `resumeApprovedSwarmRun` also stopped only for `success` and `error`,
so a decision that landed after any other kind of stop would still have resumed the run. And
Recent runs dropped the error of its `swarm_runs` read and showed `data ?? []`, so a failed load
read as "No runs yet" over runs that were parked and waiting (the R63 shape; read from the source,
then driven after the fix).

**The fix** (`utils/swarmResume.functions.ts`, `lib/swarmRunStatus.ts`,
`components/swarms/RecentRunsPanel.tsx`). A new server function, `cancelParkedSwarmRun`, reads the
run under the caller's session, so row-level security decides whose it is, and requires
`suspended`. It ends the run with an update that holds only while the run is still `suspended`:
a resume that got there first wins, and the caller is told to refresh. Then it removes the
checkpoint, closes the run's pending approvals as `cancelled`, and records `swarm_run.cancel` in
the audit log. If an approval cannot be closed it says so; deciding that approval later does not
resume the run, because `resumeApprovedSwarmRun` now refuses a `cancelled` run before it looks for
a checkpoint. Every parked view carries `parked: true`, and Recent runs offers Cancel on those
rows beside Review approval. A failed read of the runs shows its message and Try again.

**Not changed.** A run cancelled after twelve hours parked shows `12h 19m` as its duration on Recent
runs, while Observability shows `0ms`: queued. A run parked in another tab's memory (`waiting`)
is still cancelled through the `cancel_requested` flag. Rejecting still ends a run as an error,
which is what a rejection means.

### 2026-09-30 — A SQL model's build replaced a table made after the model was saved

Tests: `tests/unit/sqlModelTargetMark.test.ts` (12 tests); its catalog half runs on a real DuckLake
when the extension loads. The mutation run caught 15 of 15, and the control survived.

#### R178 · S1 · Built 1 model, over a table nobody asked it to replace

**Found** as Phase A's first item: the case R103's entry in the queue left open. R103 made a new
or renamed model find its name free when it is saved, and R128 refused a table a sheet holds.
Nothing stopped a table made at the target after the save. Driven on the image of R177:
- SQL Models → New model `r178_target`, schema `analytics`, stored as Table, `SELECT 178 AS id` →
  Create: "Created r178_target", not built.
- Lakehouse → `CREATE TABLE analytics.r178_target AS SELECT 'made after the model was saved' AS
  note` → `Count 1`.
- The model → Build this and what it reads → "Built 1 model".
- `SELECT * FROM analytics.r178_target` → `id 178`. The table and its row were gone, and nothing
  on either page said so.

The same happens with any way of making a table at that name: an import, a CSV upload, a view saved
over it. A build on a schedule does it with nobody watching, and a model whose materialization
changes also runs `DROP <other shape> IF EXISTS`, which dropped someone's view the same way.

**The fix** (`utils/sqlModels/target.server.ts`, `run.server.ts`). Each build marks what it made
with `COMMENT ON TABLE|VIEW … IS 'agentswarms: built by SQL model <id>'`, right after the `CREATE`.
DuckLake keeps the comment in its catalog (`ducklake_tag`), and `CREATE OR REPLACE` drops it, so
every build writes it again. Before touching its target, a build reads what stands there
(`duckdb_tables()` and `duckdb_views()`, without case) and goes ahead only if nothing does, or its
own mark does. An object with no comment still counts as the model's, after a successful last
build, if DuckLake's catalog began it no later than that build, or if the snapshot that began it
has been expired: that is how a table built before marks looks. Anything else, including an object
whose age cannot be read, is refused with its name and the way out. The check sits before the
other-shape `DROP`, so a view is covered too.

**Found in this round's own "after" drive.** The first version read an object's age by joining
its catalog row to `ducklake_snapshot`, and refused when that found nothing. Build all then refused
`stg_revenue`, a model's own table, and skipped `fct_region_revenue` after it. The catalog showed
why: lakehouse maintenance expires snapshots older than a week (the oldest kept was from
2026-09-24), so every table older than that has no snapshot row at all. Each unmarked model table
past a week old, which is nearly every existing model, would have been refused. An expired
snapshot now means "older than the kept history", which is a date the rule can use; a local
DuckLake test expires snapshots and checks that the mark survives.

**Not changed.** A model whose last build failed, and whose table was built before marks, is
refused until it is renamed or its table dropped: the failed build moved its clock, and the rule
does not guess. A comment someone sets on the model's table by hand removes the mark. One case
the transition cannot see: a model's table dropped and a different table made at its name more
than a week ago, before marks, with the model not rebuilt since; that table would be taken as the
model's.

### 2026-09-30 — CUMIPMT, CUMPRINC and six more financial functions

Tests: `tests/unit/sheetsFinancial.test.ts` (5 tests), Microsoft's worked examples. The mutation run
caught 12 of 12, and the control survived.

#### R177 · S3 · A loan sheet's CUMIPMT was #NAME?

**Found** probing the financial functions against Microsoft's examples. PMT, FV, PV, NPER, RATE,
IPMT, PPMT, IRR, NPV, XNPV, XIRR, SLN, DDB, DB, EFFECT and NOMINAL all matched; CUMIPMT, CUMPRINC,
MIRR, FVSCHEDULE, SYD, ISPMT, PDURATION and RRI were #NAME?, though formula.js has every one. Driven
in "R177 loans before": A1 `=CUMIPMT(0.09/12,360,125000,13,24,0)`, A2 the same CUMPRINC, A3
`=MIRR({-120000,39000,30000,21000,37000,46000},0.1,0.12)`, A4 `=PDURATION(0.025,2000,2200)`:
#NAME? ×4.

CUMIPMT and CUMPRINC are how an amortization sheet totals a year's interest and principal; an Excel
file using them came in showing only the values Excel saved, and stopped following its inputs.

**The fix** (`lib/sheets/formula/functions.ts`, `xlsx.ts`, `functionHelp.ts`). The eight are
registered. MIRR reads its values as IRR does (R170), skipping blanks and text where formula.js
counted a blank as a period of 0; FVSCHEDULE counts a blank rate as none, as Excel does. PDURATION
and RRI, Excel 2013's, carry the `_xlfn.` prefix in a download (R172's test found them bare and
failed, as it is meant to). Autocomplete describes CUMIPMT, CUMPRINC and MIRR.

**Not changed.** VDB is not in formula.js and is still #NAME?. About 170 more of formula.js's
functions (MMULT, AVERAGEA, TRIMMEAN, the database functions, distributions, complex numbers) are
not registered; each needs checking against Excel before it is, as R170 showed.

### 2026-09-30 — FLOOR to a decimal step, GCD, LCM and hexadecimal

Tests: `tests/unit/sheetsMultiples.test.ts` (7 tests), the table-sheet cases on a real DuckDB. The
mutation run caught 16 of 16, and the control survived.

#### R176 · S2 · FLOOR(4.35,0.05) was 4.3

**Found** probing the math functions against Excel's rules. Driven in "R176 math before": A1
`=FLOOR(0.3,0.1)`, A2 `=FLOOR(4.35,0.05)`, A3 `=FLOOR(2.5,-2)`, A4 `=CEILING(2.5,-2)`, A5
`=GCD(12.5,5)`, A6 `=LCM(4.9,6.2)`, A7 `=DEC2HEX(255)`, A8 `=HEX2BIN("F")`.
- A1 was 0.2 and A2 4.3, where Excel gives 0.3 and 4.35: 0.3 / 0.1 is 2.9999999999999996, and
  FLOOR took the whole number below it. FLOOR.MATH did the same, and a table sheet's FLOOR column,
  compiled to SQL, too.
- A3 was 4 and A4 2; Excel gives #NUM! for a positive number with a negative step.
- A5 was 2.5 and A6 30.38; Excel truncates to whole numbers (1 and 12), and `=GCD(-4,6)` is #NUM!
  there, 2 here.
- A7 was `ff` (Excel `FF`), and A8 #NAME?: DEC2OCT, OCT2DEC, OCT2BIN, OCT2HEX, BIN2OCT, BIN2HEX,
  HEX2BIN and HEX2OCT were not registered, though formula.js has them.

FLOOR to a step is how prices round down to a nickel or a cent, so a wrong one is a wrong price.

**The fix** (`lib/sheets/formula/functions.ts`, `sql/compile.ts`). CEILING, FLOOR, CEILING.MATH and
FLOOR.MATH divide, snap a quotient within float noise of a whole number to it, round to the step and
drop the step's own noise (3 × 0.1 is 0.3); CEILING and FLOOR give #NUM! for a positive number with
a negative step; the .MATH forms ignore the step's sign and turn only negative numbers by their
mode. The SQL form rounds the quotient to 9 places before `floor`/`ceil`. GCD and LCM truncate, and a
negative is #NUM!. DEC2HEX, BIN2HEX, OCT2HEX and BASE write capitals, and the eight missing
conversions are registered.

### 2026-09-30 — A number turned into text kept 10 digits

Tests: `tests/unit/sheetsNumberText.test.ts` (7 tests). The mutation run caught 12 of 12, and the
control survived. One mutant was taken out with the code it tested: an exponent padded to two
digits, which never happens in the ranges that are written in scientific notation.

#### R175 · S2 · =A1&"-"&B1 over 123456789012 gave "1.23457E+11-…"

**Found** probing the text functions against Excel's answers. Driven in "R175 text before": A1
`123456789012`, B1 `1234567.891234`, C1 `'123456789012` (typed as text), D1 `found`; E1
`=A1&"-"&B1`, E2 `=LEN(A1)`, E3 `=VLOOKUP(A1&"",C1:D1,2,FALSE)`, E4 `=DOLLAR(-1234.567)`.
- E1 was `1.23457E+11-1234567.891` where Excel gives `123456789012-1234567.891234`, E2 11 (Excel
  12), E3 #N/A (Excel `found`), and `=LEN(1/3)` 12 (Excel 17).
- A formula turned a number into text with the cell's General display, which is narrow on purpose
  (11 digits, 10 significant). Excel's conversion keeps 15 significant digits.
- E4 was `$(1,234.57)`; Excel's DOLLAR writes `($1,234.57)`.

A key built by joining numbers (an account and a line, a date and an ID) lost digits, so lookups on
it failed or, worse, matched a different key that rounded the same way.

**The fix** (`lib/sheets/formula/values.ts`, `functions.ts`). `numberText` writes a number as a
formula's text: rounded to 15 significant digits, whole numbers in full below 1E+15, scientific from
there and under 1E-9, with no trailing zeros. `toText` uses it; the cell's General display is
unchanged. DOLLAR formats the amount and brackets a negative outside the sign.

**Not changed.** Between 1E-9 and 1E-5, Excel may write some long fractions in scientific notation
where Sheets writes them out; that was not checked against Excel. A table sheet's formulas turn
numbers into text in the lakehouse, which has its own rules.

### 2026-09-30 — WEEKDAY's return types 11 to 17, and DAYS360

Tests: `tests/unit/sheetsDays360.test.ts` (6 tests). The mutation run caught 11 of 11, and the
control survived.

#### R174 · S3 · WEEKDAY(d,11) was #NUM!, DAYS360 #NAME?

**Found** in R173's probe; driven in the same workbooks (C4 `=WEEKDAY(B1,11)`, C5
`=DAYS360(DATE(2011,1,1),DATE(2011,12,31))`): #NUM! and #NAME?, where Excel gives 1 and 360.
- WEEKDAY knew return types 1 to 3; Excel's 11 to 17 number the week from Monday (11) through
  Sunday (17).
- DAYS360, the 360-day count that interest and payroll schedules use, did not exist.

**The fix** (`lib/sheets/formula/functions.ts`, `functionHelp.ts`). WEEKDAY takes 11 to 17. DAYS360
counts `(years × 360) + (months × 30) + days`, the US (NASD) way: a start on the 31st or on the last
day of February counts as the 30th, and an end on the 31st counts as the 30th when the start is the
30th or 31st; with TRUE, the European way: every 31st counts as the 30th. The cases are
Microsoft's examples and the edges of each rule. It lifts over arrays, and autocomplete describes it.

### 2026-09-30 — Working days counted backwards

Tests: `tests/unit/sheetsNetworkdays.test.ts` (4 tests). The mutation run caught 6 of 6, and the
control survived.

#### R173 · S2 · NETWORKDAYS from a later date gave the calendar days between

**Found** probing the date functions against answers worked out by hand. Driven in "R173 dates
before": A1 `2024-01-12` (a Friday), B1 `2024-01-08` (a Monday); C1 `=NETWORKDAYS(A1,B1)`, C2
`=NETWORKDAYS(B1,A1)`, C3 `=NETWORKDAYS(DATE(2024,12,31),DATE(2024,1,1))`.
- C1 was -3 where Excel gives -5, and C3 -364 where Excel gives -262; forwards (C2) was right, 5.
  formula.js counts only forwards: given a later start, its count of days is negative, its loop over
  them never runs, and it returns the calendar days between the dates, weekends and holidays
  included.
- It also counted a start later in the day than the end (`2024-01-12 18:00` to `2024-01-12`) as no
  day at all, and turned an error in a date into #VALUE!.

A negative count of working days is how a schedule shows lateness, so the wrong ones read as plausible.

**The fix** (`lib/sheets/formula/functions.ts`). NETWORKDAYS and NETWORKDAYS.INTL read their two
dates here: an error passes through, times are dropped, and a later start counts forwards from the
end and negates, with the same weekend and holidays.

### 2026-09-30 — Three newer functions went into a download without Excel's prefix

Tests: `tests/unit/sheetsFilePrefixes.test.ts` (3 tests), against
`tests/fixtures/sheets/excel-future-functions.txt`, XlsxWriter 3.2.9's list, from
`make_excel_future_functions.py`. The mutation run caught 7 of 7, and the control survived.

#### R172 · S3 · NUMBERVALUE, ISFORMULA and FORMULATEXT went out bare

**Found** in R171's probe, comparing the download's prefix list with XlsxWriter's list of the
functions Excel stores as `_xlfn.NAME`, for the functions the engine computes. Driven in "R172
prefixes before": A1 `=NUMBERVALUE("1.234,5",",",".")`, A2 `=ISFORMULA(A1)`, A3
`=FORMULATEXT(A1)`; File → Download as Excel.
- The file held `NUMBERVALUE(…)`, `ISFORMULA(A1)` and `FORMULATEXT(A1)` bare. Excel reads a bare
  newer name as an unknown function, and a download asks Excel to recalculate on open, so the three
  cells would show #NAME? there, though Sheets showed 1234.5, TRUE and the formula.

**The fix** (`lib/sheets/xlsx.ts`). The three are in the prefix list. The test reads XlsxWriter's
list and requires the prefix for every function in it that the engine computes, and none for older
ones (SUM, VLOOKUP, NETWORKDAYS.INTL), so a function added to the engine later cannot go out bare
without the test failing.

### 2026-09-30 — The spill reference, A2#

Tests: `tests/unit/sheetsSpillRef.test.ts` (11 tests), and `tests/fixtures/sheets/xlsxwriter-spillref.xlsx`
from `make_xlsxwriter_spillref.py`. The mutation run caught 14 of 14, and the control survived.

#### R171 · S2 · =SUM(A1#) was #NAME?, and a file's ANCHORARRAY an unknown function

**Found** checking which newer functions a download prefixes for Excel (`_xlfn.`), against
XlsxWriter's list: its ANCHORARRAY is how a file holds Excel 365's `A1#`, and the probe found the
engine had no `A1#` at all. Driven in "R171 spill before": A1 `=SEQUENCE(3)` (spilling 1, 2, 3);
C1 `=SUM(A1#)`, C2 `=ROWS(A1#)`, C3 `=XLOOKUP(2,A1#,E1#)`; E1 `=A1#*10`.
- All four were #NAME?, "Unknown error value": the lexer read `#` as the start of an error value.
- An Excel 365 file that uses `A1#` holds `_xlfn.ANCHORARRAY(A1)`; it came in as `ANCHORARRAY(A1)`,
  an unknown function, and showed only Excel's saved value.

`A1#` is how Excel 365 formulas read a spilled list (a UNIQUE, a FILTER, a SEQUENCE) without
knowing its length, so a workbook built around dynamic arrays leans on it throughout.

**The fix.**
- The lexer gives a `#` straight after a cell a token of its own (`lexer.ts`), so every rewrite that
  moves the cell (copy, fill, insert and delete rows, Insert cells, a sheet rename) keeps it
  untouched. The parser marks the cell `spill`.
- The evaluator reads a spill cell as the range from the anchor to the far corner of its array
  (`env.spillRange`), as a value and as the reference ROWS, INDEX, OFFSET and COUNTIF take.
- The engine answers from the anchor's array and records a dependency on the anchor alone: a spill
  changes only when its formula does, so a growing spill reaches `=SUM(A1#)`. #REF! when the cell
  holds no spilled array (a value, a one-cell answer, a blocked spill); #CYCLE! when the spill
  depends on the formula reading it.
- A download writes `_xlfn.ANCHORARRAY(A1)`, and an import reads it back as `A1#`, with sheet names
  quoted or not. A plain (pre-dynamic) formula from a file takes one value of a spill where older
  Excel would, as it does of a range (R162).

**Not changed.** Clicking a spilled range while typing a formula inserts `A1:A3`, not `A1#`, and a
one-cell array answer (`=SEQUENCE(1)`) counts as not spilling; Excel's handling of that case was not
checked. One mutant was left out as equivalent: a formula reading its own spill is #CYCLE! with or
without the early check, which is there so that no cell records a dependency on itself.

### 2026-09-30 — The long-tail functions read a range as Excel does

Tests: `tests/unit/sheetsLibraryArgs.test.ts` (10 tests). The mutation run caught 23 of 23, and
the control survived.

#### R170 · S2 · A blank cell counted as 0 in GEOMEAN, SMALL, PERCENTILE, NPV, CORREL and SLOPE

**Found** by probing the engine for the queue's "a dynamic array over an empty cell spills a blank"
(that one was already fixed: it spills 0). The probe gave a range with a blank cell to the functions
that come from formula.js, and several answered as if the blank were 0. Driven in "R170 stats
before": A1 1, A2 blank, A3 3, A4 `x`; B1:B3 2, 4, 6.
- `=GEOMEAN(A1:A3)` was 0 (Excel 1.73), `=SMALL(A1:A3,2)` 1 (Excel 3), `=PERCENTILE(A1:A3,0.5)`
  1 (Excel 2).
- `=NPV(0.1,A1:A3)` was 3.163: it discounted the blank as a period of 0 and the 3 over three
  years. Excel skips the blank: 3.388.
- `=CORREL(A1:A3,B1:B3)` was 0.655 and `=SLOPE(B1:B3,A1:A3)` 0.857: the blank was paired with 4.
  Excel leaves the row out: 1 and 2.
- `=SUMSQ(A1:A4)` was #VALUE! over the text in A4 (Excel 10), and `=RANK(4,A1:A3)`, a number not
  in the list, was 0 (Excel #N/A).
- `=VSTACK("Name",A1:A3)` was #VALUE!, and so were TAKE, CHOOSECOLS and LARGE given one cell.

These are silent wrong numbers: nothing on the cell says the answer is off. The functions the file
writes itself (SUM, AVERAGE, MEDIAN…) read ranges Excel's way; the ones handed to formula.js got the
range as it stood, blanks as nulls.

**The fix** (`lib/sheets/formula/functions.ts`, `LIBRARY_ARGS`). Each formula.js function that reads
a range is told how, and its arguments are read before formula.js sees them:
- lists of numbers (SUMSQ, STDEV, VAR, GEOMEAN, HARMEAN, AVEDEV, DEVSQ, KURT, SKEW, MODE, LARGE,
  SMALL, PERCENTILE, QUARTILE, IRR, RANK's list, NPV's values) as SUM reads them: from a reference
  only numbers count; a value typed into the call is coerced;
- STDEVA with text as 0 and TRUE as 1, blanks still skipped;
- two lists side by side (CORREL, COVARIANCE, SLOPE, INTERCEPT, RSQ, FORECAST), dropping a row where
  either is not a number, #N/A when their sizes differ, and an error in either passed on;
- arrays (VSTACK, HSTACK, TAKE, DROP, CHOOSECOLS, CHOOSEROWS): one value is a one-cell array;
- a RANK of 0 (not in the list) is #N/A.

The table is keyed by formula.js's names. The older names (STDEV, VAR, MODE, PERCENTILE, QUARTILE,
RANK, FORECAST.LINEAR) are aliases of the new ones, which a first version of the table missed: its
entries for them never ran, and the mutation run showed it.

**Not changed.** TREND, GROWTH, XNPV and XIRR are handed their ranges as before; a blank among
TREND's known x values still counts as 0. A list with no numbers at all is an error, though not
always Excel's code (`=GEOMEAN(A2)` is #VALUE!, Excel's #NUM!).

### 2026-09-30 — Inserted rows and columns take their neighbours' formats

Tests: `tests/unit/sheetsInsertFormats.test.ts` (10 tests). The mutation run caught 11 of 11, and
the control survived. One mutant was left out as equivalent: with a deletion's negative count the
copying loop never runs, so its early return only saves the pass over the cells.

#### R169 · S3 · A row inserted into a formatted table arrived plain

**Found** from the queue (open since R117), then driven in "R169 insert before", imported from an
openpyxl file: a header row bold on blue, B2:B3 dollars with a border under B2. Insert 1 row below
row 2, and type 12.5 in the new B3.
- The new row was plain: 12.5 showed as 12.5 beside $10.00 and $4.00, with no border. Excel's
  default Insert Options format a new row like the one above it.
- Insert cells (shift down) left the new cell plain in the same way.

**The fix** (`lib/sheets/insertFormats.ts`, called by both shifts). New rows take the number format
and style of the row above; new columns, of the column to the left; at the top or left edge, of the
row below or the column to the right. Insert cells formats the new cells from the cells above (shift
down) or to the left (shift right), within the block's own columns or rows. A value, a note, a link
and a saved value never come across, and each new cell gets its own copy of the style.

**Not changed, on purpose.** Row heights and merges do not come across, and there is no Insert
Options button to choose "Same As Below" or "Clear Formatting" after the fact; Ctrl+Z and Clear
formats do that.

### 2026-09-30 — A formula's format from what it reads

Tests: `tests/unit/sheetsFormulaFormat.test.ts` (6 tests). The mutation run caught 10 of 10, and
the control survived.

#### R168 · S3 · =A1+30 over a date showed 45030

**Found** in R166's round, then typed in "R168 formats before": A1 2023-03-15, A2 `=A1+30`, A3
`=A2-A1`, A4 `=A1`; B1 $1,200, B2 $300.50, B3 `=SUM(B1:B2)`, B4 `=B1*2`.
- A2 showed 45030 and A4 45000, where Excel shows 2023-04-14 and 2023-03-15: a formula took no
  format from the cells it read. Only DATE, TODAY and their kin showed as dates.
- B3 showed 1500.5, where Excel shows it in B1's dollars. (Typed `$1,200` has no cents, so B3 shows
  $1,501: a formula takes the format of the first cell it reads.)

A number of days is easy to mistake for a count; the dates were right, only shown as serials.

**The fix** (`lib/sheets/formulaFormat.ts`, used when a formula is entered). A formula typed into a
cell with no format of its own takes one from what it reads, as Excel gives one on entry:
- a bare reference takes that cell's (its own format, or the one its formula implies);
- `+` and `-` take the first formatted operand's; two dates apart are a number of days, and keep
  none;
- SUM, AVERAGE, MIN, MAX, MEDIAN and the ROUNDs take their first argument's.

**Not changed, on purpose.** `*` and `/` take none. Excel carries a percentage through them too,
showing `=A1*100` over 12% as 1200%; here the plain number is shown. A cell that has a format keeps
it, and a formula entered before this round keeps what it had.

### 2026-09-29 — One order for text: the sort, =SORT() and the lookups

Tests: `tests/unit/sheetsSortOrder.test.ts` (4). The mutation run caught 3 of 3, and the control
survived.

#### R167 · S2 · After the ribbon's sort, approximate lookups took the wrong rows

**Found.** The ribbon's Sort compared text with numbers inside it in order of their value
(`localeCompare` with `numeric: true`): A1, A2, A3, A10, A20. Everything else in the engine
(`=SORT()`, MATCH, XLOOKUP, VLOOKUP, the `<` operator) goes character by character, as Excel does:
A1, A10, A2, A20, A3. In "R167 sort before", keys A10, A2, A1, B1, A20, A3 with their numbers,
sorted A to Z:
- The ribbon gave A1, A2, A3, A10, A20, B1, and `=SORT(A1:A6)` beside it A1, A10, A2, A20, A3, B1.
- `=VLOOKUP("A10",A1:B6,2,TRUE)` gave 1, A1's number (should be 10); `VLOOKUP("A3",…)` gave 20
  (should be 3); `=MATCH("A20",A1:A6,1)` gave 2 (A20 was row 5).

Sorting before an approximate lookup is how Excel users make one work, so a workbook sorted here
gave wrong numbers from then on, silently.

**The fix.** One text order, `compareText` in `lib/sheets/formula/values.ts`, used by the sort and
by every comparison in the engine: character by character, case aside, as Excel sorts. The ribbon's
sort, Custom Sort, `=SORT()` and the lookups now agree.

**Not changed.** Excel's own collation also places accented letters beside their plain ones and
some punctuation apart; here they sort by character code, after z. The filter's list of values
still lists numbers in text by value, which only changes what the list looks like.

### 2026-09-29 — Typed times, and dates with a month's name

Tests: `tests/unit/sheetsTypedDates.test.ts` (9). The mutation run caught 15 of 15, and the control
survived.

#### R166 · S2 · A typed time or a month-name date stayed text: times summed to 0

**Found.** A probe of 17 typed entries against how Excel reads them, then typed in the UI ("R166
typed before"):
- **Times stayed text:** 12:30, 9:00 AM, 25:00 were left-aligned text, and `=SUM(A1:A3)` of them
  was 0, without a warning.
- **Dates with a month's name stayed text:** 15-Mar-2023 and Mar 15, 2023, so `=B1+1` and
  `=B2-B1` were `#VALUE!` (Excel: 16-Mar-23 and 0).
- **An ISO date with AM or PM** (2023-03-15 9:00 AM) stayed text, though the grid picked a
  date-time format for it.

**The fix.** Typed input and text read as a number (`parseNumberText`) take times, `h:mm`,
`h:mm:ss`, with AM or PM, hours past 24 without (`parseTimeText`); and dates with a month's name,
or its three letters, in Excel's orders, two-digit years 00-29 in the 2000s (`parseDateText`, which
also takes AM or PM after an ISO date). Each shows as Excel shows it: `h:mm`, `h:mm AM/PM`, `[h]:mm`
past a day, `d-mmm-yy`, `mmm-yy`. A day past its month's end, a word that is no month, minutes past
59 and AM with an hour past 12 stay text. DATEVALUE reads the same dates. Times alone are kept out of
the SQL a table sheet compares dates with.

**Found while building it:** the fill handle (R165) read only ISO text as a date, so a typed
15-Mar-2023 would have gone on as text ending in a number (15-Mar-2024), and 9:00 as 9:01. A typed
date or time is now a date to it, and a time goes on by the hour.

**Not changed.** Dates with slashes (3/15/2023) stay text: which part is the month depends on the
place, and the typed text is what the workbook keeps and everyone it is shared with reads.

### 2026-09-29 — The fill handle's series

Tests: `tests/unit/sheetsFillSeries.test.ts` (10). The mutation run caught 16 of 16, and the control
survived.

#### R165 · S2 · The fill handle wrote dates that do not exist, and repeated months and weekdays

**Found.** A probe of the fill handle's series against Excel's AutoFill, then the handle dragged
in the UI ("R165 fill before"):
- **A date past a month's end was not a date.** Typed 2023-01-30 and filled down, it went on as
  text ending in a number: 2023-01-31, then "2023-01-32", "2023-01-33", "2023-01-34", as text.
  A date in the middle of a month happened to work the same way.
- **Two dates a month apart** (15 January, 15 February) repeated as a pair; Excel goes on to 15
  March. A date kept as a number with a date format repeated.
- **Months and days of the week repeated:** Jan, Jan, Jan; Monday, Monday.
- **Q3 ran on to Q4, Q5, Q6, Q7;** Excel goes back to Q1.

**The fix** (`lib/sheets/series.ts`, used by the fill handle). What a line of typed cells continues,
tried in order: dates (by the day for one; by the month or the year when they fall on the same day,
a short month taking its last day; else by their step in days), written as they were typed (a date,
or its number with its format); months and days of the week by name, in the same form and case and
round the cycle, by their step; quarters round from Q4 to Q1; numbers by their step, one alone
repeating; and text ending in a number.

**Found while building it: a day past a month's end was read as a date.** Typing 2023-02-31 gave 3
March: the day was checked against 31 for every month. It now stays text, as in Excel.

### 2026-09-29 — A file's text stays text

Tests: `tests/unit/sheetsImportText.test.ts` (5). The mutation run caught 3 of 3, and the control
survived. Fixture: `tests/fixtures/sheets/openpyxl-text.xlsx`, from `make_openpyxl_text.py`: nine
text cells that read like numbers, ISTEXT of each, COUNT, COUNTA and SUM over them, a number and a
plain word as controls.

#### R164 · S2 · Text in a file that read like a number came in as a number

**Found** in passing in R163: the fixture's text "£1,234.50" came in as the number 1234.5. Import
kept a file's text as text only when it was made of digits and `$.,%()-` alone, and let the rest
through to be read as typed input. A probe of 22 texts, then the fixture ("R164 text before"):
- **£1,234.50, €99 and ¥500 became numbers,** and so did codes such as **1e5 and 2E3** (100000,
  2000). ISTEXT said FALSE for each; COUNT over nine text cells was 5 (Excel: 0), and their SUM
  was over 100,000 (Excel: 0).
- **A text that starts with `'` lost it:** "'quoted" came in as "quoted".
- `$1,200`, `007` and ISO dates were already kept.

**The fix.** A file's text is kept as text whenever the reading typed input gets (`literalValue`)
would make it anything else, or it would read as a formula: it is marked with a leading `'`. A
plain word is left unmarked, and a number cell in the file is still a number. The check is the
same rule the grid uses, so it covers what the character list missed (other currencies, scientific
notation, TRUE, a leading `'`) and anything the reading learns later.

### 2026-09-29 — Number formats: durations, currency tags, fractions, conditions, capitals

Tests: `tests/unit/sheetsNumberFormats.test.ts` (14). The mutation run caught 21 of 21, and the
control survived. Two were missed on the way and their tests sharpened: the fixed denominator
(`?/8`) was only tested with a value its nearest fraction also gave (0.3 in quarters added), and no
text section had a fill (`@*-` added). Fixture:
`tests/fixtures/sheets/openpyxl-formats.xlsx`, from `make_openpyxl_formats.py`: fifteen rows of a
value, its format, and what Excel shows.

#### R163 · S2 · Durations, euro amounts and dates in capitals showed the wrong text

**Found.** A probe of 54 formats against Excel's documented output, then the fixture imported
("R163 formats before"):
- **Durations.** `[h]:mm` on 1.5 days showed `:12` where Excel shows 36:00; `[h]:mm:ss` showed
  `:00:00`, `[mm]:ss` `:00`, `[ss]` nothing, and `[h]" hours"` just "hours". The brackets were
  dropped with every other bracket. Excel's own built-in format 46 is `[h]:mm:ss`, so a timesheet
  from Excel showed none of its hours. A column of durations also counted as dates, so Save to
  lakehouse would have written it as timestamps.
- **Currency tags.** `[$€-2] #,##0.00` showed 1,234.50 with no €, and `[$£-809]` no £.
- **Fractions.** `# ?/?` showed 1.5 as 2, and `?/?` showed 0.75 as 1.
- **Conditions.** `[<10]"small";"big"` showed "small" for 12: conditions were read as the positive
  section, as the module's comment said.
- **Dates in capitals.** `DD/MM/YYYY`, `MM/DD/YY` and `HH:MM:SS` printed those letters, because the
  date codes were read in lower case only. LibreOffice writes its date formats in capitals, so every
  date in such a file showed the format instead.
- **Found while writing the docs: spacing codes were printed.** `_)` and `*` showed as themselves:
  `#,##0_);(#,##0)` showed 1234.5 as `1,235_)`, and Excel's built-in Accounting format
  (`_("$"* #,##0.00_);…`) as `_($* 1,234.50_)`. Both are among the formats Excel files use most.

**The fix** (`lib/sheets/format.ts`).
- **Durations:** `[h]`, `[m]`, `[s]` (and `[hh]`, `[mm]`, `[ss]`) count whole hours, minutes or
  seconds from zero. `isDateFormat` says no to them, so a duration stays a number wherever a date
  is treated as a date (a saved column, a chart's labels, a query variable).
- **Currency tags:** `[$sym-locale]` shows its symbol; `[$-409]` shows nothing.
- **Fractions:** the nearest fraction with as many digits as the `?`s allow, or the denominator
  written. `?` holds a space where a digit is not, so parts line up as Excel aligns them. A whole
  number leaves the fraction's place blank.
- **Conditions:** the first section whose condition holds; a section without one takes the rest,
  and a value that meets none shows #s. The colour comes from the same section. A section only for
  negatives (`[<0]`), or one of text alone, writes no minus.
- **Dates:** the codes are read in any case.
- **Spacing:** `_x` is a space as wide as x; `*x`, a fill to the cell's width, is left out, since
  a format here does not know the cell's width. The same in numbers, dates and text.

### 2026-09-29 — Formulas from older Excel, and @

Tests: `tests/unit/sheetsImplicitIntersection.test.ts` (18). The mutation run caught 21 of 21, and
the control survived. Its first run missed four, and four tests were made sharper: a whole column
read below its data, a function's array taken to one value, IF's own condition, and a file with
Excel's SINGLE. Fixture: `tests/fixtures/sheets/openpyxl-legacy.xlsx`, from
`make_openpyxl_legacy.py`, with older Excel's value for each formula worked out by hand.

#### R162 · S2 · A formula from older Excel spilled where Excel takes one value

**Found.** A plain formula in a file is one from Excel before dynamic arrays (R161). Where it
expects one value and meets a range, Excel takes the value in the formula's own row, and Excel 365
shows an `@` there. Sheets read every formula as a dynamic one. Importing the fixture ("R162 legacy
before"), where Excel shows D2:D4 as 10, 10, 12:
- **`=Price*Qty`, names over whole columns,** showed `#SPILL!` in D2 and D3 and `#VALUE!` in D4. D4
  spilled the whole column's products down to row 8, below the data, where the file has nothing.
  `=B:B*C:C` did the same.
- **`=A2:A4` in F2** spilled Pen, Ink and Pad into F2:F4; Excel shows Pen, and F3 and F4 are
  empty. In G5, below the range, it spilled three names where Excel shows `#VALUE!`.
- **`=SUM(LEN(A2:A4))` in H2** was 9, where Excel takes LEN of the row's own item: 3.
- **Sheets had no `@`.** Typing `=@A2:A4` was a syntax error, and Excel 365's `_xlfn.SINGLE`
  was an unknown function.

SUMPRODUCT, LOOKUP, `=SUM(B2:B4)` and an array formula were already right, and stay so.

**The fix.**
- **`@` in formulas.** The lexer and parser read it, and the evaluator takes one value: from a
  column, the cell in the formula's row; from a row, the one in its column; from a block, the cell
  in both; outside, `#VALUE!`; from an array, its first value. A whole column holds every row.
- **Reading a file** (`lib/sheets/formula/implicit.ts`): a plain formula takes an `@` before each
  range, or name of several cells, where older Excel expects one value. Those places are an
  operator's operand, a function's single-value argument (the arguments the engine lifts, and IF's
  condition, IFERROR's value, CHOOSE's index), and the formula itself. Arguments every Excel works
  over as arrays take none: SUMPRODUCT, LOOKUP's vectors, INDEX's array, the statistics of two
  arrays, and the dynamic-array functions. That list errs toward reading a formula as today. An
  array formula is left as it is, and `_xlfn.SINGLE(x)` comes in as `@(x)`.
- **Writing a file.** An `@` where older Excel takes one value anyway is dropped, so the formula
  goes back as it came; anywhere else, or in a dynamic array formula, it is written
  `_xlfn.SINGLE(…)`.

**Found while building it: R161's check missed functions that work over arrays themselves.** IF,
IFERROR, IFNA and CHOOSE lift inside their own code, not through the evaluator, so
`=SUM(IF(C1:C3,1,0))` and `=SUM(IFERROR(A1:A3,0))` would still have gone out as plain formulas,
which Excel reads the older way. Their argument is now checked too.

### 2026-09-29 — Dynamic array formulas in downloads

Tests: `tests/unit/sheetsDynamicArrays.test.ts` (12). The mutation run caught 17 of 17, and the
control survived; its first run missed one, because the test's whole column had five rows, and the
test was changed to use a column of one row. Fixture: `tests/fixtures/sheets/xlsxwriter-dynamic.xlsx`,
from `make_xlsxwriter_dynamic.py`.

#### R161 · S2 · A download changed what Excel computes: array formulas went out as older Excel's

**Found.** Excel reads a formula in a file as one from before dynamic arrays unless the cell is
marked. Where such a formula expects one value and meets a range, Excel takes the value in the
formula's own row, and shows `@` there. The [libxlsxwriter
documentation](https://libxlsxwriter.github.io/working_with_formulas.html) describes it: written
plainly, `LEN(A1:A3)` gives one value, and to work on the whole range a formula has to be written
as an array or a dynamic array formula. A download from Sheets marked nothing.
- **A formula that works over a range went out plain.** In "R161 array formulas", B5
  `=SUM(LEN(A1:A3))` is 14 in Sheets. The file held `<f>SUM(LEN(A1:A3))</f>`, and the workbook
  tells Excel to recalculate when it opens (`fullCalcOnLoad`). Excel then computes
  `=SUM(LEN(@A1:A3))`: row 5 is outside A1:A3, so the answer is `#VALUE!`. In a row inside the
  range it would be one word's length, a wrong number with no error. `SUM(IF(…))`, `MAX(IF(…))` and
  `MATCH(1,(A=x)*(B=y),0)` are the common kinds.
- **A spilling formula went out as an older array formula.** `=FILTER(A1:A3,LEN(A1:A3)>3)` was an
  array formula over D1:D2 with no mark: Excel's Ctrl+Shift+Enter kind, fixed to two cells. When
  the data changes in Excel, it does not spill: extra rows are cut off without a warning, and
  missing ones show `#N/A`. The Sales performance sample shipped three of them.

**The fix.** The engine now notes, for each formula, whether it worked over several values where
older Excel took one: an operator on a range, or a function of single values given one (the
evaluator's `onArray`, and `WorkbookEngine.arrayFormula`). A whole column counts as many values
even when one row is used.
- **The download** writes such a formula, and every one that spills, as an array formula over the
  cells it fills: one cell for `=SUM(LEN(A1:A3))`, D1:D2 for the FILTER.
- **Excel's mark** (`lib/sheets/xlsxDynamic.ts`) adds `cm="1"` to the cell, and the workbook's
  `xl/metadata.xml` with its content type and relationship. ExcelJS writes neither. The part is the
  same as the one XlsxWriter writes for Excel's dynamic array formulas, which the tests compare
  against.
- **Formulas that need no mark stay plain,** such as `=SUM(A1:A3)`, `=COUNTIF(…)`, `=INDEX(…)` and
  XLOOKUP. None of the other 1,319 formulas in the Sales sample is marked.
- **The Sales performance sample was written again,** so its SORTBY and FILTER spill in Excel.
  Its 41 figures, checked in Python with openpyxl, still agree.

**Found while fixing it.** ExcelJS's `fillFormula` reads a one-cell range ("B5") as no range at
all, and writes nothing, not even the value. A one-cell array formula is set on the cell instead.

### 2026-09-29 — Hidden sheets

Tests: `tests/unit/sheetsHiddenSheets.test.ts` (15). The mutation run caught 22 of 22, and the
control survived. Fixture: `tests/fixtures/sheets/openpyxl-hidden.xlsx`, from
`make_openpyxl_hidden.py`.

#### R160 · S2 · A very hidden sheet was dropped on import, and its formulas said #REF!

**Found.** Excel keeps helper sheets hidden, and a macro-built workbook keeps some very hidden.
The fixture's Summary reads a rate from a hidden sheet (`=C2*Rates!$B$2`) and a key from a very
hidden one (`=Keys!A1`).
- **The very hidden sheet was dropped.** The import dialog listed Summary and Rates only. In the
  workbook, B7 showed `#REF!` ("No sheet "Keys""), and a download kept `=Keys!A1` with no Keys
  sheet in the file, so Excel shows `#REF!` too.
- **The hidden sheet came in showing.** Rates was an ordinary tab, marked only in the dialog, and
  a download wrote it visible.
- **A sheet could not be hidden, unhidden or duplicated.** The tab menu had Rename, Move left,
  Move right and Delete.

**The fix.** A grid sheet has a `hiddenSheet` flag, saved with it, and undone with Ctrl+Z like any
other change to the sheet.
- **Excel files.** A hidden or very hidden sheet comes in hidden, with its cells, so formulas that
  read it compute. A download writes it hidden, and points Excel at the first sheet showing; if
  every sheet were hidden, the first is written showing.
- **The tab menu.** Duplicate, Hide, and Unhide ▸ with the hidden sheets. The tab bar shows only
  the sheets not hidden, and hiding the sheet in view moves to the next one. The copy opens.
- **One sheet always shows.** Hiding the last sheet showing is refused ("A workbook keeps at least
  one sheet showing"), and so is deleting it while every other sheet is hidden.
- **Around hidden sheets.** Find (Within: Workbook) leaves them out, as Excel's does. Moving a tab
  passes over the hidden ones next to it.
- **Duplicate** copies the sheet's cells, formats, rules, notes and charts into a new sheet named
  `Summary (2)`, through the same server call as an import. A copy of a hidden sheet shows.

**Found while driving it: after Hide, the keyboard was on the page.** The menu hands the keyboard
back to the tab it was opened from, and hiding had taken that tab away. Ctrl+Z and the arrows did
nothing until the grid was clicked. Hide, Unhide and Duplicate now give the keyboard to the grid.

**Found while driving it: Ctrl+Z after Unhide left a hidden sheet in view.** Undoing a sheet's
setting goes to that sheet, so undoing Unhide hid Rates again and kept it on screen, with no tab
lit and its cells open to editing. Ctrl+Y after Hide did the same. Now a hidden sheet is never the
one in view: the next sheet showing is, or else the one before (`shownInstead` in
`lib/sheets/sheetTabs.ts`). The same rule opens a file whose first sheet is hidden on the first
sheet showing.

**Not changed.** A very hidden sheet goes back out as a hidden one, which Excel's Unhide then
lists. Hiding is not a permission: the sheet is still sent to everyone the workbook is shared with.

### 2026-09-29 — Paste special

Tests: `tests/unit/sheetsPasteSpecial.test.ts` (14). The mutation run caught 12 of 12, and the
control survived.

#### R159 · S3 · No Paste Special: no Transpose, no operations, no skipping blanks

**Found.** The cell's menu had Cut, Copy, Paste, Paste values only and Paste formatting only.
Ctrl+Alt+V did nothing. A row of headers could not be turned into a column, a copied column could
not be added into another, blanks could not be pasted around, and formulas, notes or values with
their number formats could not be pasted alone. Paste Special is one of Excel's most used commands.

**The fix.** **Paste special…** (Ctrl+Alt+V, or the cell's menu), over cells copied in the workbook,
worked out as cell edits in `lib/sheets/pasteSpecial.ts` and applied as one undo step.
- **What to paste.** All, Formulas, Values, Values and number formats, Formats, or Notes.
- **Operation.** Add, Subtract, Multiply or Divide a copied number into the target. A formula
  target is wrapped (`=(LEN(B2))+16`) and a blank one counts as 0. Text on either side leaves the
  cell alone, the target keeps its formats, and a division by zero shows `#DIV/0!`.
- **Skip blanks, and Transpose.** A transposed formula's references move to where it lands.
- **Refused after a cut,** as in Excel.
- **Shared code.** Paste values' literal rule moved into the same module, so both pastes read a
  value back the same way.

**Found while driving it: after the dialog, Ctrl+Z went nowhere.** The dialog focused the grid while
it was still open, and its focus trap took focus back. When it closed, the keyboard was on the page,
and the paste could not be undone from the keyboard until the grid was clicked. It now returns the
keyboard once the dialog has gone (afterDialog), as the editor's other questions do.

### 2026-09-29 — A model picker in Ask AI

Tests: `tests/unit/sheetsAssistModel.test.ts` (10). The mutation run caught 10 of 10, and the
control survived.

#### R158 · S3 · Ask AI ran on one model, and an answer did not say which

**Found.** The user asked where the assistant's model is configured: Ask AI had no picker. The
panel's header was "Assistant · reads this workbook as you see it", and nothing else. The model was
the admin's alone (`SHEETS_ASSIST_MODEL`). An answer said "Cost $0.0007" and not which model gave it;
only the Audit Log did (a model call on `openrouter/google/gemini-3-flash-preview`). The platform's
other AI tools (BI) let each person pick from their connected providers.

**The fix.**
- **The picker.** A **Model** row under the panel's title, with the platform's picker
  (BiModelSelect): the person's connected providers and their models, IAM model rules applied.
  **Default · openrouter/google/gemini-3-flash-preview** names the admin's model; it is read
  through `sheetsAssistDefaults`.
- **Remembered.** The pick is kept in the browser, and Fill with AI runs on it; its dialog names the
  model.
- **Named.** Each answer says which model gave it, beside its cost.
- **The server.** It takes a pick as a name (`provider::model`) and checks that it is a gateway
  provider/model ("… is not a model the assistant can use" otherwise).
- **Dropped when it stops being yours.** A remembered pick the person can no longer use (a
  provider disconnected, a rule now refusing it) goes back to the default, with a message.

**Why the server now takes a model.** Phase H (AI in Sheets) decided "the input schema has no model
field". A pick adds no new power: every call still goes through the chat channel as the person,
which applies their IAM model rules, budget, trace and cost and refuses a model they may not use.
What it adds is the choice the platform's other AI tools already give.

### 2026-09-29 — Text to columns

Tests: `tests/unit/sheetsTextToColumns.test.ts` (10). The mutation run caught 11 of 11, and the
control survived.

#### R157 · S3 · No Text to Columns

**Found.** The Data tab (Sort A to Z, Sort Z to A, Sort…, Filter, Remove duplicates…, Data
validation…, Names, Save to lakehouse) had no way to split a column of "Asha Rao" or
"Lisbon,PT,2026". A formula per piece (TEXTBEFORE, TEXTAFTER, TEXTSPLIT) left the text in place and
needed a column of formulas per piece. Text to Columns is one of Excel's most used Data tools, and
the queue listed it after R153.

**The fix.** **Data → Text to columns…**, over one column's cells.
- **Split at.** Tab, semicolon, comma, space and any other one character. Treat several in a row
  as one.
- **Quotes.** Text in double quotes (or single, or none) stays whole; a doubled quote is one quote.
- **Destination.** The first cell, unless another is typed. A preview shows the first five rows.
- **What the pieces become.** As a CSV's fields (csvCell): numbers and dates become them with the
  format they imply, and formula-looking text stays text.
- **Writing.** The pieces fill the widest row's width; a shorter row's other cells are emptied.
  Writing over any data other than the column itself asks first ("Replace what is there?"). A
  merged cell there is refused, and the message now names the action ("…to split text into it").
  One undo step.
- **What is split.** A whole column is split down to its last cell in use. Two or more columns are
  refused.

### 2026-09-29 — Sort by several columns, and no sort under a merged cell

Tests: `tests/unit/sheetsCustomSort.test.ts` (9). The mutation run caught 10 of 10, and the control
survived.

#### R156 · S2 · A sort left a merged cell behind, joining two other records

**Found, while proving the missing Custom Sort.**
- **The gap.** The Data tab sorted by the active column only, so a list could not be ordered by city
  and then by name. Excel's Data → Sort takes several levels.
- **The bug.** In "R153 contacts", C2:C3 was merged, then Data → Sort Z to A was pressed on A2. The
  rows moved and the merge stayed at C2:C3. It now joined the two Dev Iyer rows' cities, drawing
  the first and hiding the second. So a merge made for one record's cells covered another's.
- **Excel.** It refuses ("To do this, all the merged cells need to be the same size").

**The fix.**
- **Data → Sort…**, Excel's Custom Sort. Levels (up to 8), each on a column and A to Z or Z to A.
  Add level takes the next unused column; levels move up and down and are deleted. A column in
  two levels is refused. Headers are guessed, and taken for a filter's range; a filter's range
  is filtered again after the sort. The message names the columns: "Sorted A1:E8 by City, then
  Name (Z to A)".
- **Every sort refuses merged cells:** Sort A to Z and Z to A, a filter button's sort, and Sort….
  The message says to unmerge first. A refused sort no longer reports that it sorted.

### 2026-09-29 — Query variables: a cell steers a query sheet

Tests: `tests/unit/sheetsQueryVariables.test.ts` (17), 5 of them on DuckDB. The mutation run caught
14 of 14, and the control survived.

#### R155 · S3 · A query sheet ran the same SQL whatever the workbook held

**Found.** Row Zero's connected tables take variables (`WHERE FL_DATE >= '{{date}}'`) that a
person changes without touching the query. A query sheet (R154) could not: its Edit query preview
with `WHERE region = {{Region}}` said `SQL parse error: syntax error at or near "{"`. To see
another region, someone who could edit the sheet had to rewrite its SQL. A viewer could not do it
at all.

**The fix.** `{{Name}}` is the value of the workbook name Name.
- **Binding.** The value is bound on the server as a literal: text quoted, with its quotes
  doubled; numbers; TRUE and FALSE; NULL. A name over several cells is a list for IN, and a date
  cell goes as its date. Row Zero's `'{{name}}'` reads the same. The template is checked, bound,
  and checked again.
- **Where the values come from.** The workbook sends the values of its names with every read:
  a page, a filter's values, a download, Save to lakehouse, and grid formulas over table sheets.
  Lookups and pivots into a query sheet bind them too.
- **A change.** When a name's value changes, the query sheets that use variables read again. So do
  the grid formulas over them. A viewer's copy has no SQL to tell which query uses which name, so
  every query sheet reads again.
- **A missing name.** A variable whose name is not defined stops the read with a reason naming what to define.
  The query editor lists each variable with its current value, and "no such name".
- **Learning the columns.** A query's columns are read with its variables NULL, so a sheet can be
  made before a value is set.

### 2026-09-29 — Query sheets: a SELECT over the lakehouse as a sheet

Tests: `tests/unit/sheetsQuerySheets.test.ts` (20), 7 of them on DuckDB. The mutation run caught
18 of 18, and the control survived.

#### R154 · S2 · A sheet could only open a table that already existed

**Found.** Asked whether Sheets does what Row Zero's connected tables do (query a source and fill
a sheet), a research pass and the UI answered: in part.
- **What was there.** A table sheet could open a lakehouse table, or copy a connection's table or
  query into a new lakehouse table, with a manual Refresh from source.
- **What was missing.** Add a table sheet's Lakehouse tab listed 54 tables and had no query. The
  lakehouse connection, which would have taken one, is hidden from the Connection tab, and this
  account had no other connection ("No database connections yet").
- **The cost.** A join, a filter or a total had to be saved as a table (or a scheduled
  materialized view) before a sheet could show it.

**The fix.** A table sheet's source can be a query: **Lakehouse query** in Add a table sheet.
- **Writing it.** The SQL, the tables you can read (a click puts one in), and Preview (the first
  50 rows).
- **What it may be.** One SELECT or WITH, checked by the same guard as the local SQL engines, with
  matching parentheses (it runs inside the sheet's own SELECT) and at most 20,000 characters. The
  lakehouse refuses file functions as it does in the Query editor.
- **How it runs.** As a subquery at the base of the sheet's relation, so sorts, filters,
  calculated columns, pivots, lookups, downloads, Save to lakehouse and grid formulas all work on
  it. It runs as the reader, with their own grants and policies; a share's row filter applies at
  its edge.
- **Nothing is copied.** Refresh runs it again, and Edit query changes it, keeping the sheet's
  settings.
- **Lineage.** Save to lakehouse's catalog lineage names the tables the query reads.

**The SQL a read runs is the saved one.** A read sends the sheet's settings from the editor, so a
sort shows before it is saved. For a query sheet that would be SQL from a browser. Every read (a
page, a filter's values, a download, Save to lakehouse) runs the SQL saved with the sheet instead,
and a read can't turn a table sheet into a query. A viewer's copy carries no SQL. Proved in the
UI: a read whose request was rewritten to another query returned the saved query's rows.

### 2026-09-29 — Remove duplicates, and the keyboard after a ribbon tool

Tests: `tests/unit/sheetsDedupe.test.ts` (12), over `tests/fixtures/sheets/openpyxl-dupes.xlsx` (made
by `make_openpyxl_dupes.py`). The mutation run caught 13 of 13, and the control survived.

#### R153 · S3 · No Remove Duplicates

**Found.** The Data tab had Sort A to Z, Sort Z to A, Filter, Data validation…, Names and Save to
lakehouse. A list exported twice, or a sign-up sheet filled in again, had to be cleaned row by row.
UNIQUE shows the distinct rows somewhere else; it does not clean the list. Remove Duplicates is one
of Excel's most used Data tools.

**The fix.** **Data → Remove duplicates…**, over the selection or the data around the active cell.
- **The dialog.** Every column is checked, with Select all and Unselect all. The header box is
  ticked when the first row is all text, and a column is named by its header.
- **What repeats.** A row repeats when every checked column shows what an earlier row's shows,
  ignoring case, as in Excel: `ASHA@EXAMPLE.COM` repeats `asha@example.com`, and one date shown two
  ways does not.
- **Removing.** The rows below move up within the list, with their formats, links and notes, and a
  formula's references move with its row, as in a sort. Nothing outside the list moves. One Ctrl+Z
  puts it back.
- **Refused.** A list with merged cells, since they cannot move up.
- **The message.** How many rows went and how many remain, or that none repeat.

The move a sort makes is now one function, used by both.

**Found while driving it: after a ribbon tool, Ctrl+Z went nowhere.** A click on a ribbon tab kept
the keyboard. The tools leave the focus where it is, so it stayed on the tab, and the grid, which
takes Ctrl+Z, no longer had it. After Data → Sort A to Z, the first Ctrl+Z did nothing until the
grid was clicked. This was seen in R152's round too. A click on a tab now leaves the keyboard in the
grid, as in Excel.

### 2026-09-29 — Cell notes

Tests: `tests/unit/sheetsNotes.test.ts` (14), over `tests/fixtures/sheets/openpyxl-notes.xlsx` (made
by `make_openpyxl_notes.py`). The mutation run caught 20 of 20, and the control survived.

#### R152 · S2 · A file with notes could not be imported, and notes were dropped everywhere

**Found.** openpyxl writes a cell's comment (Excel's note) to `xl/comments/comment1.xml`, linked
by an absolute path. The file library only knows Excel's own `xl/comments1.xml`, and threw while
loading. The Import dialog said "Could not read Budget with notes.xlsx: Cannot read properties of
undefined (reading 'comments')". Not the notes alone: the whole workbook could not come in. A
file saved by Excel came in, and its notes were dropped. A cell had nowhere to keep one, a
download wrote none, and there was no way to write one. A shared budget or report explains its
figures in notes.

**The fix.**
- **Reading.** Notes are read from the package directly, whatever its layout: Excel's notes, and
  Excel 365's threaded comments (the replies after the first). The author leads the text, as Excel
  shows it ("Asha:" on its own line). The file library no longer sees the comment parts, so a
  layout it does not expect cannot stop an import. The dialog counts each sheet's notes.
- **Keeping.** A cell keeps its note, up to Excel's 32,767 characters, and the server's schema
  takes it. A note on an empty cell is kept, as Excel keeps it.
- **Writing.** Shift+F2, or New note… on the cell's menu; Edit note… and Delete note once there
  is one. Ctrl+Enter saves.
- **Showing.** A red corner at the cell's top right; the note on hover, and beside the active
  cell.
- **Following the cell.** A sort moves notes with their rows; paste and cut bring them; inserted
  and deleted rows move them. Undo takes any of it back.
- **Find.** Look in: Notes.
- **Download.** Each note goes out as Excel's note. The file library names every note's author
  "Author"; that placeholder is ignored on the way back in, so a round trip adds no "Author:".

**Also found: a sort dropped Excel's saved values.** A formula Sheets does not compute shows the
value Excel last saved. A sort rewrote the formula without it, and the cell showed `#NAME?` in
place of its figure. The saved value now moves with its formula.

**Found while driving it: Clear all left the note.** On B4, Home → Clear → Clear all emptied the
cell, and its red corner, hover text and note card stayed. Excel's Clear All takes notes too.
Clear all now does. Clear contents still leaves the note, as Excel's does, and a new **Clear
notes** takes only the notes.

### 2026-09-29 — Freeze panes, and charts over the headers

Tests: `tests/unit/sheetsFreeze.test.ts` (11). The grid is drawn to HTML with `renderToStaticMarkup`
and read for where each cell lands. The mutation run caught 15 of 15, and the control survived.

#### R151 · S2 · Frozen panes were kept in the file and never drawn; no Freeze Panes

**Found.** The "Q1 sales (openpyxl)" workbook came from a file frozen at B2. Scrolled 300 px down
and right, its header row and column A were gone. Downloaded again, the file still said
`freeze_panes = B2` (read by openpyxl): `frozenRows` and `frozenCols` went in and out with the
file, and the grid never read them. The View tab had zoom and gridlines, and no Freeze. A frozen
header row is how most Excel lists are kept readable; here a filter's buttons scrolled away with
their headers.

**Also found: charts drew over the column headers.** On the Sales dashboard scrolled 600 px, the
element on top at the column-header band was a chart, not the header. Charts are z-20 in the
body, and so were the column headers; the later one in the page won.

**The fix.**
- **The panes.** The grid draws frozen rows, frozen columns and their corner as sticky panes over
  the body. Each cell is drawn once, in the pane that holds it, and each pane draws its own part of
  the selection, the fill handle, the editor and the overlays: filter buttons, the list button,
  the link chip.
- **Clicks and scrolling.** A click in a frozen pane is not moved by the scroll. A cell brought
  into view clears the frozen part.
- **Headers.** The frozen rows' numbers and columns' letters stay put too.
- **Stacking.** The grid is its own stacking context: body, charts, panes, then headers.
- **The menu.** View → Freeze has Freeze panes (at the active cell), top row, first column and
  Unfreeze, undoable like any sheet setting.
- **Inserts and deletes.** Inserting rows above the line moves it down, within what a save
  keeps; deleting frozen rows moves it up.

**Found while driving it.** The corner was first nested in the frozen-rows pane. That pane hides
its overflow, so the corner stuck to the pane instead of the grid, and slid away with the frozen
row: "Total" and "Updated" showed where "Region" belonged. The corner now sticks both ways on its
own.

### 2026-09-29 — Find and Replace

Tests: `tests/unit/sheetsFind.test.ts` (19). The mutation run caught 18 of 18, and the control
survived.

#### R150 · S2 · No Find or Replace, and the browser's own find cannot reach rows off screen

**Found.** In the Sales sample's Orders sheet (240 orders), Ctrl+F and Ctrl+H did nothing, and no
menu offered Find. The only Search (Ctrl+K) is the product's, not the sheet's. The grid draws only
the rows on screen, 105 cells of the Dashboard and 240 of Orders. So a browser's page find cannot
reach SO-10200 in row 201: it is not in the page until scrolled to. Excel's Find and Replace are
among its most used commands; a workbook of any size had no way to look for a value.

**The fix.** Find and Replace as Excel's:
- **Opening it.** Ctrl+F, Ctrl+H, or Home → Find opens a panel over the grid. The grid stays
  usable while it is open.
- **Finding.** Find Next and Find Previous go on from the active cell and wrap round. Find All
  lists the matches; clicking one goes to it, switching sheets when it has to.
- **Options.** Search the sheet or the workbook. Look in Values (what cells show) or Formulas
  (what was typed). Match case and Entire cell narrow the match. Excel's `*`, `?` and `~` work.
- **Replacing.** Replace works on what was typed. The first press goes to a match; the next
  replaces it. Replace All is one undo step across sheets, and leaves a formula the change would
  break, saying how many it left.
- **Viewers** find, and are not offered Replace.

`lib/sheets/find.ts` has the pattern and the search, and `FindPanel.tsx` the panel.

**Found while driving it:**
- **The list could overflow.** At 715 pixels high, Find All's list ran past the grid, over the
  sheet tabs. The panel now keeps within the grid, and the list scrolls inside it.
- **The panel forgot the last search.** Closed and opened again, it came back empty, where
  Excel's keeps the search. It now opens with the last one.
- **Find All's rows answered only to a mouse.** The repo's keyboard guard
  (`keyboardOperable.test.ts`) failed the first gate run on them. They are keyboard controls now:
  Tab reaches them, and Enter goes to the match.

### 2026-09-29 — Rules left behind when their cells or sheet moved

Seen in the code while wiring names through the same paths (R148), then proven in the UI.

Tests: `tests/unit/sheetsRulesFollow.test.ts` (12). The first mutation run was void: its control
failed. `sheetsRules.test.ts`'s xlsx round trip needed 19.8 s of its 20 on the first file-library
load in a worker, and the run had other load. Its describe now pays that load in a `beforeAll`
with room. On a quiet rerun the mutation run caught 9 of 9, and the control survived.

#### R149 · S2 · A sheet rename and Insert/Delete cells rewrote the cells' formulas, not the rules'

**Found.** A validation list and a conditional format hold formulas: a list's source
(`=Sheet2!$A$1:$A$3`) and a rule's formula. Inserting and deleting rows and columns rewrote them.
Three other changes rewrote only the cells' formulas.
- **A sheet renamed.** B2's list over `Sheet2!$A$1:$A$3` was checked after renaming Sheet2 to
  Regions. `=COUNTA(Sheet2!A1:A3)` beside it followed and kept showing 3. The list said "The list
  is empty.", and typing North, a listed value, was refused: "Not allowed here — Choose one of:".
  The rename dialog promised "Formulas that refer to this sheet follow the new name."
- **Insert cells, shift down.** B5's list over `$E$1:$E$3` (x, y, z) was checked after inserting a
  cell at E1. `=COUNTA(E1:E3)&" "&E1` followed and kept showing "3 x". The list kept pointing at
  E1:E3, so it offered x and y: z was gone, and the empty E1 stood where x had been.
- **An import that had to rename a sheet** (an apostrophe, a clash) left the rules on the old name.

**The fix.** `mapGridFormulas` (ops.ts) passes every formula of a sheet, cells' and rules',
through one rewrite. The sheet rename, Insert/Delete cells, row and column inserts, a name's
rename and the import's rename (`renameSheetsInGrid`) all go through it. A path cannot now rewrite
one kind of formula and forget the other.

**Found on the way.** Driving the Name box fast, the Enter key read the Name box's text from the
previous render. It found nothing, so the focus stayed in the box, and the next word typed was
taken as a new name: the toast said "A1 is named A1North". The Name box now reads what the input
holds when Enter is pressed. The same fast sequence, repeated after the deploy, went to the cell.

### 2026-09-29 — Named ranges: an Excel model's names came in as nothing

An Excel model built on names (`=SUM(Revenue)*TaxRate`) imported looking right, and then never
changed. Sheets had no names at all.

Tests: `tests/unit/sheetsDefinedNames.test.ts` (37), over the openpyxl fixture
`tests/fixtures/sheets/openpyxl-names.xlsx` and its generator. The mutation run first caught 24 of
25. The miss was a test that pinned only part of the server's viewer filter: a mutant that let
every name through still matched it. With the whole call pinned, it caught that one too. The
control survived both runs.

#### R148 · S2 · A workbook's names were dropped on import, and the formulas using them froze

**Found.** A file with six names was imported through the dialog. The names were:
- a range with a comment;
- a cell;
- a value;
- a cell on a sheet whose name needs quotes;
- one over two areas;
- one scoped to a sheet.

Nine formulas used them. The dialog did not mention the names. It said 8 formulas were "kept at
Excel's value" because they use "a function Sheets does not compute", which was not true. On the
sheet:
- every formula over a name showed Excel's saved answer, with a hover saying it "refers to
  something outside this workbook";
- changing B2 from 10 to 100 moved `=SUM(B2:B4)` to 150, and left `=SUM(Revenue)` at 60,
  `=SUM(Revenue)*Rate` at 6 and `=SUM(Revenue)*TaxRate` at 12.

Typed, a formula with a name showed `#NAME?`, and there was no way to define a name.

**The fix.**
- **Storage.** Names are the workbook's: `sheet_workbooks.names`. Each version keeps them, and
  restoring a version restores them (migration `20260929000000_sheets_defined_names.sql`).
- **Computing.**
  - The engine is built with the names and evaluates one wherever a formula uses it.
  - A name for cells is a reference wherever a function takes one (ROWS, INDEX, OFFSET, SUMIFS,
    ISREF).
  - A name that refers to itself is `#CYCLE!`. LET's own names come first.
- **Import.** The import reads the file's `<definedNames>`. It leaves some out, and says which:
  - print areas;
  - hidden helper names;
  - links into other workbooks;
  - names over several areas.

  A formula over a name it keeps computes; one over a name it left out keeps Excel's value.
- **Export.** The download writes the names back, with their comments, the file's sheet names and
  its function prefixes.
- **The Name box** goes to a name, and names the selection when given a new one, as Excel's does.
  It shows a name when the selection is exactly that name's cells.
- **Data → Names** (the Name Manager) lists the names with what each comes to. It adds, edits,
  renames and deletes them. A rename rewrites every formula, rule formula and other name that uses
  it.
- **Names move as formulas do** when rows or columns are inserted or deleted, cells shifted, or a
  sheet renamed. Undo restores them with the cells.
- **Autocomplete** offers names, without an opening bracket.
- **The AI assistant** is told the workbook's names.
- **Viewers.** Someone whose share leaves a sheet out is not sent the names into it, nor into a
  table sheet it leaves out.

Two smaller things came with it:
- **Imported LET formulas kept a saved value they never used.** `computable` did not know LET's own
  names, so the import kept Excel's value for every formula with LET. It knows them now.
- **The viewer filter's first version was wrong.** It hid a name unless every sheet the name reads
  existed and was shown. A name into a deleted sheet would have vanished for its owner too, who
  could then neither see it nor fix it. It now hides only names into sheets the share leaves out
  (`namesShown`).

**Driven.** The file was imported before and after the fix. Then these were driven on the new
workbook: the Name Manager, the Name box, autocomplete, insert-row and undo, a rename, a reload,
the export (read back with openpyxl) and a viewer's cut. UI_TEST_RESULTS has each step and what
came back.

### 2026-09-29 — Functions Excel has, and seven the long tail lost without a word

A list of 187 everyday Excel functions was typed into a grid, one at a time. 41 showed #NAME?. From
an Excel file, the same formulas show the value Excel last saved; typed, they fail.

Sheets now has 240 functions. `tests/unit/sheetsFunctions.test.ts` (14) checks each new one against
the answer Excel's documentation gives. It also pins two invariants:
- every name listed for formula.js registers;
- every function the lakehouse computes over a table sheet also exists on a grid.

The mutation run caught 16 of 16; the control survived.

Two things are still missing: LAMBDA, and AGGREGATE with its 19 functions and options. A file that
uses either shows the value Excel saved.

#### R147 · S2 · Seven functions listed for the long tail never registered, and 34 more were missing

**The seven.** `LIBRARY_NAMES` lists the functions formula.js computes, and a loop registers each. It
skipped any name formula.js did not export as a function. formula.js exports the legacy statistics
names as groups: STDEV holds STDEV.S and STDEV.P, and RANK holds RANK.EQ and RANK.AVG. So the
following were quietly never there:
- STDEV, VAR, PERCENTILE, QUARTILE, RANK, MODE;
- FORECAST.LINEAR, which formula.js lacks altogether.

The lakehouse does compute STDEV, VAR and RANK over a table sheet, so the same function worked on a
table and showed #NAME? on a grid.

**The rest, now there:**
- SUBTOTAL, with Excel's rules:
  - it leaves out rows a filter hides, and with codes 101–111 rows hidden by hand too;
  - it skips cells that are themselves SUBTOTAL formulas;
  - it recomputes when a filter is applied or cleared.
- LOOKUP, OFFSET, INDIRECT (A1 style), ADDRESS, HYPERLINK, ISREF, ISFORMULA, FORMULATEXT, LET.
- TIME, TIMEVALUE, NUMBERVALUE, SUMSQ, CEILING.MATH, FLOOR.MATH, NETWORKDAYS.INTL, WORKDAY.INTL.
- TREND, GROWTH, FREQUENCY.
- TAKE, DROP, CHOOSECOLS, CHOOSEROWS, VSTACK, HSTACK, TOCOL, TOROW, RANDARRAY.
- TEXTSPLIT, TEXTBEFORE, TEXTAFTER.

**Where formula.js was wrong, the function is written here.** formula.js was tried first for each.
Five of its answers differed from Excel's, and those five are native:
- LOOKUP's array form answered with the value found, not the one beside it.
- TIME did not wrap past 24 hours.
- TIMEVALUE could not read "6:30 PM".
- NUMBERVALUE could not read "3.5%".
- FREQUENCY answered in a row, where Excel answers in a column.

**The fix.**
- The legacy names are aliases of the functions they became (`SAME_AS`).
- The engine tells formulas whether a row is hidden, and by what, and whether a cell holds a
  formula.
- LET gives values names in the evaluator's scope.
- INDIRECT reads the reference its text names through the evaluator.

**Driven.** Six formulas were typed into the Budget sample's Scenarios sheet before and after the
deploy. E2:E4 hold 12,000, 15,000 and 9,000.

| Cell | Formula | Before | After (Excel) |
| --- | --- | --- | --- |
| K1 | `=STDEV(E2:E4)` | #NAME? | 3,000 |
| K2 | `=SUBTOTAL(9,E2:E4)` | #NAME? | 36,000 |
| K3 | `=LET(x,E2,y,E3,x+y)` | #NAME? | 27,000 |
| K4 | `=TEXTAFTER("a-b-c","-",-1)` | #NAME? | c |
| K5 | `=INDIRECT("E"&3)` | #NAME? | 15,000 |
| K6 | `=RANK(E4,E2:E4)` | #NAME? | 3 |

The Scenarios filter was then turned on (Ctrl+Shift+L) and "Worst" unticked. K2 went to 27,000, and
STDEV in K1 stayed 3,000, as Excel's does. Clearing the filter brought K2 back to 36,000.

### 2026-09-29 — Array formulas, and the whole-column arithmetic gap

The user asked for the gap R140 left open: arithmetic over a whole column worked only on the rows
the sheet uses. Before fixing it, 24 array formulas people use every day were checked, each against
the answer Excel gives. 15 were wrong, all silently. There were three causes.

Tests: `tests/unit/sheetsArrays.test.ts` (13). The mutation run caught 16 of 16; the control
survived. All 22 Sheets suites pass, and the sample workbooks' figures did not move.

#### R144 · S1 · A function of one value, given a range, looked only at the range's first cell

`ISBLANK`, `ISNUMBER`, `ISTEXT`, `ISERROR`, `NOT`, the rounding and text functions, and the date
parts all took an array's first element. So a whole family of idioms gave a number with no error:
- `SUMPRODUCT(--ISNUMBER(SEARCH("an",A1:A5)))` gave 0 where Excel gives 1.
- `SUMPRODUCT(--ISBLANK(A1:A5))` gave 0 where Excel gives 2.

The one-value argument of functions that take ranges had the same problem:
- `MATCH`, `XMATCH`, `XLOOKUP`, `VLOOKUP` and `HLOOKUP`'s lookup value;
- the criteria of `COUNTIF(S)`, `SUMIF(S)`, `AVERAGEIF(S)`, `MINIFS` and `MAXIFS`.

So `SUM(COUNTIF(A:A,{"Best","Worst"}))` counted only "Best".

**The fix.** The evaluator lifts those arguments, as Excel does. `LIFTS` in `functions.ts` says which
argument of which function takes one value. Given an array there, the function answers for each
element, with Excel's broadcasting. Arguments that take ranges on purpose never lift: SUM's,
INDEX's first, TEXTJOIN's, N's.

#### R145 · S1 · IF over a range took each branch's first value

With a range for its condition, IF answered each element with the FIRST value of the branch it
chose, not the value in the same place:
- `MAX(IF(A1:A3<>"banana",B1:B3))` gave 10 where Excel gives 30.
- `TEXTJOIN(",",TRUE,IF(B1:B3>15,A1:A3,""))` gave "apple,apple" where Excel gives "banana,cherry".

`IFERROR` had the same flaw with an array fallback, and `IFNA` did not work over an array at all.

**The fix.** IF, IFERROR and IFNA combine the condition and both branches element by element.

#### R146 · S2 · Arithmetic over a whole column left out the blank rows past the data

`SUMPRODUCT(--(A:A=""))` was 0 where Excel gives 1,048,573. `SUM(--(A:A=""))`, `COUNT(IF(A:A="",1))`
and `SUMPRODUCT(ISBLANK(A:A)*1)` gave the same wrong answer. `MATCH(TRUE,INDEX(A:A="",0),0)`, the
usual way to find the first empty row, said #N/A.

The engine reads a whole column only as far as the sheet is used, which is right: a million cells
per reference would make every recalculation slow. What was missing is that the rest is not
nothing. Each of those blank rows goes through the same arithmetic.

**The fix** (`src/lib/sheets/formula/arrays.ts`):
- **The tail.** A whole column now carries its blank rest as a *tail*: how many rows, and one line
  holding what each of them holds.
- **Carrying it.** Operators, IF, the lifted functions and INDEX's whole-column slices carry the
  tail along, updating that one line.
- **Counting it.** SUMPRODUCT, SUM, PRODUCT, AVERAGE, MIN, MAX, MEDIAN, COUNT, COUNTA, AND, OR,
  XOR, ROWS, COLUMNS, INDEX and MATCH count it without building it. The cost is one line per
  array, whatever the column's length.
- **Lining up.** Whole columns of sheets used to different depths are lined up first.
  `(A:A="apple")*(T!B:B)` used to give #N/A in the rows one sheet did not reach.
- **Spilling.** A whole column spilled into the grid still shows only the rows the sheet uses.

**Driven.** Five formulas were typed in the Budget sample's Scenarios sheet (A2:A4 Base, Best,
Worst; E2:E4 12,000, 15,000, 9,000):

| Formula | Before | After (Excel) |
| --- | --- | --- |
| `=SUMPRODUCT(--ISNUMBER(SEARCH("st",A2:A4)))` (R144) | 0 | 2 |
| `=MIN(IF(A2:A4<>"Base",E2:E4))` (R145) | 12,000 | 9,000 |
| `=SUMPRODUCT(--(A:A=""))` (R146) | 1 | 1,048,572 |
| `=MATCH(TRUE,INDEX(A:A="",0),0)` (R146) | 5 | 5 |
| `=SUM(COUNTIF(A:A,{"Best","Worst"}))` (R144) | 1 | 2 |

The Sales sample's Dashboard read the same figures before and after.

### 2026-09-28 — Sample workbooks (Phase I), and four found checking them against Python

Three sample workbooks now ship in `public/samples/sheets/` and open from **Samples to explore** on
the Sheets page (see [Sheets → Sample workbooks](./SHEETS.md#sample-workbooks)):
- Sales performance 2026;
- Project tracker;
- Budget and cash flow.

They are real .xlsx files. `scripts/make-sheets-samples.ts` writes them with the app's own engine
and Excel writer (`npm run sheets:samples`), and refuses to write a file in which any formula errs.
A sample opens through the same import as any Excel file, so it becomes the person's own workbook.

**How they were checked.** Nothing about a sample was taken from the app itself:
- openpyxl opened each file.
- Python recomputed 41 figures from the files' own rows: revenue, margin and order counts; totals
  by month, region, category and rep; task counts and hours; the budget model under every scenario.
- The two sets of figures were compared.
- Two figures disagreed at first. That led to R140 and to a fix in the sample.

`tests/unit/sheetsSamples.test.ts` reads each committed file back with the app's reader and keeps
those figures. It also fails if any chart covers a filled cell. `tests/unit/sheetsWholeRanges.test.ts`
covers R140 and R142. The mutation run caught 13 of 13 for R140–R142 and the samples; the control
survived. The layout check (R143) failed on the files as they were before the fix.

#### R140 · S2 · Whole columns were only as long as the data: ROWS(A:A) was 3, COUNTBLANK(A:A) 0

The engine reads a whole column (`A:A`) only as far as the sheet is used, which is right for
SUM. But the functions that see the blank rest took the used part for the whole:

| Formula | Excel | Before |
| --- | --- | --- |
| `ROWS(A:A)` | 1,048,576 | 3 |
| `COLUMNS(1:1)` | 16,384 | 2 |
| `COUNTBLANK(A:A)` | 1,048,573 | 0 |
| `COUNTIF(A:A,"<>x")` | 1,048,575 | 2 |
| `INDEX(A:A,100)` | an empty cell | #REF! |
| `SUMIFS(T!B:B,A:A,"a")`, two sheets used to different depths | 5 | #VALUE! (ranges differ in size) |

**How it was found.** The sample's order count, `=COUNTIFS(Orders!L:L,"<>Returned")`, gave 229
where Python counted 228 orders. The formula was wrong too:
- In the app, it counted the header.
- In Excel, it would have counted every blank row as well, over a million.

**The fix.**
- `ROWS`, `COLUMNS`, `COUNTBLANK` and `COUNTIF(S)` add the blank tail of a whole range. COUNTIFS
  adds it only when every criterion takes a blank.
- `INDEX` past the used rows gives an empty cell.
- Whole columns read together are padded with blanks to the longest.
- The sample now counts `=COUNTIFS(Orders!A:A,"SO-*",Orders!L:L,"<>Returned")`.

Arithmetic over a whole column (`SUMPRODUCT(--(A:A<>"x"))`) still works on the used rows; it is in
the queue.

**After**, typed into the Budget sample's Scenarios sheet: `=ROWS(A:A)` 1,048,576;
`=COUNTBLANK(A:A)` 1,048,572; `=COUNTIF(A:A,"<>Base")` 1,048,575.

#### R141 · S2 · A chart whose first column was dates drew the dates as a series

The sample's "Revenue by month and region" chart has months in its first column, as
`=DATE(2026,m,1)` formatted "mmm". The chart drew them as a fifth series, a flat line at about
46,000 (the dates' serial numbers), over an axis numbered 1 to 12. The stacked columns carried a
"Month" block on top. `chartLayout` took only a first column of text as the categories. Excel takes
a first column of dates too. The .xlsx writer uses the same layout, so the file's chart was wrong in
Excel as well.

**The fix.** `chartLayout` is given each cell's number format. A first column whose numbers are all
dates is the category axis, while plain numbers, or a mix, stay a series as in Excel. The grid's
charts, the chart dialog and the .xlsx writer all pass the formats.

**After:**
- The workbook imported before the fix now draws four regions over Jan to Dec. The layout is
  worked out as the chart is drawn, so no stored workbook needs changing.
- In the regenerated file, the chart has four series over `Dashboard!$A$9:$A$20`.

#### R142 · S2 · A formula whose answer was an empty cell showed nothing, where Excel shows 0

`=A500`, and `=INDEX(A:A,500)` after R140, showed an empty cell. In Excel both show 0: the value is
0, so ISNUMBER on it is TRUE, COUNT counts it, and a chart plots 0. The gaps of a spilled range
(`=A1:A3` over a blank A2) are 0 in Excel too.

**The fix.** The engine places an empty answer, or the empty cells of a spilled answer, as 0. Inside
a formula a blank stays blank (`ISBLANK(A500)` is TRUE, `COUNTA` skips it), and text that is empty
(`=IF(TRUE,"")`) stays text.

**After:** in the Scenarios sheet, H4 `=INDEX(A:A,500)` and H5 `=A500` show 0.

#### R143 · S3 · The sample dashboards hid their own figures under their charts

- The Project tracker's pie and radar charts sat over the owners' "Remaining (h)" column.
- The Sales dashboard's charts sat over the "Open orders over $3,000" list: 13 rows spilled from
  J18, and the charts started at row 22.
- The leaderboard's spilled figures showed as plain numbers under a first figure in dollars. Excel
  does the same with a file like that; the cells needed the format.

**The fix.**
- The generator places the charts right of the data, and below the list by its computed length.
- The spill cells carry the dollar format.
- The samples test fails if any chart covers a filled or spilled cell. It failed on the old files
  and passes on the new ones.

### 2026-09-28 — AI in Sheets (Phase H), and nine found driving it

A workbook now has an assistant beside the grid and **Fill with AI** (see
[Sheets → AI in a workbook](./SHEETS.md#ai-in-a-workbook)). The model never writes a cell. It asks
the workbook for reads, which the browser answers from the workbook as the person sees it, and it
ends with an answer and proposals the person applies, each one undoable.

The decisions:
- **The browser holds the workbook, so the browser runs the reads.** A viewer's share has already
  cut the sheets and rows the browser holds, so the model can read only what the person can.
  Nothing on the server re-reads the workbook for the model.
- **The server holds the model.** `SHEETS_ASSIST_MODEL` is an admin setting, and the input schema
  has no model field. Every call goes through the chat channel as the person: IAM model rules,
  budget, the trace and the cost apply. `SHEETS_ASSIST_PER_MINUTE` bounds each person's calls.
- **Who may ask.** Asking needs view access, and Fill with AI needs edit. View as asks as the
  share, and its proposals show as View only.
- **Proposals are plans first.** `planAction` works out a proposal's cell edits, rule, chart or
  sheet before anything changes, and the editor carries it out as one undo step. After R132–R134,
  the answer's proposals are checked against the workbook before they are shown.

Tests: `tests/unit/sheetsAssist.test.ts` (41):
- the protocol;
- the reads, against a real engine;
- the description the model starts from;
- every proposal kind;
- the proposal check;
- the server functions, on mocks.

`tests/unit/chatStream.test.ts` gained R136's two.

#### R131 · S2 · The assistant said it had changed the workbook when nothing had changed

The model's answers read "I've added a Revenue column…" while the proposals sat unapplied beneath.
Someone who took the answer at its word would close the panel with nothing done.

**The fix, in two parts:**
- The prompt says nothing changes until a proposal is applied, and tells the model never to say
  it changed anything.
- Whatever the model says, the panel now puts "Nothing has changed yet. Apply what you want (each
  one undoes with Ctrl+Z):" above any proposal not yet applied. A viewer instead sees that the
  proposals would change a workbook shared with them to view.

**After:** the next answer read "I will add…", with the note above its proposals.

#### R132 · S3 · A chart proposed over two blocks of cells failed at Apply with "not a range"

Asked to chart revenue by region without the units column, the model proposed a chart over
`A1:A4,C1:C4`. Apply said it was not a range, which told the person nothing and left no way on.
A prompt rule alone did not stop it: the next answer proposed the same two blocks.

**The fix:**
- `oneRange` names two blocks as two ("is 2 separate blocks of cells; this takes one block, like
  A1:C4").
- `proposalProblems` checks every proposal of an answer against the workbook before it is
  offered, with `planAction` and changing nothing.
- When something cannot be done, the panel sends the reasons back to the model once and shows
  its second answer. The steps say so: "Checked the proposals: 1 could not be done as given;
  asked again".

**After:**
- The same question got the columns side by side first, as formulas (`=C2`), and a chart of
  E1:F4: West 44.5, East 51, North 47.25.
- A highlight asked for on a table sheet was sent back. The second answer said a table sheet
  cannot be highlighted and offered nothing that would fail.

#### R133 · S2 · The assistant offered formulas over a table sheet that could only show #VALUE!

Asked to highlight a table's high-revenue rows, the model's second answer (after R132's check)
offered a new sheet holding `=FILTER(BiDemoSales, BiDemoSales[revenue]>1000)`. It applied cleanly
and showed #VALUE!. A table sheet's rows never come into a grid, by design (see
[Formulas over table sheets](./SHEETS.md#formulas-over-table-sheets-in-grid-sheets)), and the model
had never been told that.

**The fix, in two parts:**
- The prompt lists the functions the lakehouse computes over a table. The list is built from the
  evaluator's own set (`TABLE_PUSHDOWN`), so the two cannot drift. It also says FILTER, SORT,
  UNIQUE and a bare column show #VALUE!, and points to the table sheet's filter instead.
- The proposal check computes each proposed formula where it would sit, up to
  `MAX_CHECKED_FORMULAS` (50) per answer. An error that comes from the formula itself is sent back
  with the engine's own explanation: #NAME?, or a table column read whole. Errors that depend on
  the data, such as #DIV/0!, are left alone.

**After:** "Make a new sheet … that lists the BiDemoSales rows with revenue over 600, using FILTER"
got an answer that said FILTER over a table sheet would show #VALUE!. It offered
`=SUMIFS(BiDemoSales[revenue], BiDemoSales[revenue], ">600")`, which read 21,547.09. The Lakehouse
gave 21,547.09 over 28 rows for `revenue > 600`.

#### R134 · S3 · "Explain this formula" offered the cell's own formula as a change

After explaining `=VLOOKUP("Dee",C2:F9,2,FALSE)` in Sales!H2, the answer offered "Put
=VLOOKUP("Dee",C2:F9,2,FALSE) in Sales!H2". That is exactly what H2 held, so applying it would have
done nothing.

**The fix:**
- The proposal check sends back an edit that leaves every cell as it is.
- The explain hint tells the model never to propose the formula the cell already holds.

**After:** explaining H2 again gave the explanation and a proposal that changes something (`C:F`,
for a range that grows).

#### R135 · S2 · Fill with AI wrote blanks when the model left the brackets off its answer

The trial on five feedback comments showed five blanks. The trace showed the model had answered
all five correctly, as `{"i": 0, "o": "negative"}, {"i": 1, "o": "neutral"}, …`, without the `[ ]`
around them. The parser needed an array, so every answer was lost. The server still said `ok`, so
**Fill 5 rows** would have written the blanks and closed.

**The fix:**
- The answers are read wherever they stand: an array, or `{"i", "o"}` objects on their own.
- An answer with nothing readable in it is an error that says nothing was written.

**After:** the same trial read negative, neutral, positive, negative, neutral.

#### R136 · S2 · Every internal model call reported no cost: AI functions in SQL, document OCR, Sheets

Found reading R135's response: the call cost $0.00028 on the trace, but the server function
returned no cost. `readChatStream` in `internalChat.server.ts` looked for `{"type":"cost"}` data
frames, which the channel never sends. It also stopped at `[DONE]`, and the channel's `event: cost`
frame comes after it. So every caller got a null cost:
- AI functions in SQL (their stats `cost_usd`);
- document OCR;
- Sheets.

The trace rows and the budget were right, because the channel records them itself. What was lost
was the figure shown to the person.

**The fix.** The helper reads the stream with the shared reader the swarm executor already used
(`src/lib/chatStream.ts`).

**After:**
- The fill's response carries `cost: 0.0002315`.
- The assistant shows "Cost $0.0017" under an answer.
- The Lakehouse's AI-functions badge gives a cost for an `ai_sentiment` query.

#### R137 · S3 · Fill with AI wrote past the column where the person had started answering

With "Sentiment" in C1 and "positive" typed in C2, Fill with AI chose column D. It took the first
empty column, and C was not empty. So the answer the person typed was not used as an example,
unless they noticed and changed the column by hand.

**The fix.** The default is now the first column right of the selection that is not already full.

**After:** the dialog opened on C with "1 already answered (used as examples)". With C full, it
opened on D.

#### R138 · S3 · Fill with AI wrote something other than the trial it had shown

The trial showed "neutral" for "Works as expected", under "The first 5, as they would be written".
**Fill 5 rows** then asked the model again for all five and wrote "positive". What was written was
not what had been shown and accepted, and those rows cost a second call.

**The fix.** The trial's answers are written as shown, and only the rows the trial did not cover
are asked (`afterTrial`). A change to the instruction or the column clears the trial, as before.

**After:** the fill wrote exactly the trial, and the page sent no request after the trial's.

#### R139 · S3 · View as carried the owner's conversation, reads of hidden rows included

The assistant panel stayed mounted across the switch to **View as**. The owner's earlier turns went
to the model with each View-as question, including its read of Sales!B2:F9 with the rows the share
hides. The model happened to answer from the viewer's view ("I couldn't find Dee"). But what View as
showed was no longer only what the share gives, and View as exists to check exactly that.

**The fix.** The panel is keyed on the workbook and the share, so each way of seeing a workbook
starts its own conversation.

**After:** View as opened an empty panel. "total units on Sales, by region" answered West 19, the
only region the share keeps.

The mutation run caught 17 of 17 (R131–R139); the control survived.

### 2026-09-28 — Sheets sharing (Phase G), and two found building it: a table opened as an "upload", and grid formulas over tables wrong on every opening

Sheets now shares a workbook with people or IAM groups, to view or to edit. A viewer's share can
leave sheets out and keep only some rows of a sheet (see [Sheets → Sharing](./SHEETS.md#sharing)).

The rules are in one place, `src/utils/sheets/access.server.ts`, and every Sheets server function
asks it. `tests/unit/sheetsSharing.test.ts` keeps that true: a new function that neither asks nor is
listed with a reason fails it.

The decisions:
- **Table sheets read the lakehouse as the reader.** The AI Analyst already works this way. Reading
  as the owner would have let a share skip the lakehouse's own row filters and column masks.
- **Where a viewer's rows are cut.**
  - A grid sheet's rows are cut before the sheet is sent.
  - A table sheet's rows are cut where its query starts (`restrict` in `buildTableRelation`), so
    pages, value lists, downloads, lookups, pivots and grid formulas all inherit the cut.
  - A table sheet's restriction can't come from a browser: the config schema refuses the field.
- **Several shares combine exactly.** A row is kept if any share keeps it. The earlier draft
  instead showed every row when two filters named different columns.
- **Imports into the lakehouse are the owner's.** Every sheet keeps the owner's `user_id`, so the
  Sheets-held-table guard and the row-level security on `sheet_tabs` stay right.
- **Sharing is audited by the server,** as `sheet.share` and `sheet.unshare`. A trigger could not
  do it: a service-role write has no actor, and a share row has no owner column.

Tests:
- `tests/unit/sheetsSharing.test.ts` (39): how shares combine; grid rows; the restriction run on
  DuckDB through pages, value lists, grid formulas, pivots and lookups; the share checks; who may
  do what, on a fake database; and the sweep of every function.
- The mutation run caught 24 of 24, with R129 and R130 included; the control survived.

#### R130 · S1 · Opening a workbook computed every grid formula over a table sheet as if there were no tables

The engine computes every formula as it is built. It asks the page's resolver whether a name is a
table sheet, and the resolver answered from the page's list of sheets, which was filled only after
the engine was built. So on every opening:
- `=COUNTA(Orders[region])` read **1** (the one error the unresolved name made, counted);
- `=SUM(Orders[revenue])` read **#VALUE!**;
- both stayed that way until the cell was typed again.

Adding a table sheet and renaming one had the same order, so formulas naming the new or renamed
table stayed wrong as well.

**How it was found.** In the sharing round, a direct load of a "View as" link read 1 where 36 was
right. Reaching the same view through the Share dialog read 36, because the page still held the
previous load's list of sheets.

**Driven, before.** In "Phase G sharing", Sheet1 had `=COUNTA(BiDemoSales[region])` in A1 and
`=SUM(BiDemoSales[revenue])` in A2. As typed they read 108 and 51,749.84; after a reload, 1 and
#VALUE!.

**After** (hot-deployed):
- A fresh load reads 108 and 51,749.84.
- Viewed as the share (EMEA only) it reads 36 and 15,524.94. The Lakehouse gives the same for
  `region = 'EMEA'`.

**The fix.** The page's list of sheets is set before the engine is built, before a sheet is added
to it, and before a renamed table's formulas are recomputed.

**Tests.** `tests/unit/sheetsTablesOnOpen.test.ts` covers the engine's side (a resolver that does
not yet know the tables gives 1) and pins the four orders.

#### R129 · S2 · Opening a table as a sheet could say it was an upload, and hold it

`sheetsAddTableTab` took the sheet's `origin` from the browser and stored it as sent: R127's shape,
on another path. A sheet opened over any table could therefore say it had uploaded it, and the
Lakehouse then refused writes to that table.

R127's rule that the sheet's owner must own the schema limited this to a person's own tables. With
sharing it would not have held. A sheet an editor adds belongs to the workbook's owner, so an
editor could have claimed a table in the owner's schema and locked the owner out of it. Found in
the sharing review, before sharing was committed.

**Driven, before** (the R128 build). In "R126 held table", `analytics.r104_keep2` was opened with a
fetch wrapper adding `origin: upload` to the app's own request. It was accepted, the sheet read
"from forged.csv", and `UPDATE analytics.r104_keep2 …` was refused as held by that sheet.

**After** (hot-deployed). The same request for `analytics.r104_keep` is refused: "Opening a table
can't say it was imported". No sheet is added. The forged sheet from the before-drive was deleted,
which released `r104_keep2`.

**The fix.** Opening a table accepts only an origin that makes no claim: a lakehouse table, or a
catalog entry.

### 2026-09-26 — Found making Sheets' tables read-only outside Sheets: a catalog name past every schema check, a sheet that could claim anyone's table, and three builders that wrote whatever held their name

Tables that Sheets makes show up in the Lakehouse, and the user asked that
they be changed only from Sheets. What was built: a table that a Sheets
table sheet holds its rows in is read-only everywhere else. That covers a
file uploaded into a table sheet, and rows imported from a connection.
Ownership is read live from the sheets (`sheet_tabs.table_config.origin` of
`upload` or `warehouse`). Deleting the sheet frees the table; restoring a
version holds it again. Every writer asks `sheetOwnedRefusal`
(`src/utils/sheets/owned.server.ts`) first:
- statements through `runLakehouseStatement` (the SQL editor, Insert row,
  Drop, workflow SQL steps, feature-view training sets);
- dropping a schema;
- an ETL pipeline's lakehouse target, before the run starts;
- an Iceberg import;
- a materialized view's refresh;
- a SQL model's build;
- a batch prediction.

The table's page says **Held by Sheets · workbook › sheet**, links to it,
and offers no Insert row or Drop. A failed read of the sheets refuses the
write rather than let it through. A table a sheet only opened stays
ordinary, and so does one made with Save to lakehouse. Three findings came
out of building it. Tests for all three: `tests/unit/lakehouseSheetGuard.test.ts`
(18), plus one in `tests/unit/mlBatchOutputTaken.test.ts`, which checks that a held output is
refused before anything else is asked. The mutation run caught 21 of 21, and the control survived.

#### R128 · S1 · A view's refresh, a SQL model's build and a batch prediction replaced a table Sheets held

All three write `CREATE OR REPLACE TABLE <their name>` on their own engine
connection (a prediction from its sandbox), past the statement path the
guard sits on. R101, R103 and R104 check the name when the view, model or
prediction is set up. Nothing checked it again when it wrote, and a free
name can be taken in between: a model saved and not yet built, or a view's
or an earlier prediction's table dropped, and a file then uploaded under
the name. R104 lets a prediction write over a table an earlier prediction
wrote (a daily schedule), whatever is at the name now. A model stored as a
view runs `DROP TABLE IF EXISTS` on the name first.

**Driven, before** (builds without the fix):
- **Model.** `later_rows` (`SELECT 1 AS model_col`, schema `r126_held`) was
  saved while the name was free. `later_rows.csv` (3 rows, `id, label`) was
  then uploaded to `r126_held.later_rows` as the sheet LaterRows. **Build this
  and what it reads** said "Built 1 model"; the table held one row,
  `model_col = 1`, and the sheet said "r126_held.later_rows has different
  columns now". The SQL editor refused every write to that table the whole
  time.
- **Prediction.** "revenue_facts model" scored `analytics.revenue_facts` into
  `r126_held.pred_probe` (836 rows). That table was dropped, and
  `pred_probe.csv` (4 rows) uploaded under the name as PredProbe. The same
  batch prediction then started and succeeded (836 rows), and the table lost
  its `label` column.

**After** (hot-deployed):
- **Model.** The build fails "1 failed, 0 skipped, 0 built" with the Sheets
  message, and the Builds tab records it. With the model changed to
  `SELECT 2`, a second build is refused too, and the table still reads 1.
- **View.** `r126_held.later_view` was saved and built, its table dropped,
  and `later_view.csv` uploaded under the name. The table page's **Rebuild**
  says "Rebuild failed: r126_held.later_view holds the rows of the sheet
  "LaterView"…", and the two uploaded rows stay. The BI prep refresh calls
  the same function.
- **Prediction.** The batch prediction into `r126_held.pred_probe` is refused
  in its dialog with the Sheets message, and no job starts.
- The view's before case was not driven: the shape and the one line are the
  model's.

#### R127 · S1 · A table sheet's saved settings could claim anyone's table, and the guard then locked its owner out

`sheetsSaveTableConfig` stored a table sheet's settings exactly as the
browser sent them, `source` and `origin` included. The `sheet_tabs` RLS
policy also lets a signed-in user update their own rows directly. So a
sheet could point at any table and say it had uploaded it. Before this round
that only put a false "from forged.csv" under the sheet's name. With the
guard, the named table refused every write from its own owner, their
pipelines and their schema drop. One user could freeze another's table
without being able to read it. Found while building the guard, before any of
it was committed.

**Driven, before** (the guard deployed, this fix not): in "R126 held table",
a table sheet was opened over `analytics.bi_demo_sales`, a table it only
reads. The app's own settings save (a sort) was sent with its origin changed
to an upload of `forged.csv` by a fetch wrapper in the page. The save was
accepted, the sheet read "from forged.csv", and the Lakehouse refused
`UPDATE analytics.bi_demo_sales …` as held by that sheet.
**After** (hot-deployed): deleting that sheet released the table. The same
forged save on a new sheet was accepted with the sort kept and the origin
not: after a reload the sheet reads plain `analytics.bi_demo_sales`, and the
UPDATE runs. Real uploads (`analytics.orders_jan_feb_2024`,
`r126_held.held_rows`) are still held.

**The fix**, two layers:
- **The save.** It keeps the stored `source` and `origin`. Only the server
  paths that make a sheet set them.
- **The claim.** It counts only when the sheet's owner owns the table's
  schema, which every import requires. This is the layer that matters,
  because the RLS policy lets a user write their own rows without the
  server. A claim on someone else's table holds nothing, and a failed read
  of the schemas refuses the write.

**Not driven:** locking out another account needs a second account. The tests
hold it.

#### R126 · S1 · `lake.schema.table` walked past every check keyed on the schema

The lakehouse catalog is attached as `lake`, so the engine takes three-part
names. The statement classifier and the reference parser read the first two
parts as schema and table. `CREATE TABLE lake.ice_sales.t` was authorized as
schema "lake", table "ice_sales", and written into `ice_sales`. Anyone who
owned a schema named `lake` could get past every check keyed on the schema:
read-only mounts, other people's schemas, row and column policies, and the
Sheets guard.

**Driven, before:** with a schema `lake` made from New schema,
`CREATE TABLE ice_sales.r126_probe` was refused (a read-only Iceberg mount).
`CREATE TABLE lake.ice_sales.r126_probe AS SELECT 1 AS x` ran and made the
table; it was dropped again, then the schema.
**After** (hot-deployed, `lake` made again):
- `CREATE TABLE lake.ice_sales.r126_probe AS SELECT 1 AS x` is refused as a
  read-only Iceberg mount.
- `UPDATE lake.analytics.orders_jan_feb_2024 …` gets the Sheets refusal.
- `DROP TABLE memory.main.r126_other` is refused ("not the lakehouse").
- `SELECT count(*) FROM lake.analytics.orders_jan_feb_2024` still reads.
- `CREATE TABLE lake.lake.r126_ok AS SELECT 1 AS x` runs into the caller's
  own schema, and drops.

`lake` was dropped afterwards. While a schema named `lake` exists, DuckDB
itself calls `lake.r126_ok` ambiguous.

**The fix.** A third part names the table, and the first must be `lake`; any
other catalog is refused. For what a write reads, `lake.s.t` is schema `s`.
A name in any other catalog becomes a schema name no schema can have, so the
access check refuses it.

### 2026-09-25 — Found testing Sheets rules: an hourly reload that ate edits, keys that went to the wrong place, and a dollar amount that stayed text

#### R125 · S1 · Every session refresh put the saved copy back over what people were editing, in 21 places

The session's access token changes on every refresh: about hourly, and when
a tab regains focus near expiry. R120 found a Sheets load keyed on it, which
rebuilt the editor from the saved copy each time. A sweep of every hook
keyed on the token found the same shape in 21 more places.

The worst were:
- **Three editors: ETL pipelines, BI reports and workflows.** Each silently
  reverted unsaved steps, blocks and names. The ETL editor's Save button stayed
  enabled, so the next save wrote the older copy over the work.
- **The admin runtime settings.** Every tab's unsaved fields reverted, and the
  save bar then said there was nothing to save.
- **Two "copy this key now" dialogs (a model's and a notebook's).** The
  one-time plaintext of a new API key vanished with the dialog still open.
  The key stayed valid but could never be shown again.

The rest:
- the IAM model-rules draft;
- the audit retention box;
- the lakehouse layout dialog;
- the ML approvers, fairness, operating-point, outcome-source, deployment and
  experiment-note fields;
- the BI Git sync settings;
- a connection import's table pick;
- two typed delete confirmations;
- a Sheets table sheet's selection and loaded rows;
- the BI explore dialog's sort and page.

Two needed more than the token taken out, because the refresh re-renders the
page and they were also keyed on something new on every render:
- **The table sheet's loader was keyed on the workbook object**, which is new
  on every render of the page around it. Any save finishing started the sheet
  over as well.
- **The explore dialog's query was keyed on a fresh `[]`** that the dashboard
  passed for "no drill path" on every render.

**How it was found.** `}, [token` matched 32 hooks in 19 files. It missed
every dependency list whose first entry is not the token (`[id, token]`) and
every list Prettier put on its own line. The complete scan matches any
dependency list naming the token, however it is laid out. Every hook it
matched was read for one question: can its re-run replace something the
user is editing? The 93 still keyed on the token after the fix only re-read
what the user sees: lists, options for a picker, a status.

**Driven, before and after**:
- Forcing a refresh: each case set the stored session to expire in five
  seconds and signalled the tab visible; supabase-js refreshed within 2–30 s.
- Driven in both builds (unsaved edits, then the refresh), 14 in all:
  - the ETL editor (a renamed pipeline and a new Filter node);
  - the report designer (a new name and a fifth heading);
  - the workflow editor (a new name and a SQL step, with its inspector open);
  - the runtime settings (45 and 80 typed into two limits);
  - the audit retention box (30 typed);
  - the layout dialog (two keys, 256 MB, keep clustered);
  - the IAM rules draft (a rule added);
  - calibration (the 0.50 line picked);
  - fairness (two columns ticked and "2" typed);
  - the approvers box (two example.com addresses);
  - both API-key dialogs (a key created, its banner on screen);
  - a table sheet's selection (four cells);
  - the explore dialog (sorted by Country, page 3).
- **Before** (builds without the fix): every one reverted to the saved state,
  or lost its selection or banner.
- **After** (hot-deployed fix): every one kept what it had. Picking another
  workflow still loads it. The IAM page's own Refresh button now leaves an
  unsaved rules draft alone too, because the draft starts again only when that
  principal's saved rules change. The four test keys were revoked.
- **Not driven in the UI.** This account has no outcome source, no warm
  deployment, no experiments, no database connection, no saved Git config
  and no dataset with dependents. The fix there is the same line and the
  test pins it.

**The fix.** A `useTokenRef` hook: the load reads `tokenRef.current` when it
calls the server and is keyed on `signedIn`, which changes only on sign-in
and sign-out. The table sheet reads the workbook through a ref too, and the
explore dialog keys its query on what the drill path and cross-filter say.

**Tests.** `tests/unit/tokenReloadSweep.test.ts`:
- It pins each of the 26 fixed dependency lists.
- It ratchets the 93 reviewed ones per file, so a new hook keyed on the token
  fails until someone has read it.
- The mutation run caught 29 of 29, the control survived.

#### R124 · S2 · In the dark theme, a filled cell's text could not be read

A cell with a fill and no text color of its own took the theme's text
color. In the dark theme that is near white, on fills that are almost always
light: the pink of a "greater than" rule, a pale header from an Excel file.
The values were there and could not be read. Excel's automatic text color
is black, which is why these fills are chosen light.

**Driven, before**: "Sheets E2E Cells & Versions (Phase F)" in the dark
theme → C2 and D2 (20, 30, pink from a rule) showed near-white text on pink;
the gallery's thumbnails did the same. **After** (hot-deployed): C2 reads
`rgb(31, 31, 31)` on `rgb(255, 199, 206)`. A cell filled with no text color
of its own now takes dark text on a light fill and white on a dark one
(where black and white contrast equally, by WCAG luminance), in the grid and
in the thumbnails. Tests: `tests/unit/sheetsInk.test.ts`.

#### R123 · S3 · Ctrl+B in Sheets made the cells bold and opened the app's sidebar too

The app's sidebar toggles on Ctrl+B (and `Ctrl+\`) through a listener on the
window. The grid handles Ctrl+B as bold, as Excel does, and marks the key as
handled, but the sidebar's listener ignored that and toggled anyway. Every
Ctrl+B in a workbook opened or closed the sidebar, and the grid reflowed
under the pointer. Anyone formatting a sheet presses it constantly.

**Driven, before** (hot-deployed gallery build): a new workbook → A1:B1 →
Ctrl+B → the headers bold and the sidebar expanded; Ctrl+B again → bold off,
the sidebar collapsed. **After**: A1:B1 → Ctrl+B three times → bold on, off,
on, the sidebar collapsed throughout; in a cell being edited (F2), Ctrl+B
leaves the sidebar alone; with the page focused rather than the grid,
Ctrl+B still opens and closes the sidebar. The sidebar now leaves alone a
key that what has focus already handled. Tests:
`tests/unit/sidebarShortcut.test.ts` (mutants removing the check, or
restoring the old test in the listener, are caught).

#### R122 · S1 · The Sheets page said "edited 4h ago" of a workbook edited a minute earlier

A workbook's "edited" time on the Sheets page, and the order the page lists
workbooks in (most recently edited first), came from the workbook row's
`updated_at`. That moved only when the workbook row itself changed (a
rename, a restore). Every cell edit, sheet added or rule changed writes the
sheet row (`sheet_tabs`) and left the workbook row alone. So a workbook
worked on all afternoon said "edited 4h ago" and stayed below ones nobody
had touched. The claim was a true sentence about the wrong row. It was in
the page since Sheets first shipped; asking for a better gallery is what
led to reading where "edited" came from.

**Driven, before** (the image built for Phase E, with Phase F hot-deployed):
"Sheets E2E Rules (Phase D)" → K6 → 7, 7, Enter → "All changes saved" → ←
Sheets. The card still read "edited 4h ago", fourth in the list. The rows:
the sheet "Orders Q3" updated at 19:12:13, the workbook at 15:36:59.
**After** (rebuilt image, migration applied): Phase D → K6 → Delete → ← Sheets: the card read
"2s ago" and led the list; a thumbnail written a second after an edit left
the workbook's time on the edit (20:18:11.2 edited, 20:18:12.0 thumbnail),
and deleting a workbook through its card menu ran the new trigger under a
cascade without error. The migration's own clock was held off: Phase D read
19:12:13 (its last sheet change) after it ran, not the migration's time.

A change to a sheet (its cells, table definition, name, kind or place, a
sheet added or deleted) now touches its workbook through a trigger on
`sheet_tabs`. A migration moved every existing workbook's time forward to
its last sheet change, holding off the workbook's own `now()` trigger for
that one statement. The gallery's thumbnails are kept in a table of their
own, so drawing one is not counted as an edit.

#### R121 · S2 · Typing in a filter's search box typed into the active cell instead

A popover drawn over the grid (a filter column's menu, a validation list, a
link's buttons) is rendered in a portal elsewhere in the page, but React
bubbles its events up the component tree, not the DOM, so every key pressed
in it reached the grid's key handler. A letter typed in the filter's Search
box started editing the active cell, the menu closed, and the search box
stayed empty; the value box of a filter condition did the same; Enter on a
choice in a validation list moved the selection instead of picking it. The
first round missed it because the test tool inserted text without keydown
events; pressing real keys showed it.

**Driven, before** (the image built for Phase D): Orders Q3 → Region's
filter button → click Search → press N, o → the menu closed, cell H8 was
open for editing holding "No", the search box never had it. Alt+Down on H5
→ Down, Down → "Paid" focused → Enter → the list stayed open, H5 unchanged.
**After** (rebuilt image): the same keys → the search box reads "No" and
the menu lists only North; Down, Enter in the list picks Shipped and closes
it; a filter condition's box takes 4000 as typed. The grid's handler now ignores a key whose
target is not inside the grid's own DOM. Test:
`tests/unit/sheetsGridKeys.test.ts` (a mutation removing the check is caught).

#### R120 · S1 · A session refresh reloaded the workbook and threw away the edit not yet saved

The workbook page loaded the workbook in a callback that listed the session's
access token among its dependencies. The token changes every time the
session refreshes (about hourly, and when a tab regains focus near expiry),
so every refresh loaded the workbook again and rebuilt the editor from the
saved copy. An edit made in the second before its save (a conditional
format, a typed value) vanished; the selection jumped to A1; the badge said
"All changes saved"; and the save already queued wrote the older state back
over the change. This was in the page since Sheets first shipped.

**Driven, before** ("Sheets E2E Rules (Phase D)", Orders Q3): selected
I2:I21 → Conditional → Data bars → Blue → the bars drew and the toast said
"Rule added to I2:I21"; moments later the view was back at A1 with no bars,
the badge read "All changes saved", and the network showed a workbook load
(sheetsGet) returning the sheet's grid with `cells` only, then a save. The
stored session had been issued 105 s earlier, which matches the refresh.
Adding the same rule again, with no refresh in between, kept it.

**After** (the fixed build): the page loads the workbook once per workbook
and reads the token through a ref when it calls the server. Forced a refresh
(the stored session's expiry moved to 15 s ahead, then a visibility change):
the token changed after 5 s; no workbook load followed, the selection stayed
on J7, and every rule and value stayed. Test:
`tests/unit/sheetsReloadOnToken.test.ts`. The same `[token]` pattern is in 19
other files; which of them hold unsaved edits is a separate task (queue).

#### R119 · S3 · A negative dollar amount typed as -$350.00 stayed text

Typing `-$350.00` (or `$-350`) left a text cell, left-aligned, that SUM
skips; Excel reads it as the number -350 in a dollar format. The number
parser stripped a currency sign only at the very start, before a minus.

**Driven, before:** Long sheet names (R118), Sheet2!B1 typed `-$350.00` →
left-aligned text; its CSV wrote `'-$350.00` (defused as formula-looking
text). **After:** Orders Q3!K2 typed `-$350.00` → right-aligned `-$350.00`,
`=K2*2` → -700; Download this sheet as CSV → `-350` and `-700`. The parser
takes a sign on either side of the currency sign, and `-$350.00`, `$-350.00`
and `($350.00)` all pick up the dollar format. Test: `tests/unit/sheetsOps.test.ts`.

### 2026-09-25 — Found building Excel downloads: sheet names Excel cannot hold

#### R118 · S2 · A sheet name over 31 characters broke the downloaded workbook

Sheets allows a sheet name of up to 100 characters; Excel allows 31. ExcelJS
cut a longer name when writing the file without telling anyone, so every
formula on another sheet that named it still used the full name, which the
file does not have: in Excel those formulas point at a sheet that is not
there. Two long names that start with the same 31 characters were worse:
the second collided with the first once cut, and the download failed.

**Driven, before** (workbook "Long sheet names (R118)"): Sheet1 renamed to
"Quarterly revenue by region and product line" (44 characters), A1 = 5;
Sheet2!A1 = `='Quarterly revenue by region and product line'!A1*2` (shows 10).
File → Download as Excel → the file's sheets were
`Quarterly revenue by region and` and `Sheet2`, and Sheet2's formula was
still `'Quarterly revenue by region and product line'!A1*2`. A third sheet
named "Quarterly revenue by region and product line, prior year" →
Download → toast "Could not download: Worksheet name already exists:
Quarterly revenue by region and"; no file.

**After:** the same workbook on the rebuilt image → File → Download as Excel →
"Downloaded the workbook"; openpyxl reads the sheets `Quarterly revenue by region and`,
`Sheet2` and `Quarterly revenue by region (2)` (31, 6 and 31 characters), and Sheet2!A1 is
`='Quarterly revenue by region and'!A1*2`, whose saved value is 10.

The writer now names each sheet for the file (`excelSheetNames`: the
characters Excel refuses become spaces, the name is cut to 31, and a
collision gets " (2)" within the 31), and rewrites every formula that names
a shortened sheet (`renameSheetInFormula`) before writing it. Tests:
`tests/unit/sheetsXlsx.test.ts` ("cuts a sheet name to Excel's 31
characters, and the formulas that use it"); two mutants in the Excel/CSV
mutation run.

### 2026-09-25 — Found building Sheets formatting: where the keyboard goes after a menu or a dialog

#### R117 · S2 · Every text prompt in the app opened on its Cancel button

`promptAsk` (the shared replacement for `window.prompt`) renders a Radix
AlertDialog with an `autoFocus` text box. An AlertDialog focuses its Cancel
button when it opens, after React has run `autoFocus`, so the box never had
the keyboard: typing went nowhere and Enter pressed Cancel. Every prompt was
affected: Rename sheet, Row height, Custom number format, and the other
callers across the app. A mouse user who clicked into the box never noticed.

**Driven, before:** Sheets, ribbon → Number format → Custom… →
`document.activeElement` was the Cancel button; typing a format code then
Enter closed the dialog with nothing applied. **After:** the same path → the
text box has focus with its text selected; typing
`"$"#,##0.00;[Red]-"$"#,##0.00` and Enter applied it (B3 red). Rename sheet
from the tab menu → the box focused with "Sheet1" selected; typing "Summary",
Enter → the tab reads Summary.

The dialog's `onOpenAutoFocus` now puts focus in the text box when it asks
for text; a yes/no confirmation keeps Radix's Cancel default. Test:
`tests/unit/confirmDialogFocus.test.ts`.

#### R116 · S2 · A stray Enter blanked a cell

The grid keeps a hidden textarea on the active cell so that text arriving
without a keydown (an IME, dictation) starts an edit. When a dialog's button
was pressed with Enter, the button closed the dialog on keydown and focus
came back to the grid before the key's input landed, so the textarea
received a line break, an edit started holding only a line break, and the
next click committed it: B2's 1200 became an empty cell with Wrap on and the
total dropped to $2,130.00.

**Driven, before:** the Custom format prompt (on its Cancel button, R117),
Enter → the cell editor was open on B2 with value `"\n"`; clicking another
cell committed it. **After:** a bare line break reaching the textarea no
longer starts an edit (`startsEdit` in `src/lib/sheets/selection.ts`); the
same sequence leaves B2 as it was. Test: `tests/unit/sheetsFormatting.test.ts`.

#### R115 · S3 · After a context-menu action the keyboard fell to the page

Choosing any item in the grid's right-click menu unmounted the button that
held focus, so focus went to `<body>`: Ctrl+Z, arrows and typing did nothing
until the grid was clicked again.

**Driven, before** (the committed image): right-click B3 → Insert 1 row
above → Ctrl+Z → nothing; `document.activeElement` was BODY. **After:** the
menu hands the keyboard back to the grid before running the action (a
dialog the action opens takes it and returns it). The same steps → Ctrl+Z
restored the row. Ribbon menus and the color palettes do the same through
`onCloseAutoFocus`, unless the item opened a dialog.

### 2026-09-25 — Found building Sheets: a semicolon in a string, a cached clock, and escapes shown as text

#### R112 · S2 · A ";" inside a string literal was refused as a second statement

`classifyStatement` refused any statement whose text contained ";", after
stripping comments but not string literals. `SELECT 'north; south' AS
regions` was refused in the Query editor with "One statement per request —
split multi-statement SQL", and so was every other place a user's text
reaches a lakehouse statement as a literal: a Sheets calculated column
`TEXTJOIN("; ", …)`, a filter on a value with a semicolon in it.

**Driven, before:** Query editor, `SELECT 'north; south' AS regions` → the
refusal above. **After** (host build on the running app, then the image):
`SELECT 'north; south' AS regions, concat_ws('; ', 'a', 'b') AS joined` →
`1 row(s)`: `north; south · a; b`.

The check now reads `blankLiterals(sql)` (new in `sqlRefs.ts`): comments
blanked by the existing literal-aware scanner, then the insides of single-
and double-quoted literals and `$$…$$` blanked, indices kept. A real second
statement (`SELECT 'x'; DROP TABLE a.t`, `SELECT 'a'''; DROP …`) is still
refused. Tests: `tests/unit/lakehouseSqlShape.test.ts`.

#### R113 · S2 · `SELECT now()` answered with the first run's time for ten minutes

The lakehouse result cache keys on the user, the statement and the current
snapshot. None of those changes when the clock does, so a statement calling
`now()`, `current_date`, `random()` or `gen_random_uuid()` was served its
first answer until the entry expired (ten minutes) or a write moved the
snapshot. Nothing on the page said the answer was cached.

**Driven, before:** Query editor, `SELECT strftime(now(), '%H:%M:%S.%f') AS t`
run six times over fifteen seconds → `08:01:18.491288` all six times.
**After:** six runs → `08:28:01.29`, `08:28:03.80`, `08:28:06.80`,
`08:28:09.73`, `08:28:12.71`, `08:28:15.74`.

`callsVolatileFunction(sql)` (the same literal-blanked text, so
`SELECT 'now()'` still caches) now keeps such a statement out of the cache
lookup, which is also the only place a result is stored. Sheets pass
`useCache: false` for a table whose calculated columns call TODAY() or
NOW(). Tests: `tests/unit/lakehouseSqlShape.test.ts`, including a pin that
the guard sits in the block that sets the cache slot.

#### R114 · S3 · The catalog showed `\u2014` where it meant a dash

Three places in `CatalogView.tsx` wrote the escape in JSX text, where it is
not an escape: the asset panel's status select read "Certified \u2014
trusted for analysis" and "Deprecated \u2014 avoid using", the empty column
panel "No column metadata \u2014", and the profile's range "min\u2013max".
Seen on the asset `analytics.sheets_revenue_by_region_v2` registered from
Sheets. A scan of every `.tsx` for a `\u` escape outside a string found
these four and no others.

### 2026-09-25 — Read-only, until it was written to, and gone when the catalog was

#### R111 · S1 · An Iceberg mount took writes the dialog calls impossible, and removing its catalog dropped them unannounced

Queued in R104, where ML batch scoring's output check was found to refuse a
data-lake mount but not an Iceberg one. The question behind it was wider:
which writers know that an Iceberg mount is read-only? The mount dialog
promises "mount one of its namespaces as a read-only schema", and most of
the lakehouse's writers check `lake_source_id || iceberg_catalog_id`. The
one that matters most did not. The statement guard in
`runLakehouseStatement` is what every SQL write goes through: the Query
editor, feature training sets, agents' SQL, notebooks. It refused writes
through a data-lake mount only. So a "read-only" Iceberg mount took
`CREATE TABLE`.

That table then sat in a schema the product treats as disposable.
Removing an Iceberg catalog drops each of its mounts with `DROP SCHEMA …
CASCADE`, under a confirm that says only "Its N mounted schema(s) go with
it. Tables in the catalog itself are untouched." A lakehouse table
written into a mount went with the views, and nothing said it would.

ML batch scoring had its own copy of the rule, with the same gap. Its
"Output schema (yours)" picker listed every schema that had a table, so
it offered all eight `ice_*` mounts on this account. "Save as view" had
a picker that filtered only data-lake mounts. The server refused there,
but only after the owner picked the schema.

**Driven, before the fix** (image `abd4e27a1a31`). To keep `local_rest`
and its mounts out of it, a second catalog was registered for the round
on the same endpoint:

- Iceberg → Add catalog `r111_rest` (`http://192.168.1.85:8181`, `s3://iceberg/`,
  no authentication) → "Registered r111_rest: 2 namespaces". Mount `r107`
  as `ice_r111` → "Mounted 2 tables".
- Query: `CREATE TABLE ice_r111.r111_written AS SELECT 1 AS id, 'written
  into a read-only mount' AS note` succeeded. `SELECT id, note FROM
  ice_r111.r111_written` read back `1 · written into a read-only mount`.
- Remove `r111_rest` → the confirm "Remove "r111_rest"? Its 1 mounted
  schema(s) go with it. Tables in the catalog itself are untouched." →
  Remove. The same SELECT then answered "No access to schema "ice_r111"".
  The DuckLake catalog shows `r111_written` created at snapshot 559
  (04:50:21 UTC) and ended at snapshot 560 (04:51:07 UTC), the snapshot
  that also ended the schema `ice_r111`.
- ML Models → "revenue_facts plan classifier" → Predictions → Batch
  prediction. "Output schema (yours)" offered `analytics`,
  `ice_r107_after`, `ice_r107_final`, `ice_r107_fixed`, `ice_r107_four`,
  `ice_r107_regress`, `ice_r107_three`, `ice_r107_two` and `ice_sales`.

**Staged for the after-drive, on the old image.** Once fixed, the guard
would refuse to put a table into a mount, but a table written before the
fix still has to be protected. So a second throwaway catalog was set up
first: `r111b_rest`, mounting `r107` as `ice_r111b`, into which
`r111b_kept` was written (`1 · kept in a mount before the fix`).

**Driven, after the fix.** The guard and the pickers were driven on image
`5c76a79c3e5c`; the removal was driven on `321d1a9f4ad9`, which rewords its
refusal:

- Query: `CREATE TABLE ice_r111b.r111_after …` and `INSERT INTO
  ice_r111b.r111b_kept …` each answered "Schema "ice_r111b" is a
  read-only Iceberg mount — query it, or write to a regular schema.
  Publish to Iceberg puts a table into the catalog." Reading the mount
  still worked.
- Batch prediction on "revenue_facts plan classifier": "Output schema
  (yours)" offered `analytics` alone. The input picker still lists the
  mounts' tables, which are fine to read. "Save as view" offered
  `analytics` alone.
- Remove `r111b_rest` → the same confirm → Remove → "Not removed:
  ice_r111b.r111b_kept is a table of your own inside a mounted schema,
  and would be dropped with it. Copy it to a regular schema first (CREATE
  TABLE analytics.… AS SELECT * FROM ice_r111b.r111b_kept), then drop the
  mounted schema in the explorer, which says every table in it goes." The
  catalog stayed, and the table still read its row.
- That way out was followed. `CREATE TABLE analytics.r111b_kept_copy AS
  SELECT * FROM ice_r111b.r111b_kept` read back the row. The explorer
  listed `ice_r111b (3)` with `r111b_kept · 817 B` beside the two views.
  "Drop schema "ice_r111b"? Every table in it is dropped too." → "Dropped
  ice_r111b".
- A mount of views only does not block a removal. `r107` was mounted
  again as `ice_r111c`, then Remove `r111b_rest` → "Removed r111b_rest".

The changes:

- **The statement guard.** It refuses a write through an Iceberg mount as
  it does through a data-lake mount: "Schema "…" is a read-only Iceberg
  mount — query it, or write to a regular schema. Publish to Iceberg puts
  a table into the catalog."
- **ML batch scoring.** Its output check refuses Iceberg mounts too.
- **The pickers.** The ML sources call returns the schemas that can take a
  table (owned, and not a mount of either kind). The batch and schedule
  dialogs offer only those. "Save as view" drops Iceberg mounts from its
  picker.
- **Removing a catalog.** It now looks for real tables inside each mount
  first, since a mount holds only views. It refuses while there is one,
  naming it: "Not removed: … is a table of your own inside a mounted
  schema, and would be dropped with it." It also refuses when it cannot
  check, or cannot list the mounts. That protects tables written before
  this fix.

**Tests:** 10.

Behavioural, against the real guard with a mocked schema list:

- `CREATE TABLE`, `INSERT` and `DROP VIEW` in an Iceberg mount are
  refused.
- The refusal names Publish to Iceberg.
- A data-lake mount is still refused as before.

Anchored in the source:

- ML scoring refuses an Iceberg mount as output.
- The ML pickers take the writable list.
- "Save as view" filters Iceberg mounts.
- A catalog removal checks for tables before it drops anything, and
  refuses when it cannot check.

10 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-25 — My First Swarm, again

#### R110 · S2 · A failed read of the swarm list made a new swarm and opened it in place of the one asked for

Found by the sweep R109 queued: a read of a whole document whose error is
dropped. The swarm canvas starts by reading the owner's swarms, their
knowledge bases and their agents, in parallel, and it kept none of the
three errors. A refused list read came back as `rows = []`. For an owner
with no swarms, the canvas creates one, so it inserted "My First Swarm"
and opened it. That happened whatever swarm the URL asked for, and it
said nothing. The owner saw an empty canvas where their swarm should be,
under a name they never chose, and the gallery kept the new row. It never
overwrites the swarm that was asked for, because a Save goes to the new
row, but it looks exactly like the swarm has been lost.

Two smaller paths sat beside it:

- Switching swarms from the canvas dropped its read's error and simply
  did not switch.
- A URL naming a swarm that is not in the list opened the first swarm
  in the list, without a word.

**Driven, before the fix** (image `b1409a24ad3d`). The gallery listed 18
swarms. The canvas's list read (`GET swarms?select=*&order=created_at.asc`)
was refused from the browser with a 503, and Open was pressed on "R109
chat echo" (`d10c86c5`):

- postgrest-js tried four times, and then the canvas made a `POST
  swarms` (201).
- The URL still said `?swarm=d10c86c5-…`, but the canvas was "My First
  Swarm", 0 nodes, "Start wiring your swarm", with no toast.
- Back in the gallery: 19 swarms. "My First Swarm" was new at the top,
  and "R109 chat echo" was unchanged with its 2 nodes.

**Driven, after the fix** (image `abd4e27a1a31`), from the same gallery
of 19:

- The same refused list read and Open on "R109 chat echo": four refused
  reads and no `POST`. The canvas area said "Could not load your swarms"
  and "R110 injected: the GET did not reach the database. Nothing was
  opened or created, and your swarms are as you left them.", with "Try
  again" and "Back to gallery".
- With the fault lifted, "Try again" read the list (`GET` 200) and opened
  "R109 chat echo" with its 2 nodes.
- A URL naming a swarm that does not exist (`00000000-…-000000000110`)
  gave the toast "That swarm is not in your list · Opened "Swarm 1"
  instead."
- The gallery still listed 19, with the one "My First Swarm" the
  before-drive had made.

What the canvas opens first is now decided by `chooseInitialSwarm`
(`lib/swarmInitialLoad.ts`), from the list AND its error:

- **A list that could not be read.** Nothing is opened and nothing is
  created. The canvas says "Could not load your swarms", then the reason
  and "Nothing was opened or created, and your swarms are as you left
  them.", with "Try again" and "Back to gallery".
- **The swarm asked for.** It is opened.
- **A swarm asked for that is not in the list.** The toast says "That
  swarm is not in your list", and says which swarm was opened instead.
- **An owner who really has no swarms.** They still get "My First
  Swarm". Its insert now reads its answer.

A failed read of the knowledge bases or agents says their pickers stay
empty. A switch that could not read the other swarm says "Could not open
that swarm", and stays where it was.

**Tests:** 8. The decision itself is tested:

- A failed read opens and creates nothing, even with a swarm asked for.
- The swarm asked for is opened.
- A missing one opens the first swarm, marked as missing.
- A first swarm is made only for an empty list.
- With no swarm asked for, the first one in the list opens.

Anchored in the canvas source:

- The list's error decides before any `applySwarmRow` or `.insert(`.
- "Try again" loads again.
- A failed switch says so.

8 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-25 — One message, and the conversation before it was gone

#### R109 · S1 · A swarm chat opened through a failed read saved the next message over its whole transcript

The write survey closed in R72 left the swarm chat dialog's insert and
update as noted, on the grounds that they "reload from the table after
the write and so cannot show a phantom row". That is true of the chat
list, but the list is all they reload. The thread on screen is not
reloaded. The read that opens a conversation was never looked at either.

"Chat with this swarm" (the canvas's Chat button) keeps a swarm's
conversations in `swarm_chats`, and saves the whole transcript after
every turn. Three of its four database calls dropped the answer:

- **Opening a conversation** (`selectChat`) read its messages and state,
  ignored the error, and selected the conversation anyway, over
  `data?.messages ?? []`. A read that failed showed an empty thread with
  that conversation highlighted. The next message then saved
  `[question, reply]` over the stored row: the whole transcript and its
  carried flow-state, replaced by one turn.
- **A turn's save** into an existing conversation was an update that
  never read its answer. The turn stayed on screen, and it was gone when
  the conversation was reopened.
- **The first save of a new conversation** was an insert that never read
  its answer. The conversation stayed on screen, was missing from the
  list, and nothing said so.

The list read also turned a failure into "No conversations yet."

**Driven, before the fix** (image `57b70c28882f`), on a swarm made for the
purpose: "R109 chat echo", an Input and an Output, so every reply is the
message itself and no model is called. The failures were injected from
the browser, which reaches these calls because they are direct PostgREST
requests; each refused call answered 503 with `R109 injected`.

- "R109 turn one", then "R109 turn two": saved as chat `c7a47254`, with
  four messages.
- New chat, then the conversation opened with its read refused.
  postgrest-js tried four times. Then the conversation was highlighted
  over "Start the conversation below.", with no error.
- The fault was lifted, as a passing blip lifts, and "R109 after a failed
  read" was sent. It went out as a `PATCH` of `c7a47254`, and the list
  retitled it "R109 after a failed read".
- The dialog was closed, reopened, and the conversation opened with a
  clean read: two messages, "R109 after a failed read" and its reply.
  Turns one and two were gone from the database.
- With the update refused, "R109 unsaved turn" appeared with its reply
  and no error. Reopened, the conversation did not have it.
- In a new chat, with the insert refused, "R109 never saved" appeared
  with its reply and no error, and the list did not gain it.

**Driven, after the fix** (image `b7d8cdf59b82`), on the same swarm and
chat, which now held "R109 after a failed read" and "R109 after turn A":

- New chat, then the conversation opened with its read refused. Four
  attempts, then the toast "Could not open that conversation · R109
  injected: the GET did not reach the database. You are still in the
  conversation you had open.". The conversation was not selected.
- The fault was lifted, and "R109 after a refused read" was sent. It went
  out as a `POST`, a new conversation. Opened cleanly, `c7a47254` still
  held all four of its messages.
- With the update refused, "R109 turn B, refused save" showed "Not saved:
  R109 injected: the PATCH did not reach the database What you see here
  since the last save is gone when you leave this conversation.", with
  "Save again". Pressed with the fault lifted, it went out as a `PATCH`
  (200), and the notice went away. Reopened, the conversation held six
  messages, turn B among them.
- With the insert refused, "R109 insert refused" showed the same notice,
  and the list did not gain it. "Save again" went out as a `POST` (201),
  and the list gained it, selected.
- With the list read refused, reopening the dialog showed "Could not load
  conversations: R109 injected: the GET did not reach the database", over
  the last list it had read.

The notice ran the error into the next sentence ("…the database What you
see here…"). An error without a final stop now gets one. On a rebuild
(image `b1409a24ad3d`), a refused save of "R109 turn C, refused save"
read "Not saved: R109 injected: the PATCH did not reach the database.
What you see here since the last save is gone when you leave this
conversation.". "Save again" saved it (`PATCH` 200), and it read back
with all eight messages.

The reads and saves now live in `lib/swarmChatStore.ts`, and each one
returns what happened:

- **Opening a conversation.** `openChat` returns the transcript, or why
  it could not be read, and whether the conversation is gone. It never
  returns an empty stand-in. The dialog enters a conversation only once
  its read has succeeded. On a failure it says "Could not open that
  conversation · `<why>`. You are still in the conversation you had
  open.", or that the conversation no longer exists.
- **Saving a turn.** `saveChat` updates by id and asks for the row back.
  An update that reaches no row is not a save: the conversation was
  deleted elsewhere, and the next save keeps it as a new one. An insert
  that errs or returns no id is not a save either.
- **A failed save** puts "Not saved: `<why>`. What you see here since the
  last save is gone when you leave this conversation." under the thread,
  with a "Save again" button. The next turn's save, which writes the
  whole transcript, also clears it.
- **A list that could not be loaded** says "Could not load conversations:
  `<why>`".

**Not changed.** Leaving a conversation while a turn is running still
aborts that turn, as before, and the aborted turn's save still follows
whichever conversation is selected when it lands. Whether that can write
into the wrong conversation is queued.

**Tests:** 13, against a fake client that answers each call the way the
test names, and anchored in the dialog's source:

- A refused read is reported and never becomes an empty transcript.
- A missing row is gone, and a found row returns its transcript and
  state.
- An update goes by id and asks for its row back. A refused update is
  reported, and one that reached no row is not a save.
- An insert carries its owner and swarm. A refused insert, or one that
  returned no id, is not a save.
- The dialog enters a conversation only after the read's check, and
  returns on a failure.
- A failed save sets the notice and offers "Save again".
- A list that could not be loaded is not shown as empty.
- An error gets its final stop before the next sentence.

13 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-25 — Running, for nineteen hours, while it waited for a person

#### R108 · S2 · Recent runs showed a run parked at an approval as "Running", and offered nothing that could end it

Found while reading the browser writes that R106 queued. `cancelByDbRunId`
cancels a run only while it is `running`, which made me ask what else the
Recent runs panel (Agent Swarms → Recent runs) could be showing.

Since the checkpoint work, a run that reaches a human-approval step on the
server (from the API, a schedule or a webhook) parks with the status
`suspended`. The panel's badge knew five words: `running`, `waiting`,
`success`, `error` and `cancelled`. Any other word fell through to
`map.running`, so a parked run read "Running", with the running icon. It
was left out of the panel's own `ACTIVE` set, so it got no Cancel. Its
duration was the time since it started, so it grew by the minute. All of
this sat under a header that said "Cancel a running or paused run here."
What ends a parked run is a decision on its approval, and nothing on the
row said so.

R92 had seen four of these rows read "Running" and traced them to the
forked resume it fixed, which was real. The display rule was left as it
was, and it applies to every parked run, including the ones whose
approvals are still pending today.

**Driven, before the fix** (image `b413a02e6aad`), on runs earlier rounds
left parked on purpose:

- Swarm Observability listed five runs of "Approval durability check
  (schedule)" as `suspended`, started Sep 24 at 01:38:29, 01:59:23,
  02:27:57, 03:00:02 and 04:04:38. The header showed "Pending approvals
  (5)".
- Agent Swarms → Recent runs at 23:40:14 showed the same five runs as
  `Running`, with durations of `1321m 35s`, `1300m 42s`, `1272m 8s`,
  `1240m 3s` and `1175m 26s`. Each row offered only Open and Trace. The
  runs that finished around them read `Error` with `3 steps`, which was
  correct.

**The first fix went one step too far, and the drive showed where.** It
read every `suspended` run as "Awaiting approval", with a "Review approval"
button that opens the approvals inbox. On image `0bbcf3e09334`, the five
rows above read that way, and the button opened the inbox with "Pending
Approvals 5", paused 20h, 21h, 21h, 22h and 22h ago, one for each.
Further down the list, four more rows read the same. Their approvals were
nowhere in the inbox. They are R92's runs (`3bf09de5` and three others
from Sep 23): their approvals were decided before R92's fix, and their
work finished under a separate `(api)` run. No approval is waiting for
them, so "Awaiting approval" and a button to an inbox that does not hold
them were a new untruth for exactly those rows. `suspended` alone cannot
say whether anyone is still being asked. The approval row can, and the
executor writes it with the run owner's id, so the owner can always read
it. A second pass (image `a5d418394794`) read the requests. The five
pending runs kept "Awaiting approval", and the four read "Decided, not
resumed" with no button, but they still showed `45h 30m` to `46h 51m`.
Hiding the duration only for runs awaiting a decision had missed them.
A duration is time spent running, so it now shows only for a run that is
live or has finished.

**Driven, after the fix** (image `57b70c28882f`), on the same runs, at
00:41:53:

- The five read `Awaiting approval`, started 20h to 23h ago, each with
  "Review approval" and no duration.
- The four read `Decided, not resumed`, started 1d ago, with no duration
  and no button. The two in view sit directly under `(api) · Success · 5s
  · 3 steps` rows, the runs that hold their work.
- The panel's other 21 rows (7 Error, 14 Success) read as before.
- "Review approval" on a row opened the inbox, `Pending Approvals 5`,
  paused 20h, 21h, 22h, 22h and 23h ago.

Nothing was approved or rejected, and the parked runs stay as fixtures.

The panel now takes every status rule from one table
(`lib/swarmRunStatus.ts`). For the parked runs on screen, it also reads
their approval requests:

- **A pending request.** The run reads "Awaiting approval", with the
  hourglass. It is not polled, and it is not offered a Cancel that could
  not reach it. Its row carries "Review approval", which opens the
  approvals inbox, where the decision that ends it is made.
- **Requests that were all decided, with the run still parked.** It reads
  "Decided, not resumed", with nothing pointing to an inbox that no
  longer holds it.
- **No request at all.** This is R90's failed insert. The run reads
  "Parked, nobody asked".
- **Requests that could not be read.** The row says only "Parked", and
  keeps the button to the inbox.

The rest of the panel:

- No parked run shows a duration. A duration is shown only for a run
  that is live or has finished: the time since a parked run started says
  nothing about it.
- A run waiting at an approval inside this tab keeps its Cancel, because
  Cancel does reach a run held in this tab.
- A status the panel does not know reads as itself, never as "Running".
- Durations of an hour or more read in hours: `19h 35m`, not `1175m 26s`.
- The header says what is true: "Cancel a running run here; a run waiting
  for an approval goes on or stops when the approval is decided."

**Not changed, and queued.** Nothing cancels a parked run outright. If
anything ever does, it has to close the checkpoint and the approval with
it. `resumeApprovedSwarmRun` stops only for `success` and `error`, so a
run marked `cancelled` with its checkpoint still there would be resumed by
a later approval. The four "Decided, not resumed" rows also still hold
their checkpoints, as R92 recorded; nothing in the UI can resume them
again, because the inbox resumes only from a pending request.

**Tests:** 16, most on the status table itself and some anchored in the
panel and inbox source:

- A parked run with a pending request reads "Awaiting approval", is
  neither live nor cancellable, and awaits a decision.
- A decided request, no request, and an unreadable request each read as
  what they are.
- A second approval step that is pending wins over a first that was
  decided.
- No parked run is ever cancellable or live.
- The in-tab wait stays cancellable.
- Every status the executor writes has a view of its own.
- An unknown status reads as itself.
- A duration shows for a live or finished run, and never for a parked
  one.
- Hours read as hours.
- The panel reads the requests, marks a failed read, and lets the requests
  decide.
- A parked row opens the inbox and shows no duration.
- The inbox listens for a row's request.

19 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-24 — The replace that left nothing

#### R107 · S1 · Publishing to Iceberg with "Replace" dropped the table before it knew it could write the new one

Queued by R106. The Lakehouse's "Publish to Iceberg" writes a lakehouse
table into a registered Iceberg REST catalog. Its "If it exists" choice
offers "Refuse (keep the existing table)" or "Replace it (drop, then
create)". The DuckDB Iceberg extension has no `CREATE OR REPLACE`, so
replace was exactly what the label says: `DROP TABLE IF EXISTS <target>`,
then `CREATE TABLE <target> AS SELECT * FROM <source>`, two statements in
that order. When the create failed, the catalog was left with no table at
all. The owner had asked to replace the table, not to remove it, and
Spark, Trino and Snowflake reading the catalog lost it. A create fails
easily: a source column the Iceberg writer cannot store, a catalog or
storage error, a policy on the source.

**Driven, before the fix** (image `987d1ff3b46c`), on tables and a
namespace made for the purpose:

- `CREATE TABLE analytics.r107_src AS SELECT 1 AS id, 'published' AS
  note`, and `CREATE TABLE analytics.r107_bad AS SELECT 2 AS id, INTERVAL
  1 DAY AS span`.
- A probe, with no drop involved: `r107_bad` → Publish to Iceberg →
  catalog `local_rest`, namespace `r107`, table `r107_probe`, Refuse →
  `Invalid Input Error: Column type INTERVAL is not a valid Iceberg Type.`
- `r107_src` → Publish → `r107` / `r107_pub`, Refuse → `Published 1
  row(s) to r107.r107_pub`. Publishing it again with Refuse gave `Catalog
  Error: Table with name "r107_pub" already exists`, so the table was
  there.
- `r107_bad` → Publish → `r107` / `r107_pub`, Replace it (drop, then
  create) → `Invalid Input Error: Column type INTERVAL is not a valid
  Iceberg Type.`
- Iceberg → Mount a namespace → `local_rest` / `r107` as `ice_r107` →
  `Mounted 0 tables`. The published table was gone, and nothing had
  replaced it.

**The first fix had a flaw of its own, and a drive found it.** It staged
the new data under a fixed name, `<table>__publishing`, and began each
replace by dropping any table of that name "left behind by an interrupted
replace". A fixed name is a name somebody can own. On that build (image
`d071cd16aab0`) the failed replace above now kept the table (`Mounted 1
table`), and a good one worked (`Published 2 row(s)`). Then `r107_src`
published with Refuse as `r107/r107_pub__publishing` (`Published 1
row(s)`, and a mount read `Mounted 2 tables`). Replacing `r107_pub` from
`analytics.r107_src2` dropped that table first. The catalog logged
`Dropped table: r107.r107_pub__publishing`, then used the name for its
staging copy and dropped it again at the end. The next mount read
`Mounted 1 table`. The replace had destroyed a table the owner never
named, which is the defect this round set out to remove, moved to a
different table.

The same drive met a catalog-side fault. For two attempts the catalog
answered HTTP 500 to every `DELETE`: `[SQLITE_BUSY] The database file is
locked`, in the SQLite store of the development catalog
(`tabulario/iceberg-rest`). Creates still succeeded. The owner's table
survived those two attempts only because of the lock. A lock held between
HTTP requests is inside the catalog server, not in anything this app
holds. Restarting that one container cleared it, and its state lives on a
volume, so both tables were still listed afterwards. The fault also
showed a gap in the fix: when the catalog refuses the drop of the old
table, the old table stands, and the staging copy was left behind.

**Driven, after the fix** (image `b413a02e6aad`), with the owner's table
put back first:

- `r107_src` published with Refuse as `r107/r107_pub__publishing` gave
  `Published 1 row(s)`.
- `r107_bad` → Replace `r107_pub` → the INTERVAL error. The catalog's log
  shows the staging name `r107_pub__publishing_4482b342` looked up, never
  created, and nothing dropped. Mount `ice_r107_fixed` → `Mounted 2
  tables`.
- `r107_src` → Replace `r107_pub` → `Published 1 row(s) to
  r107.r107_pub`. The catalog's log, in order: committed
  `r107_pub__publishing_81ccfb38`, dropped `r107_pub`, committed
  `r107_pub`, dropped `r107_pub__publishing_81ccfb38`.
- Mount `ice_r107_final` → `Mounted 2 tables`. Through that mount,
  `r107_pub` reads `1 published`, and so does the owner's
  `r107_pub__publishing`, untouched.

The refused drop of the old table was not driven again. The catalog lock
that produced it cannot be brought on at will, so a test covers it.

A replace now stages the new data first, under a name made for that
publish alone: `<table>__publishing_<8 hex>`. Once that write has
succeeded, it drops the old table, fills the old name from the staged
copy (whose types the catalog has just accepted), and drops the staging
table. The only tables a replace ever drops are the one the owner named
and the one it has just created. A write that cannot happen fails before
anything is dropped. If the staged write or the drop of the old table
fails, the old table stands and the staging table is removed. That is
always safe, because the new data is still in the lakehouse. If the copy
into the old name fails in the narrow window after the drop, the error
says so and names the staging table that holds the new data. A failed
cleanup of the staging table is logged, and does not fail a publish that
has landed. `create` is unchanged. The cost is that a replace writes the
data twice.

**Tests:** 8 new, run against a fake engine that fails the statements each
test names:

- A staged write that fails leaves the old table undropped, and removes
  its own staging table.
- A refused drop of the old table removes the staging table.
- The new data is staged before the old table is dropped.
- A failed copy into the old name says where the new data is.
- A failed staging cleanup does not fail a publish that landed.
- The only tables dropped are the named one and one created earlier in
  the same publish.
- Two publishes stage under different names.
- `create` never drops.

The existing test of the publish SQL now pins the whole five-statement
replace, and pins that a replace without a staging name refuses. 11
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-24 — Deleted, said the page, of a dataset it still listed

#### R106 · S2 · The browser's dataset delete and replace did not read the database's answer

Found while finishing R101's sweep. The last unread writers were Data Prep's
"Run & save dataset" and the CSV upload. Both replace a dataset of the same
name, deliberately and recoverably: each snapshots the old rows as a
version first ("a re-upload of the wrong file is otherwise
unrecoverable"). They are CLEAR for that class. The Iceberg publish and
import are CLEAR too: "create" is a plain `CREATE TABLE`, and replacing
has to be picked by name. Reading the browser's copy of the dataset
writes, in `lib/sqlEngine.ts`, turned up the thing R87 fixed on the
server, still live here:

- **`deleteDataset`** ran `supabase.from("user_data_tables").delete()` and
  never looked at the answer. It dropped the table from the page's engine,
  and both callers then toasted `Deleted "<name>"`. That is the Data
  Catalog's workbench and BI's Data preparation. A delete that row-level
  security filters out is not an error either, just nothing removed, and
  it was treated the same way.
- **`saveDataset`**, replacing a dataset of the same name (the warehouse
  import's path), deleted the old rows and never checked. A failed delete
  left them, the new rows were appended below, and the dataset came out
  doubled under `Imported N rows`. That is R87 exactly, in the browser. The
  update of the dataset's details was unchecked too, and so was the lookup
  that decides between replacing and creating. A failed lookup read as "no
  such dataset" and created a second one of the same name.

**Driven, before the fix** (image `79cc1f0208c9`). BI → Data preparation
→ Local tables → `sftest_campaigns` onto the canvas → Flow name `r106
scratch`, Output table `r106_scratch` → Run & save dataset gave `Saved
"r106_scratch" with 4 rows`. The DELETE on `/rest/v1/user_data_tables`
was then made to answer 500 (`R106 injected: the delete did not reach the
database`). `r106_scratch` → Delete → the dialog (`1 thing depends on this
dataset…`) → type `r106_scratch` → Delete dataset. The one DELETE was
refused. The toast read `Deleted "r106_scratch"`, and the refreshed list
still showed `r106_scratch · 33 cols · 4 rows · prep` at its top.

**After the rebuild** (container `987d1ff3b46c`), the same page and the
same injected refusal:

- `r106_scratch` → Delete → confirm. The one DELETE (now asking for the
  row back, `select=id`) was refused. The toast read `"r106_scratch" was
  not deleted: R106 injected: the delete did not reach the database`. The
  dialog stayed open, and the list still showed the dataset, which was
  now the truth.
- With the refusal removed, the same dialog's Delete dataset gave
  `Deleted "r106_scratch"`, and the dataset left the list. After a
  reload, Local tables read 33, down from 34, and `r106_scratch` was not
  among them.

`deleteDataset` now asks for the deleted row back and counts it. An error
or an empty answer throws, and the page's engine table is dropped only
once the row is really gone. Both callers already hand a throw to the
dialog, which shows it and stays open. `saveDataset` checks the lookup,
the clear and the update, and stops before the insert when any of them
fails. So a replace can never append to rows it could not remove.

**Tests:** 8, run with the browser's database client and engine faked, so
they see every write and its order. A refused or empty delete throws and
leaves the page's table. A real one drops it after the row is gone. A
failed clear, a failed update or a failed lookup stops the save before
anything is appended, and a good replace clears before it writes. 6
behaviour-changing mutants each killed, control missed, baseline green
first.

`runAndSavePrep` in `lib/dataPrep.ts` is a third caller of `saveDataset`
with no callers of its own. It is dead code, left for a tidy-up.

### 2026-09-24 — The training set built over a table

#### R105 · S1 · A feature view's training set replaced a table it had not made

From R101's sweep, the last of its named writers. A feature view's
"Training set" joins a label table to the features that were true at each
label's moment, and writes the result with `CREATE OR REPLACE TABLE
<output>`. The build goes through the per-user statement guard, so the
caller must be allowed to write there. Nothing asked what was already at
the name. An existing table was replaced by the training set. So would the
label table be, or the view's own table: the two tables the next build has
to read.

**Driven, before the fix** (image `0be169f13e15`). ML Models → Feature
views → New view `r105_features`: table `analytics.revenue_facts`, key
`order_id`, latest row wins by `placed_at` → Create (`Created
r105_features`). A scratch `analytics.r105_keep` held `105 · not a training
set`, and a 20-row label table `analytics.r105_labels` held `order_id,
label_at`. Then Training set → Label table `r105_labels`, As of
`label_at`, key `order_id`, Write to `r105_keep` → Build. The toast read
`Built analytics.r105_keep — 20 row(s)`. `SELECT * FROM analytics.r105_keep`
then read back `order_id · label_at · net_usd · payment_rows · status ·
…`. The row and its columns were gone.

**After the rebuild** (container `79cc1f0208c9`):

- A fresh `analytics.r105_keep2` (`1052 · still not a training set`) as
  the output → Build → `analytics.r105_keep2 already exists, and no
  training set of yours wrote it. Building there would replace its rows
  with the training set. Pick a new output table, or drop that table first
  if replacing it is what you mean.`
- The label table as the output → `analytics.r105_labels is the label
  table. Building the training set there would replace the labels it is
  built from. Pick another output table.`
- Rebuilding a training set's own output is unchanged. Write to
  `r105_keep`, which the before-drive's build wrote → `Built
  analytics.r105_keep — 20 row(s)`.
- Read back: `r105_keep2` gave `still not a training set`, `r105_labels`
  gave 20 rows, and `r105_keep` gave 20.

`buildTrainingSet` now refuses the label table and the view's own table
outright, compared without case. It asks the lakehouse, through the shared
`lakehouseTableExists`, whether the output exists. If it does, the build
may replace it only if an earlier training set of the same user wrote that
exact table. The only record of that is the audit trail's
`feature_view.training_set` event, whose detail names the output. That
record is best-effort, so a rebuild whose earlier audit write failed is
refused, and says why. The refusal fails closed. An unreadable audit trail
or catalog refuses too.

**Tests:** 8, run with the catalog, the audit trail and the engine faked,
so they see whether the replacing statement would be sent. A foreign table
is refused. The audit trail is asked about this user's training-set
events for this exact output. An unreadable trail or catalog refuses. The
label table and the view's table are refused, whatever the case. A free
name builds, and a rebuild of the user's own training set builds. 9
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-24 — The predictions written over a table

#### R104 · S1 · A batch prediction replaced a table no prediction had made

From R101's sweep. A batch prediction runs in the sandbox, which writes the
scored rows with `CREATE OR REPLACE TABLE <output> AS SELECT * FROM _pred`.
Starting one (from a model's Predictions tab, the `/api/ml/predict/batch`
route, or a schedule) asked only whether the output schema was yours. The
dialog promises it "writes a new table you own". Given the name of an
existing table, it replaced that table with predictions. Nothing stopped
the output from being the input table itself either. With a row filter,
that replaced the scored table with only the rows the filter kept.

**Driven, before the fix** (image `cf409cf0925a`). Lakehouse → `CREATE
TABLE analytics.r104_keep AS SELECT 104 AS id, 'not a prediction' AS note`.
Then ML Models → `revenue_facts plan classifier` → Predictions → Batch
prediction → Input `analytics.revenue_facts`, Output schema `analytics`,
Output table `r104_keep`, version `v7 · logistic_regression · production`
→ Predict. The toast read `Batch prediction started`, and the job list
showed `succeeded · batch via ui · analytics.revenue_facts →
analytics.r104_keep · 836 · 10s`. A query for the table's own column
then failed: `Referenced column "note" not found … Candidate bindings:
"net_usd", "order_id", "proba_enterprise", "customer_id", "payment_rows"`.
`count(*)` was 836.

**After the rebuild** (container `0be169f13e15`):

- A fresh `analytics.r104_keep2` (`1042 · still not a prediction`) as the
  output → Predict. The dialog stayed open with `analytics.r104_keep2
  already exists, and no prediction of yours wrote it. Scoring into it
  would replace its rows with predictions. Pick a new output table, or drop
  that table first if replacing it is what you mean.`
- Output `revenue_facts`, the input itself, with the filter `region =
  'EMEA'` → `analytics.revenue_facts is the table being scored. Writing the
  predictions there would replace it with only the rows the filter keeps.
  Pick another output table.`
- Scoring again into its own output is unchanged. Output `r104_keep`,
  written by the before-drive's prediction, gave `Batch prediction
  started`, then `succeeded · 836 · 60s`.
- Read back: `r104_keep2` gave `still not a prediction`,
  `analytics.revenue_facts` kept 836 rows, and `r104_keep` held 836.

`startBatchPrediction`, which every door calls, now refuses an output that
is the input, compared without case. It asks the lakehouse, through the
shared `lakehouseTableExists`, whether the output exists. If it does, the
job may write there only when an earlier SUCCEEDED prediction of the same
user wrote that exact table, which is what a daily schedule does. A
failed or queued one never wrote it, and another user's cannot vouch for
yours. Either check failing refuses rather than guessing.

**Tests:** 8, run with the catalog, the prediction history and the sandbox
start faked, so they see whether a job would start. A foreign table is
refused. The history is asked about this user's succeeded writes to this
exact table. An unreadable history or catalog refuses. The input is never
the output, even when the case differs, and the refusal names the filter.
A free name and a re-score into a prediction's own table both start. 8
behaviour-changing mutants each killed, control missed, baseline green
first.

Seen while driving and queued rather than fixed: the output-schema picker
offers `ice_sales`, and the server's check refuses a data-lake mount but
not an Iceberg catalog schema. Every other writer refuses both.

### 2026-09-24 — The model that took a table's name

#### R103 · S1 · A SQL model named like an existing table dropped it

From R101's sweep, and the sharpest of it. A SQL model's name is its
target table, "as in dbt". A build first runs `DROP <the other shape> IF
EXISTS <target>`, so that a model switching between table and view is not
stuck, and then `CREATE OR REPLACE <shape> <target> AS <select>`. Saving a
model checked the name against materialized views ("is already a
materialized view"). It never checked it against the ordinary tables in
the schema. A model given the name of a table it had never built took
that table. Stored as a view, the model's build dropped the table
outright. Stored as a table, it replaced it.

**Driven, before the fix** (image `820d1915bef9`). Lakehouse → `CREATE
TABLE analytics.r103_keep AS SELECT 103 AS id, 'a table no model built' AS
note`, read back `103 · a table no model built`. Then SQL Models → New
model: Name `r103_keep`, Schema `analytics`, Stored as `View — the query
runs on every read`, SQL `SELECT 1 AS x` → Create gave the toast `Created
r103_keep`. Build this and what it reads gave `Built 1 model`, and the
run list showed `r103_keep · built · 1 rows`. `SELECT * FROM
analytics.r103_keep` then read back `x · 1`. The table and its row were
gone, dropped by the build, with a view in their place.

**After the rebuild** (container `cf409cf0925a`):

- `CREATE TABLE analytics.r103_keep2 AS SELECT 1032 AS id, 'still no model
  built this' AS note`. Then New model `r103_keep2`, `analytics`, View,
  `SELECT 1 AS x` → Create. The toast read `analytics.r103_keep2 already
  exists, and this model did not build it. Building the model would
  replace it (a view-stored model drops the table first). Give the model
  another name, or drop the table first if replacing it is what you mean.`
  No model was created.
- A model rebuilding its own target is unchanged. Opening `r103_keep` and
  changing its SQL to `SELECT 2 AS x` → Save gave `Saved r103_keep`. Build
  gave `Built 1 model`.
- Read back together, `analytics.r103_keep` gave `2` and
  `analytics.r103_keep2` gave `still no model built this`.

The save now asks the lakehouse, through R102's shared
`lakehouseTableExists`, whether the target is taken. It asks whenever the
target is new to this model: a new model, or one moved to another name or
schema. A model keeping the target it already has is rebuilding its own
output, and is not asked. Otherwise every existing model would be
refused on its next save. An unanswerable check refuses rather than
guessing the name is free. So does an unreadable answer from the
materialized-view clash check, whose error the code dropped.

Still open, and recorded in the queue: a table created at a model's target
AFTER the model was saved is still replaced by that model's next build.
Only the save is checked, because telling "the table this model built"
from "a table made there since" needs the build to leave a mark it can
recognise.

**Tests:** 7, source-anchored, because the save is a server function (the
check it calls is executed in `lakehouseImportNoReplace.test.ts`). The save
asks, refuses exactly when the answer is taken, and names the reason and
the way out. It asks only for a target new to the model, refuses when it
cannot tell, and decides before anything is written. The view-clash read
fails closed. 6 behaviour-changing mutants each killed, control missed,
baseline green first. The first run left one surviving: turning `if
(taken)` into `if (false)` passed, because the tests only proved the
message existed. The test now pins it to the branch.

### 2026-09-24 — The new table that was an old one

#### R102 · S1 · "New table → Import dataset" replaced an existing table

The first sibling from R101's sweep, and the plainest. Each schema in the
Lakehouse object explorer has a **New table** button. Its dialog, titled
"New table in <schema>", has two halves:

- **Define columns** runs `CREATE TABLE` through the per-user statement
  guard, and an existing name is refused.
- **Import dataset** pages a platform dataset out of the store and runs
  `CREATE OR REPLACE TABLE <schema>.<name> AS SELECT * FROM
  read_json_auto(...)` on a raw engine connection. An existing name was
  replaced, rows and columns, followed by "Table … ready".

The same write also skipped the rest of the guard it bypasses. The page
offers "New table" only on regular schemas, but the server function
never checked, so a direct call could write into a read-only data-lake
mount.

**Driven, before the fix** (image `91a6460a6a93`). `analytics.r101_keep2`
held `7 | still precious` after R101's after-drive. The schema's New table
(+) → Import dataset → Platform dataset `f1_constructor_standings` → Table
name `r101_keep2` → Import. The toasts read `Imported 10 row(s)` and `Table
analytics.r101_keep2 ready`. `SELECT * FROM analytics.r101_keep2` then
read back `wins · points · position · constructor · nationality`, starting
`14 · 833 · 1 · McLaren · British`. The previous row and columns were
gone.

**After the rebuild** (container `820d1915bef9`):

- A fresh table: `CREATE TABLE analytics.r102_keep AS SELECT 102 AS id,
  'untouched by the import' AS note`. Then New table → Import dataset →
  `f1_constructor_standings` → `r102_keep` → Import. The toast read
  `analytics.r102_keep already exists. Importing would replace its rows with
  this dataset. Pick a new name, or drop the table first if replacing it is
  what you mean.` The dialog stayed open, and `SELECT * FROM
  analytics.r102_keep` read back `102 · untouched by the import`.
- The same refusal for `r101_keep2`.
- A free name still imports. The same dataset → `r102_import` → `Imported
  10 row(s)` and `Table analytics.r102_import ready`, reading back 10 rows.
- R101's refusal, now through the shared check, still holds. Save as view
  onto `r102_keep` answered `analytics.r102_keep is an existing table, not
  a materialized view…`.

The import now refuses an existing name before it pages a single row out
of the store. The write itself is a plain `CREATE TABLE`, so a table
created between the check and the write makes the import fail rather than
be replaced. A mount or Iceberg schema is refused on the server, as the
page already implied. The existence check is one function,
`lakehouseTableExists` in `core.server`. The materialized-view save and the
import both call it. It compares without case and takes its connection as
a parameter, so it can be run against a fake engine.

**Tests:** 10 new, and R101's file adjusted to the shared check. Four run
the real check against a fake engine: it answers taken or free from the
catalog, it asks without case in the `lake` catalog and closes its
connection, and it quotes a hostile name rather than running it. Six are
source-anchored: the import asks, refuses with the reason, asks before
paging, writes with `CREATE TABLE`, refuses mounts, and uses the shared
check, which R101's save also uses. 6 behaviour-changing mutants each
killed, control missed, baseline green first.

The rest of R101's sweep list is in the queue with what each one already
does. The sharpest is the SQL model build, which runs `DROP <other shape>
IF EXISTS` on its target before replacing it.

### 2026-09-24 — The view that was saved over a table

#### R101 · S1 · "Save as view" replaced an existing table's data, and called it built

A materialized view is a query whose answer is kept as a real lakehouse
table. It is built, and rebuilt, with `CREATE OR REPLACE TABLE
<schema>.<name> AS <query>`. Saving one, from the Lakehouse page's "Save as
view" or Data Prep's "save to lakehouse", asked two things of the target:
is the schema yours, and is it a mount. It never asked what was already at
the name. Given the name of an ordinary table (an upload, an ETL output, a
table made in the workbench), the first build replaced that table's rows
and columns with the query's answer. It then reported success.

The queue sent this round to the materialized view for a different class,
a badge that outlives what it vouched for. That part checked out. A save
always rebuilds, and a failed rebuild sets `error`, while "Last rebuilt"
keeps the last good time, which is true. The overwrite sat on the same
path.

**Driven, before the fix** (image `5c5895ec55d0`), on a table made for the
purpose. Lakehouse → Query → `CREATE TABLE analytics.r101_keep AS SELECT 1
AS id, 'precious row' AS note` → Run (`Count 1`). `SELECT * FROM
analytics.r101_keep` read back `1 | precious row`. Then the editor got
`SELECT 42 AS answer` → Save as view → Schema `analytics`, Table name
`r101_keep`, Rebuild `manual` → Save and build. The toast read `Built
analytics.r101_keep — 1 row(s)`. `SELECT * FROM analytics.r101_keep` then
read back `answer | 42`. The row was gone, and so were both of its columns.
The dialog had said nothing about the name being taken.

**After the rebuild** (container `91a6460a6a93`):

- A second scratch table, `CREATE TABLE analytics.r101_keep2 AS SELECT 7 AS
  id, 'still precious' AS note`, read back `7 | still precious`. Then
  `SELECT 42 AS answer` → Save as view → `analytics` / `r101_keep2` /
  `manual` → Save and build. The toast read `analytics.r101_keep2 is an
  existing table, not a materialized view. Saving a view there would
  replace its rows with this query's answer. Pick a new name, or drop the
  table first if replacing it is what you mean.` The dialog stayed open,
  and the table read back `7 | still precious`.
- Redefining a view that IS one still works. `SELECT 43 AS answer` → Save
  as view → `analytics` / `r101_keep`, which the before-drive had
  registered as a view → `Built analytics.r101_keep — 1 row(s)`, and it
  read back `answer | 43`.

`saveMatviewForUser`, the one function both doors use, now looks before it
writes. A name that is already a registered view is a redefinition, which
is what the upsert is for. A name that exists as a table and is not a
view is refused, with the reason and the way out. The catalog is asked
without case, because DuckDB resolves identifiers that way, so a table
created as `Orders` is the one a view named `orders` would replace. When
the list of views cannot be read, the save is refused rather than guessed.
The scheduled rebuild of a registered view is unchanged: replacing its own
table is what it is for.

**Tests:** 6, run against a fake catalog and a fake engine that record
every statement sent. An existing table is refused by name, and nothing
that could replace it is sent and no view is recorded. The catalog is
asked without case. An unreadable view list refuses. A free name builds,
and an existing view is redefined even though its table exists. 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-24 — The first call after a quiet spell

#### R100 · S1 · Clients that gave up on a server while it was starting

MCP Builder servers scale to zero: after an idle timeout, 15 minutes by
default, the container stops, and the next call starts it again. This
instance's MCP endpoint gives that start up to 90 s before it answers 503.
Its own clients gave the first request far less. Agents and swarm Tool nodes
gave `initialize` 15 s, and Test connection gave it 12 s. The cold starts
measured while driving this took 17.7 s, 35.5 s, 23.4 s and 14.6 s. So the
first call after a quiet spell failed with "The operation was aborted due
to timeout". For an agent on a schedule that is most calls. The endpoint
went on to answer 200 to nobody and kept the session it had opened, which
no one would end. Test connection was worse: it wrote the result down, and
a server that was only asleep was marked **Error**.

The Deploy tab promised the opposite: "the server starts on the first call
(a few seconds)". The docs said the same.

This is the queue's "two timeouts that do not agree" class, which R98
showed was the wrong diagnosis for the deploy error. It is real here.

**Driven, before the fix** (image of R99, `52e61c76e4f1`):

- MCP Builder → `R99 hello` → Stop. Then Agent Swarms → `R99 MCP tool
  call` → the MCP Tool Call node → `{"name": "r100 before"}` → Test this
  node → Run node. After about 12.5 s it returned `{"error":"The operation
  was aborted due to timeout"}`. The endpoint's `initialize` was answered
  200 after 17.7 s, and the sandbox logged no DELETE.
- MCP Builder → Stop again. Then Integrations → MCP Servers → `R99 hello`
  (`● Active`) → Refresh. After about 11 s the toast read `Probe failed:
  The operation was aborted due to timeout`, and the card changed to
  `● Error`.

**After the rebuild** (container `5c5895ec55d0`), the same two paths with
the server stopped each time:

- **The swarm node**, `{"name": "r100 after"}`: `Hello, r100 after!` 28.4 s
  after the click. The endpoint logged `initialize` 200 after 23.4 s of cold
  start, then `initialized` (1.1 s) and the call (6.4 s, the fresh
  sandbox's first call). The sandbox logged `DELETE /mcp 200`, so the
  session was ended.
- **Refresh on MCP Servers**, with the card still reading `● Error` from
  the before-drive: after about 16 s the toast read `Discovered 2 tools`,
  and the card went back to `● Active · 2 tools`. The endpoint's
  `initialize` took 14.6 s, a cold start that the old 12 s would have
  cut off.

One number now, `MCP_CONNECT_BUDGET_MS` in an import-free
`mcpApps/budgets.ts`: the endpoint's own cold-start budget
(`MCP_COLD_START_MS`, 90 s, which the endpoint now takes from there too)
plus the ordinary 15 s for one request. Agents, swarm Tool nodes and Test
connection give `initialize` that long, and every other request keeps its
ordinary budget. The client's patience outlasts the server's, so whatever
the endpoint answers arrives: ready, or its 503 naming what went wrong. The
only cost is for an external server whose initialize HANGS, which is now
waited on for longer. Any answer still returns the moment it comes.

The longer wait exposed a second fault, fixed with it. R99's session
retried the request bare when initialize was refused, which is right for
a server without sessions (a 4xx). It did the same for a server that
FAILED (a 5xx). Behind this endpoint, that bare retry started a second
sandbox after the first start had just been given up on. A 5xx initialize
is now the answer, and nothing more is sent.

The Deploy tab and the docs now say the first call waits around half a
minute, and the docs name the 90 s ceiling.

**Tests:** 8 new. Two check the budget: it outlasts the endpoint's own
budget and every measured cold start. Two run the session: a 503
initialize is handed back with nothing more sent, and a 405 still goes on
bare. Four are source-anchored: agents and Test connection give initialize
the budget, the endpoint takes its figure from the same place, and the
owner is no longer promised a few seconds. `mcpStartHonesty.test.ts` now
reads the 90 s figure where it lives. 9 behaviour-changing mutants each
killed, control missed, baseline green first.

### 2026-09-24 — The agents that never said hello

#### R99 · S1 · Every agent call to a stateful MCP server refused

Agents reach MCP servers through one client, `mcpRequest`, behind the
`mcp_list_tools` and `mcp_call_tool` tools and the swarm Tool node's MCP
Tool Call. It sent its request cold: `tools/list` or `tools/call` with no
`initialize` before it and no session id on it. The Streamable HTTP
transport has a session. A stateful server issues an `Mcp-Session-Id` on
initialize and answers anything that arrives without one with
`400 Bad Request: Missing session ID`. Stateful is FastMCP's default, and
so it is how every server the MCP Builder deploys runs.

Measured first, outside the UI, against fastmcp 4.0.3 from the sandbox
image: `tools/list` and `tools/call` sent the agent's way both came back
`400 {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Bad
Request: Missing session ID"}}`.

The Builder makes the failure hard to see. Its Access tab registers a server
for this instance's agents with the toast `Registered — your agents can call
it now.` Its deploy, test console and Test connection all do the handshake,
so the same server reads as healthy everywhere a person looks. Only the
agents, the one caller the registration exists for, were refused.

**Driven, before the fix.** MCP Builder → New server `R99 hello` from the
stock Hello world template → Deploy (`Deployed — 2 tools.`) → Access → Your
agents on → `Registered — your agents can call it now.` Then Agent Swarms
→ New Swarm (`Swarm 17`) → Input → Tool (deterministic) → Output, wired.
The Tool node was set to MCP Tool Call, server `R99 hello`, tool `greet`,
arguments `{"name": "r99 before"}`, then Test this node → Run node. After
1.4 s the output was `{"error":"400: {\"jsonrpc\":\"2.0\",\"id\":null,
\"error\":{\"code\":-32600,\"message\":\"Bad Request: Missing session
ID\"}}"}`. The app's MCP endpoint logged `status 400`, and the sandbox
logged one bare `POST /mcp` → 400. The deploy two minutes earlier had
done `POST 200`, `202`, `POST 200` on the same server.

**After the rebuild** (container `52e61c76e4f1`), in the same swarm, saved
this time as `R99 MCP tool call`, with arguments `{"name": "r99 after"}`:

- **With the sandbox warm**, Run node answered
  `{"jsonrpc":"2.0",…,"result":{…,"content":[{"text":"Hello, r99
  after!","type":"text"}],"isError":false,…}}`. The sandbox logged the
  whole session: `POST 200` (initialize), `202` (initialized), `POST 200`
  (the call), then `DELETE /mcp 200`. The endpoint forwards a DELETE only
  after removing its own session row. That first call in a freshly started
  sandbox took about 10 s inside the sandbox. Run again with
  `{"name": "r99 again"}`, it answered `Hello, r99 again!`, and the
  endpoint logged 1.48 s, 1.11 s and 1.17 s for the three requests. A
  stock FastMCP called directly answered in 0.44 s the first time, so the
  10 s is the sandbox's first call, not the session.
- **With the sandbox cold**, the first run after the rebuild answered
  `{"error":"The operation was aborted due to timeout"}` after about 13 s.
  The endpoint's `initialize` was answered 200 after **35.5 s** of cold
  start, 20 s after the agent's 15 s timer had given up. That is a
  separate fault, a client timer shorter than the work it waits on, and
  it is queued rather than folded in here.

The call is now made in a session of its own, in `mcpApps/session.ts`. It
sends `initialize` and takes the `Mcp-Session-Id` and the protocol version
the server agreed to. It announces `notifications/initialized`, sends the
request carrying both headers, and reads to the answer (R98). Then it ends
the session with a DELETE, which the spec asks of a client. This
instance's own MCP endpoint keeps a row per session until one is ended, so
without the DELETE an agent calling a Builder server would leave a row
behind per tool call. A server that refuses `initialize` at the HTTP
level gets the request bare, as before, so an endpoint that only ever
answered bare requests keeps working. Every request of the session still
goes through the SSRF guard.

**Tests:** 12. Nine run the session against a fake that behaves the way
the measured server did. The fake refuses a cold request with Missing
session ID. In a session, the call is answered, in the order initialize →
initialized → request, carrying the issued session id and the agreed
version. The session is ended afterwards, and also when the request
fails. A server that refuses initialize is still called bare, and a
stateless one, which issues no id, gets no DELETE. Three are
source-anchored: the agents' client uses the session, keeps the SSRF
guard, and is what both agent tools call. R98's door test moved with the
reads. 8 behaviour-changing mutants each killed, control missed, baseline
green first.

### 2026-09-24 — The answers read to the end of a stream that need not end

#### R98 · S1 · Five MCP clients that waited for the server to hang up

Every place this app reads an MCP server's reply did `await res.text()`.
For a reply sent as `text/event-stream` that resolves only when the SERVER
closes the stream, and the Streamable HTTP spec leaves that to the server:
once the response is sent it "SHOULD close the SSE stream". Should, not
must. A stream kept open — keep-alive comments, a proxy in between, a
server slow to tidy up — held the reader until its abort timer fired. The
answer, which had come back in milliseconds, was then lost. The failure
was reported as "The operation was aborted due to timeout", which names
neither the request nor the wait. Five doors read this way:

- **Deploy's handshake** in the MCP Builder: 15 s for `initialize`, whose
  timeout was swallowed and simply spent, then 15 s for `tools/list`, whose
  timeout failed the deploy and marked the running server **Error**;
- the Builder's **test console**, 60 s for `tools/call`. It had no
  try/catch, so the timeout was thrown at the page, which did not catch it
  either and stayed on its spinner for good;
- the public **`/api/mcp/s/<slug>` relay**, 60 s, then 502 to the client;
- **Test connection** for a registered MCP server;
- an agent's **MCP tool calls**, 15 s, through a third hand-written SSE
  parser that took the LAST `data:` line rather than the response.

It surfaced as an intermittent deploy failure on a stock FastMCP server,
the `HTTP Test` app, while this round was being scoped. The deploy
returned the timeout at 43.2 s, although the sandbox's own log had
answered `initialize`, `notifications/initialized` and `tools/list` by
25 s. That gap fits one
15 s wait on a `tools/list` stream that had already delivered its answer.
A batch of eight deploys of the same app then passed 8/8 (23–42 s, one of
119 s left undiagnosed), so on that server it is rare. A server that uses
the latitude the spec gives it makes it certain, and that is what was
driven.

**Driven, before the fix, with a server that keeps its streams open.** MCP
Builder → New server `R98 held stream`. Its source is a small Streamable
HTTP server that answers each request at once and then holds that
request's stream open for 90 s with a keep-alive comment every 5 s.

- **Deploy**, with `initialize`, `tools/list` and `tools/call` all held
  open. The sandbox logged `answered initialize` at 22:18:42.44 UTC. The
  next request came exactly 15 s later, at 22:18:57.44: the handshake had
  spent its whole `initialize` timer waiting for a stream that already held
  the answer. `answered tools/list` followed 2 ms later. The deploy
  answered after **49.1 s** with the toast `The operation was aborted due
  to timeout`, and the app was marked **Error** while its sandbox ran on.
- **Test console**, with only `tools/call` held open, so Deploy succeeded
  (`Deployed — 1 tool.`). Tools → `echo` → `{ "text": "r98 before" }` →
  Call echo at 02:22:10. The sandbox logged `answered tools/call` at
  22:22:09.175 UTC, 5 ms after the click. The server function came back at
  **61.2 s**, a thrown `The operation was aborted due to timeout`. The page
  never showed it: no output, no toast, and the button disabled on its
  spinner still, 50 s later and for good.

**After the rebuild** (container `1d2c788bbb32`), the same app, every
stream held open, and one case added so a real timeout can be seen: `echo`
with the text `never` gets no reply at all.

- **Deploy**: `Deployed — 1 tool.` in **15.1 s**, status Running. The
  sandbox answered `initialize` at 22:47:24.250 UTC; the next request came
  70 ms later, not 15 s; `tools/list` was answered at 22:47:24.322.
- **Test console**, `echo` → `{ "text": "r98 after" }`: `echo: r98 after`
  in **1.26 s**, with the sandbox still holding the stream open.
- **Test console**, `{ "text": "never" }`: the sandbox logged `stayed silent
  on tools/call`, and after **61.0 s** the console showed `Error:
  tools/call → no answer within 60s` with the button enabled again.
- **A stock FastMCP server that closes its streams** (`HTTP Test`):
  `Deployed — 2 tools.` in about 18 s, so nothing was lost for the common
  case.

The public relay, Test connection and agents' tool calls share the reader
and are held by the tests.

One reader now, `readRpcBody(res, maxChars?)` in the import-free
`mcpApps/sse.ts`. A JSON body is read whole, as before. A stream is read as
it arrives and let go the moment a complete event carries a JSON-RPC
response. The reader stops and cancels the stream there, releasing the
connection. "Complete" means the blank line that ends an SSE event, not
just the end of a line: a `data:` line whose JSON parses is still half an
event until then. A stream that closes without a response is parsed the
old way, so odd servers keep their fallback. The relay's size cap is now
applied while reading, so an endless stream cannot pile up in memory. All
five doors use the reader. The agents' hand-written parser is gone, with a
fallback kept for a stream sent under the wrong content type. The
handshake and the console name the step that ran out: `tools/list → no answer within
15s`. That is now true, because a timeout here means no answer came. The
console's server function answers its failures rather than throwing them,
and its page leaves the spinner in a `finally`.

**Tests:** 22. Twelve execute the reader against streams that never close:
it returns the answer, returns while keep-alives arrive, cancels the
stream, passes over a notification, waits for the blank line and not the
line end, reassembles CRLF split across chunks, joins multi-line data,
reads JSON whole, falls back on a closed stream with no response, and caps
an endless one. Two cover the failure wording. Eight are source-anchored:
one per door, the handshake naming its step, the console's catch and the
page's `finally`. 18 behaviour-changing mutants each killed, control
missed, baseline green first.

This also corrects the queue's "two timeouts that do not agree" note from
R89, which blamed this same message on a caller's patience being shorter
than the 90 s cold start. The only timer that produces it on that path is
the handshake's own 15 s, and what it was waiting for was the end of a
stream that had already answered.

### 2026-09-24 — The model calls that went round the rules

#### R97 · S1 · Five features that called a provider themselves

IAM's model access rules restrict a user or a group to an allow-list of
provider/model pairs, and the admin page promises what that means: in deny
mode a user "can call no models at all until a rule allow-lists them". They
are enforced at one door, `/api/chat`, and the design goes to some trouble
to make that door the only one: agents, swarms, the AI gateway, the AI
functions in SQL, document OCR and every headless run go through it,
including `internalChatText`'s internal channel, which reads the rules with
the service role for the owner. R96's sibling sweep asked whether anything
went round it. Five features did, each calling a provider directly and
asking nothing:

- the **ETL**, **lakehouse** and **skill** code generators, which take the
  provider and model from the request — and when none is given, fall back to
  the owner's default or to `openai/gpt-4o-mini`;
- the **knowledge-graph builder**, which sends every chunk to a fixed
  `google/gemini-2.5-flash`;
- **embedded BI's analyst**, which answers an anonymous viewer with the
  dashboard owner's model through its own private copy of the JSON call.

The generators' header states the design plainly: "model governance applies
through the same picker". The picker is the dropdown in the page. It
filters what it offers, but it starts unset, and an unset choice sends no
model at all — so the server's fallback was never offered to the rules to
refuse. A user restricted to one cheap model, clicking Generate without
touching the dropdown, got a pipeline written by a model the administrator
had not approved, on credentials the administrator may have restricted for
exactly that reason.

**Driven, with a model rule on this account, before and after.** Model
rules apply to superadmins in the default allow mode (only deny mode exempts
them), so the rule was put on this account: Admin → IAM →
Access → Model access → User → this account → OpenRouter `openrouter/free`
→ Add rule → Save rules. The door that was already guarded proved the rule
live: a chat request for `openai/gpt-4o-mini` from the same session came
back `403 model_not_allowed: Your administrator has not allowed
openrouter/openai/gpt-4o-mini for your account.`

Before the fix: ETL Pipelines → `Test2` (Code) → AI assist, the model
picker left as it opens (`OpenRouter · Server default`), a one-line brief →
Generate. `POST /api/etl/generate` answered **200** with a drafted pipeline
and `"model":"openai/gpt-4o-mini"` — the model the rule had just refused on
the chat path, called for a plain click on the page's default.

After the rebuild (container `3c3996a4c9ad`), the same pipeline, the same
brief, the same untouched picker, Generate: **403**, and the page's toast
`Your administrator has not allowed openrouter/openai/gpt-4o-mini for your
account. Ask a superadmin to adjust your model access.`, with nothing put
in the editor. With `openrouter/free` chosen in the picker, Generate again:
**200**, `"model":"openrouter/free"`. The rule was then removed and read
back as `No rules — this user is unrestricted`, and `Test2` was left with
its original code, nothing generated saved. The lakehouse and skill
generators, the graph builder and embedded BI share the fix and are held by
the tests. Recorded in docs/UI_TEST_RESULTS.md.

One question now, `modelAccessRefusal(userId, provider, model)`, read the way
`/api/chat`'s internal channel reads it and answering with the same
sentence. Each generator asks once the model is FINAL — after the fallback,
which is the whole point — and before the call, answering 403, or 503 when
the policy cannot be read rather than calling on a guess. The graph builder
asks about the model it will use before it wipes the graph it has, so a
refused build leaves the old one intact. Embedded BI asks the OWNER's rules
and closes when they cannot be read.

**Tests:** 9 source-anchored — the question and its sentence, each
generator asking after the fallback and before the call and refusing on an
unreadable policy, the graph builder asking before the wipe, embedded BI
asking before its call and closing; 10 behaviour-changing mutants each
killed, control missed, baseline green first.

### 2026-09-24 — The notebooks the runtime switch did not reach

#### R96 · S1 · Who asks the admin's runtime switches

Admin → Developer runtime has two switches that decide who may run Python
on a server kernel, and says what each does:

- **Enable server runtime** — "Allow Developer-workspace notebooks to launch
  server kernels." The page adds: "until you enable it, notebooks show a
  short 'runtime required' prompt instead of running."
- **Require an access grant** — "When on, only superadmins and granted
  users/groups (below) may start a kernel."

Two paths asked (`canUseRuntime`): the interactive kernel route behind the
Developer workspace, and MCP deploys. Three did not, and each runs, or
licenses running, a user's own notebook code:

- **a published notebook's API**, `POST /api/notebook/run` with an `nbk_`
  key, which calls `startSession` straight after checking the key;
- **a workflow's Notebook step**, which calls `startSession` straight after
  checking the notebook is the owner's;
- **minting the key** that publishes a notebook, which hands out a standing
  permission to start kernels without asking whether its owner has one.

`startSession` itself asks nothing — it is shared with platform sandboxes
that are not notebooks — so whatever a caller forgot, nothing caught. The
consequence is a governance control that covers the front door only. An
administrator who switches the runtime off, or restricts it to one group,
is told notebooks will not run; every workflow with a Notebook step keeps
running them, and every key a user ever minted keeps working for anyone
who holds it, including after that user's grant is revoked.

**Driven, the master switch with a superadmin, before and after.** The
grant half cannot be shown from a superadmin account, which bypasses it by
design, and a published notebook's key cannot be exercised without handling
a secret; both are held by the tests. The master switch applies to
everyone, so it was driven. A new workflow, `R96 notebook step`, with one
Notebook step running `My Python notebook`.

Before the fix: Admin → Developer runtime → **Enable server runtime** off →
Save settings, read back `false` after a reload at 00:01:20. The notebook
itself then showed `Server runtime required … That runtime isn't available
yet, so cells can't execute.` with no Run button. Workflows → `R96 notebook
step` → Run now: the host had no sandbox at 00:01:47, then
`nb-f2968348-31f8-4d03-8680-971ec7a3fd7e · Up 8 seconds`, created 00:02:12,
and the run ended `Showing run · succeeded` at 00:02:34, its step naming
session `f2968348` — the same notebook the workspace had just refused to
run, executed on a server kernel with the runtime switched off.

After the rebuild (container `a949a9bae152`), the same switch off, read
back `false` at 00:19:26, and the same Run now: `Showing run · failed` at
00:20:11, the step reading `The notebook step cannot run: The server
runtime is not enabled on this instance. An administrator can enable it in
Admin settings.`, the host still holding no sandbox at 00:20:17, and the
earlier `succeeded · 18 minutes ago` listed under it. With the switch back
on, read back `true` at 00:21:05, Run now again: `Showing run ·
succeeded` at 00:21:55. Recorded in docs/UI_TEST_RESULTS.md.

Every path that runs a user's notebook now asks one question,
`notebookRuntimeRefusal(userId)`, whose reasons come from a single pure
function: the disabled runtime first, whatever the grant says, then the
missing grant. The published API asks about the key's OWNER on every call
and answers 403 with which switch stopped it, before it counts a use or
starts anything; a workflow's Notebook step fails with the reason; minting
a key is refused to anyone the runtime would refuse. Platform sandboxes —
ETL, ML training and serving, Spark queries — are deliberately left alone:
they are not notebooks, and the switch does not claim them.

**Tests:** 7 — four behavioural on the reasons and their order, three
source-anchored on each path asking before it starts or mints, and the
published API's 403 naming the right switch; 9 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-23 — The scheduler that waited for someone to look

#### R95 · S1 · Starting the in-process scheduler

Everything this platform does on a clock runs from one pass: BI refreshes and
data alerts, scheduled reports, prep flows, swarm schedules, ETL pipeline
schedules, catalog crawls, data monitors, SQL model builds, workflow steps,
audit retention, notebook-kernel reaping and lakehouse maintenance. On a
single instance an in-process 60-second scheduler drives that pass, and the
deployment guide makes the promise in so many words: "The in-process
scheduler runs automatically on a single VM — **no cron setup needed.** To
update: `git pull && docker compose up -d --build`."

It did not start automatically. `ensureScheduler()` is reached through one
route, `/api/bi/cron`, and the only regular caller of that route is the
header's notification bell, which pings it once when a signed-in page
mounts. So after every restart — a deploy, the very update command the guide
gives, a crash recovery, a host reboot — nothing on a clock ran until somebody
opened the app. The module's own header said the scheduler started "on
first request that imports this module"; it never did. And looking was the
cure: the Monitoring page's Scheduler card sits under that same header, so
an operator who opened it to check would find a healthy scheduler they had
just started themselves.

**Driven, with timestamps, so that looking could not spoil it.** Opening
any page starts the old scheduler, so both halves were run with every page
closed and read afterwards from times the app itself wrote down. A new
schedule on the `Approval durability check` swarm, `R95 heartbeat`, every
15 minutes, gave the clock.

Before the fix: the heartbeat ran at 22:33:48; the app was restarted at
22:35:12 and no page was opened; the heartbeat came due at 22:48:48 and did
not run; the hour boundary at 23:00, when every pass runs lakehouse
maintenance and logs it, produced no maintenance line at all, and the app
log held no model call after the restart. A page was opened at 23:03:27 and
the heartbeat ran at 23:03:53 — fifteen minutes late, 26 seconds after
someone looked. Recent runs showed it plainly: `started 13s ago` directly
above `started 30m ago`, nothing between.

After the fix (container `b9e14441145c`), with every page closed again: the
image was swapped in at 23:05:02 and at 23:05:38 all eight workers logged
`scheduler started`, seven with `catch-up pass left to another worker` and
one with `catch-up pass ran`. The heartbeat came due at 23:18:53, its model
call is in the log at 23:19:45, and its row reads `last 9/23/2026, 11:19:46
PM` — 53 seconds after it was due, and 87 seconds before a page was opened
at 23:21:13. Recorded in docs/UI_TEST_RESULTS.md.

Every worker now makes the bell's call itself as it boots — in-process,
through `app.fetch`, exactly as `server.mjs` already asks the app whether its
keyring loaded before taking traffic. The call carries
`AGENTSWARMS_BOOT_TOKEN`, 32 random bytes minted per boot before any worker
forks and known to nothing outside the process group; it buys one ordinary
pass, which is what any signed-in user's token already buys, and never the
forced pass reserved for the operator's `BI_CRON_TOKEN`. It is skipped when
`DISABLE_INPROCESS_SCHEDULER` hands scheduling to an external cron, it is not
awaited so the SIGTERM handler is in place for the whole of the pass, and it
says in the log what happened either way — including, when it fails, that
scheduled work will wait for the first signed-in page load, which was the
old behaviour and is now a stated fallback rather than a silent default.

**Ruled out on the way, and worth recording.** Two other suspicions about the
same scheduler did not survive measurement. (1) A graceful stop stranding the
cron lease for its ten-minute TTL: three restarts and recreates were timed
against the first minute after boot, when no new worker can hold the lease,
one of them fired the instant a probe saw another worker mid-pass — and
every time the first call after boot ran a pass. The pass finishes inside
srvx's five-second drain. The two ten-minute stalls seen earlier today while
waiting for schedules after rebuilds were this round's defect, not a lease:
nobody had opened a page. (2) Eight passes a minute from eight workers:
real, but `docs/SYSTEM_REQUIREMENTS.md` already states it ("per worker
unless the in-process scheduler is off"), so it is a documented cost, not a
defect.

**Tests:** 8 — four behavioural on who may run a pass (the external cron,
the boot call, a near-miss one byte short, unset tokens) and that only the
external cron forces one, four source-anchored on the token minted before
any fork, the in-process call and its opt-out, the pass not holding up
SIGTERM, and both failure branches saying what they mean; 9
behaviour-changing mutants each killed, control missed, baseline green
first. The first mutation run MISSED one: the test proved only that one of
the two failure messages explained itself. It now counts both.

### 2026-09-23 — The two exits that freed nothing, and a correction to R93

#### R94 · S1 · The sandbox that never started

R93 counted what the host had kept: 122 sandboxes that exited 0, 16 that
exited 1, and one in `created` that had never run at all. R93 claimed the
refresher now covers all of them. It does not, and the count says which is
which. This round is the other two exits.

`create()` makes the container and then starts it. When the start fails it
takes the container away again and throws the start's error — and that
teardown is the ONLY thing that will ever remove this container, because no
session row carries a ref to a sandbox that did not start, so neither the
refresher nor the reaper will ever hear of it. Its answer was discarded, in
the shape this survey keeps finding: `await this.stop(created.Id).catch(()
=> {})`. A cleanup that failed too left the sandbox on the host and told
only the start's half of the story.

MEASURED twice. The old one: `nb-4698447a-…`, created 18 September,
`StartedAt` still `0001-01-01`, on the host five days later. And a fresh
one, forced through the admin UI by asking for a GPU on a host that has
none: the job ended `docker start failed (500): failed to create task for
container …` and a new sandbox `nb-d8376a51-…` sat on the host in
`dead`, named nowhere.

The teardown's answer is now read, and the thrown error carries both
halves: what the start said and, only when the removal failed as well, that
a container is still on this host and has to be taken away by hand. The
start's own explanation is read BEFORE the teardown runs, so the cause is
in hand whatever the cleanup then does; the `catch` around the teardown
exists for the same reason, to turn an unexpected throw into a result
rather than let it replace the error that matters.

#### R94 · S2 · The sandbox that reported its own result, and what R93 got wrong

R93 said: "A kernel that ends ON ITS OWN only ever comes through
[`refreshSession`]". That is true of a kernel that dies — and false of
every batch sandbox that finishes properly, which is most of them.

A batch sandbox — an ETL run, a training worker, a prediction, a Spark
query — ends by POSTing its result to `/api/notebook/runtime/result`.
That handler writes the terminal status onto the session row and returns.
From that moment `refreshSession` returns at its first line and the reaper
skips the row, so R93's new teardown never sees it: the row is terminal
BEFORE any refresher looks. 122 of the 139 leftovers were `Exited (0)`,
which is exactly this.

It was caught by driving R93 rather than by reading: after that round
shipped, a real training run finished cleanly and its sandbox was still on
the host a minute later, with nothing in the log. The callback now takes
the container away once its row is terminal — last, after the ETL, ML and
Spark finalisations that read the same row, and with the logs already
stored on it, so there is nothing left in the container worth keeping —
and says what is left, and that nothing else will come looking, when it
cannot.

**With S2, the sweep is closed.** Every sandbox this platform creates —
ETL, lakehouse Spark, ML prediction, ML training, ML serving, MCP apps,
notebooks — is released through the shared runtime layer, whose teardown
sites are now all read: `create()`'s cleanup, `startSession`'s unrecorded
container, `stopSession`, R93's `refreshSession`, and this callback. The
only direct uses of the orchestrator elsewhere are `status()` and `logs()`,
which take nothing away.

**Driven, both exits, before and after.** The failure is forced honestly,
through the admin UI: `Training GPUs` set to 1 on a host with no GPU, so
the container is created and the runtime refuses to start it. Before the
fix, on the R93 container: ML Models → `threshold_probe (payment_rows)` →
Train new version → Train ended `failed`, its Jobs row reading only
`docker start failed (500): {"message":"failed to create task for
container: failed to create shim task: OCI runtime create failed…`, while a
new sandbox `nb-d8376a51-…` sat on the host in `dead`, named nowhere. And
the second exit, found by driving R93 after it shipped: a training run that
SUCCEEDED, `24m ago · succeeded · 84s · lightgbm · F1 (macro) 58.8%`, left
`nb-620c9267-… · Exited (0)` on the host nine minutes later, with nothing
in the log, because its row went terminal through the result callback
before any refresher could look.

After the rebuild: the same forced failure left the host unchanged, 139
sandboxes and no new one; `Training GPUs` was set back to 0 and saved, read
back from the server, and training worked again. Then the same training
once more, on container `7ec7707c988b`: `nb-96758b65-8b4c-4740-8fb4-524d4
bfbc4f9 · Up 18 seconds` while it ran, and gone the moment it finished —
zero rows for it, the list back to 140 — with the Jobs tab showing `2m ago
· succeeded · 59s · lightgbm · F1 (macro) 58.8%` above the older
`24m ago · succeeded · 84s` whose sandbox is still there. Same training,
twice, minutes apart, both successful: one leaves a container, the other
does not. The sentence a FAILED removal adds is held by the tests; the
removal worked on both of this host's attempts, and a DELETE that fails is
not something a browser can arrange. Recorded in docs/UI_TEST_RESULTS.md.

**Tests:** 8 source-anchored — the order the start's body is read, the
teardown's answer, the sentence a failed removal adds and its absence when
the removal worked, the callback reading the container back, tearing down
after the finalisations, and what it says when it cannot; 9
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-23 — The sandbox nobody removed

#### R93 · S1 · The kernel that ended by itself

A notebook kernel, a batch job and an MCP service each run in a sandbox the
app creates and is supposed to take away again. A sandbox can end two ways,
and only one of them removed anything.

`stopSession` stops the container and removes it. It is reached from
`reapSessions`, which selects sessions whose status is still LIVE — idle
past their TTL, or past `expires_at`. That is the path for a sandbox
something decides to end.

The other way is the sandbox ending on its own: the kernel exits, the batch
job finishes, the service process dies. Nothing calls `stopSession` then.
`refreshSession` notices — `st.state` comes back `succeeded`, `gone` or
`error` — writes the terminal status onto the row and returns. The
container is left standing, and the moment that row stops being LIVE it is
invisible to the only cleanup there is, for ever.

MEASURED on the development host this was found on: `docker ps -a` listed
139 `nb-…` sandboxes, 122 of them `Exited (0)`, 16 `Exited (1)` and one
`Created`, the oldest thirteen days old — while the reaper ran on every
cron pass throughout. It surfaced sideways, from looking at the host during
an unrelated memory complaint; nothing in the app says a word about it,
which is the point. The cost is not memory — the leftovers are stopped
and hold none — it is an inventory that grows without bound on every
host that runs a kernel, and an operator's `docker ps -a` that stops being
readable.

The second half is the path that DOES remove. Its answer went in the bin:
`dockerFetch` RESOLVES with the Response, so the `.catch(() => {})` around
the DELETE only ever saw a transport failure, and a 409 or a 500 was
silently a job well done. The kubernetes backend had the same shape, where
a 403 from a namespace the service account may not delete in read as a
clean teardown.

So `stop` now answers `{ removed, error? }` instead of `void`; both real
backends read their DELETE and count 404 as gone, because somebody else
getting there first is the goal, not a failure; `refreshSession` removes
the sandbox when it writes a terminal status, taking the failing kernel's
logs first, since removing the container is otherwise the same act as
destroying the evidence of why it failed; and both callers say what is left
behind when a removal does not happen — a live session's stop says the
sandbox is "still on the host, still holding its CPU and memory", which is
the sentence the caps and the operator both need.

**Driven, from the notebook that owns the sandbox.** The before half is the
host itself, measured above: 139 sandboxes nothing points at, accumulated
over thirteen days while the reaper ran on every cron pass. After the
rebuild (container b454b7c4aaaa): Developer workspace → `My Python
notebook` → Run on the pure-Python cell, which answered `mean: 500 ms`,
`p50: 300.0 ms`, `max: 1450 ms`, `'2 slow calls out of 8'` from the server
kernel, and put `nb-0d2e5be3-7f30-45f0-84a6-bf4aa4d4dc3b · Up 16 seconds`
on the host, 140 in the list. Then a cell that ends the sandbox ON ITS OWN
— `import os, signal; os.kill(1, signal.SIGTERM)` — which answered
`gateway closed the connection (code 1005)` in 553 ms and left
`nb-0d2e5be3-… · Exited (0)` sitting there, because the app had not looked
yet. Reopening the Developer workspace is what makes it look, and that
removed the container: gone from `docker ps -a`, the list back to 139.
Under the old code the same reopen wrote `stopped` onto the row and left
the container, which is exactly how the other 139 got there. They stay —
their rows went terminal long ago, so the refresher returns before
reaching them — and have to be removed by hand. Recorded in
docs/UI_TEST_RESULTS.md.

**Tests:** 6 source-anchored on the contract, both backends' DELETE, the
terminal-status teardown, the logs taken before it, and the live stop's
report; 8 behaviour-changing mutants each killed, control missed, baseline
green first.

### 2026-09-23 — The run that was resumed somewhere else

#### R92 · S1 · The parked run's record

`executeSwarmServer`'s `resume` option says what it is for, in its own
words: "the caller supplies the existing run id (so the timeline continues
rather than forking)". The id arrives, is used to load the checkpoint, and
then stops. The tracer that writes `swarm_runs` was never told about it,
so every resume INSERTED a second run row and nothing ever closed the
first.

Four things follow, and all four are visible without looking at the
database.

The parked run is never closed. MEASURED: the swarm gallery's Recent runs
tab listed `Approval durability check (schedule) — Running — 34m 59s`,
with a live duration and a Cancel button, thirty-three minutes after its
approval had been granted and the work had finished. Four such rows sat in
that list from one session's driving.

Its headline numbers are zeros. A run that parks is stamped `suspended`
without calling the tracer's `finish` — deliberately, since it is not over
— so its totals are still the zeros it was inserted with. MEASURED: run
`3bf09de5` reads `suspended · STEPS 0 · ERRORS 0 · DURATION 0ms · COST
$0.0000` above its own timeline, which lists `Request 107ms`, `Summarise
for the approver 9927ms · 76/495 tok` and `Human approval 339ms`. Nothing
would ever have written those totals, because the run that could have
finished it was a different row.

That row is the second one, and it is named for the wrong thing. MEASURED:
run `7f9912e2`, `Approval durability check (schedule) (api) · success · 3
steps · 3919ms`, holds the half the approver released — under the source
of the RESUME rather than of the run, with the swarm's cost and step count
split across two records that nothing links.

And the parked row keeps its checkpoint. The end of a run clears the
checkpoint for the id it is running under, which was the new one; the old
one's row stayed. Combined with R90's gate — which refuses only a run
that is `success` or `error`, then asks for the checkpoint — the same
approval could be resumed a second time, and the whole remainder of the
swarm would run again.

The id now reaches the tracer. A resume reopens the run it was given,
carries its steps, its edges and its numbers, and leaves the step it
parked on exactly as it was recorded, so nothing is counted or drawn
twice; `finish` then closes the run everyone was already looking at. When
the row cannot be reopened the resume still records its work, under a new
id, and says that is what happened and what it leaves behind. The decision
row is not opened a second time either: it carries the run's id, so a
resume would be writing the same row.

**Driven, before and after, on the same page.** Before the fix, on the R91
container: the gallery's Recent runs tab held `Approval durability check
(schedule) · Running · started 34m ago · 34m 59s`, still offering Cancel,
directly under the `(api) · Success · 5s · 3 steps` row that held the work
its approver had released half an hour earlier. Opening the Running one
gave run `3bf09de5`, `suspended · STEPS 0 · ERRORS 0 · DURATION 0ms · COST
$0.0000`, three lines above its own timeline of `Request 107ms`,
`Summarise for the approver 9927ms · 76/495 tok` and `Human approval
339ms`; the other row was run `7f9912e2`, `success · 3 steps · 3919ms ·
75/1 tok`. After the rebuild (container 693a0ae3a632) a fresh schedule
parked the same way — bell `Pending approvals (1)`, run `c4a3f7bb`
`suspended · STEPS 0 · DURATION 0ms` — and Approve closed THAT run: the
same url reloads as `success · STEPS 5 · ERRORS 0 · DURATION 42818ms ·
TOKENS IN 155 · TOKENS OUT 948 · Data flow (4)`, its timeline listing five
steps once each and the final output, and the gallery showing one row,
`Success · 1m 56s · 5 steps`, with no `(api)` twin and nothing left
Running. The arithmetic checks: 115 + 37493 + 343 + 4656 + 211 ms is the
42818 ms reported, and 85 + 70 / 947 + 1 are the 155 and 948. Recorded in
docs/UI_TEST_RESULTS.md.

**Tests:** 7 source-anchored on the reopen, its failure message, the
carried steps, edges and totals, the still-open step, the three
do-not-record-twice guards and the executor's half of the promise; 8
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-23 — The switch that meant the opposite of its label

#### R91 · S1 · The Deploy dialog's warning about approval steps

A swarm with a human-approval step, deployed to an API key or a schedule,
runs with nobody watching. One switch decides what happens when such a run
reaches the gate, and the dialog's amber warning was the only place its two
positions were explained:

> Leave **Reject approvals** ON (the default) and those runs stop safely at the
> gate. Turning it OFF makes the swarm **auto-approve** every approval step —
> your human oversight is bypassed.

Both halves are wrong, and the second is the dangerous one. With the switch
ON the executor throws at the gate: the run stops at the step, ends as an
`error`, and nobody is ever asked. With it OFF the run parks — it writes a
checkpoint, is marked `suspended`, and the request goes into the approvals
bell for a person to decide. OFF is the setting that preserves human
oversight; ON is the setting under which no human ever sees the request.

The copy is a survivor of an older executor, and the repo still says so.
The shipped `Approval durability check` template's own notes read: "Before
checkpointing existed there was nothing to park: an unattended run could
only auto-approve or fail." Checkpointing landed; this warning did not
move.

The consequence is a governance control read backwards. An operator who
wants a person to sign off on scheduled runs is told that the position
which asks a person bypasses their oversight, so they leave it ON — and
the approval gate they installed becomes a wall that fails every run
reaching it, with nothing in the bell to show for it. The one who wanted
fail-closed gets it, but is told it is "safe" rather than "errored", which
is what the schedule's own row will say.

The executor says the true version in the error it throws, and this very
dialog displays it: a schedule with the switch ON reports `Stopped at
human-approval step "Human approval": ... turn off "Reject approvals" ... the
run will then park here and resume when someone approves it` in the list of
schedules, an inch below the warning claiming the opposite. The warning now
says what the executor does, in the executor's terms, and adds what a
caller needs: a parked run answers with `status: suspended` and no output,
so an integration that wants its answer in one call should keep the switch
ON deliberately. The evaluations note in the swarms docs carried the same
stale belief — "unless the swarm is safe to auto-approve in a batch" —
and was corrected with it; the eval runner itself has handled a parked case
by name since it was written.

**Driven, both positions, before and after.** On the R90 container: the
Deploy dialog for `Approval durability check` showed the old warning, and
two schedules were added to the same swarm, one per switch position. The
sweep answered for both: `R91 reject probe` (switch ON) `last 9/23/2026,
2:27:25 AM · error`, and printed under it, in the same list, the
executor's own contradiction of the warning above it — `Stopped at
human-approval step "Human approval": this run has nobody to approve it.
That is the safe default. To let this swarm wait for a real decision, turn
off "Reject approvals" on the API key or schedule — the run will then park
here and resume when someone approves it.`; `R91 park probe` (switch OFF)
`last 9/23/2026, 2:27:44 AM · suspended`, with `Pending approvals (1)` in
the bell, one request, which Approve carried to `All caught up`. Neither
position approved anything on its own: ON asked nobody, OFF asked a
person. After the rebuild (container b645e0532188) the dialog shows the
corrected warning, `/docs/swarms` the corrected evaluations note, and a
second pair of schedules answered the same way — `R91 reject probe
(after)` `2:59:13 AM · error`, `R91 park probe (after)` `2:59:25 AM ·
suspended` and its approval resumed. The behaviour did not change in this
round; only the words that describe it did. Recorded in
docs/UI_TEST_RESULTS.md.

**Tests:** 8 source-anchored, pinning each clause of the warning against
the executor's own gate and message, and the docs note against the runner;
5 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-23 — A decision that resumed nothing, and said it had

#### R90 · S1 · The parked swarm run

A headless swarm run that reaches a human-approval step parks: it writes
a checkpoint, marks its run `suspended`, and inserts an approval row so
somebody is asked. Two of those three writes dropped their answers, and
the consequences compound.

The approval insert sat in a `try/catch` a supabase answer never reaches
(R86's shape), so a failed insert was not even the warning its own
comment promised: the run parked, the inbox stayed empty, and nothing
anywhere said why nobody had been asked. The suspended stamp dropped its
error, leaving the row on `running` — which on its own is the familiar
badge that outlived its state. But the approval path then read that word:
`if (run.status !== "suspended") return { ok: true, … }`, with a comment
calling it "a second click, or a run that was already resumed". So a run
whose stamp had failed swallowed the approver's decision, resumed
nothing, and answered ok. The work stayed parked for ever, the person was
told it was fine, and the one path that could have resumed it had decided
it did not need to.

The insert now reads its answer and says that nobody was asked and the
run keeps its checkpoint. The stamp is retried once and, failing twice,
said with what it leaves. And the resume no longer gates on the word: it
refuses only a run that is `success` or `error`, then asks for the
CHECKPOINT, which is what a resume actually needs — a run with none
really was resumed already, and a run with one resumes whatever its
status column says.

**Driven, both halves, end to end.** Before the fix, on the R89
container: Swarms → Library → `Approval durability check` → Load
template → Save; its Deploy dialog → Schedules → a daily schedule with
the template's refund request and "Reject approvals" off; the server's
sweep parked the run — Observability `Approval durability check
(schedule) · suspended`, the bell `Pending approvals (1)`, the approval
reading `Human approval paused · MEDIUM · Approve this request · Refund
request #4821 … Biggest risk: refunding without damage verification may
enable a false claim.` — and Approve resumed it: `Human approval is
resuming.`, the run `success · 3 steps · 0 errors · 3534ms`. After the
rebuild (container `8668f6fb8012`) a second schedule, the same sweep, the
same park, and Approve resumed it in 3728ms. All three writes report
themselves as before. The failure halves — an approval nobody was asked
for, a stamp that did not land, and the decision that used to be
swallowed as a duplicate click — cannot be produced from the browser
against the server executor, and are held by the tests. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 5 source-anchored on the insert's answer, its message, the
stamp's retry, the checkpoint gate and the no-checkpoint case; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — "Running" over a server that died, and a deploy whose tools nobody wrote down

#### R89 · S1 · The MCP app's records

`mcpApps/service.server.ts`, five writes with their result dropped, and
each one is read by something that matters. `setAppStatus` is written by
every path that ends a start — the per-user limit, the instance cap, a
container that died, a start that timed out, a success, a stop — and its
column is what MCP Builder shows. Dropped, the two failures are opposite
and both bad: a server that DIED left the app on `ready`, so the page
said Running over nothing; a server that came up left it on its previous
status, so the page said Error over a server answering requests. The
deploy's own record is worse: the server is up and its tools are known,
and that update is the only place they are written down. Dropped, the
deploy answered ok with the new tools while the app kept the PREVIOUS
tool list, which is the one agents call — a deploy that changed what the
server exposes left every caller on the old contract, silently.
`snapshotVersion` adds the row a rollback reads; `persistLogs` saves the
container's last output, which is exactly what the start-timeout message
tells the owner to go and read; and `touch` feeds the idle reaper.

Each now reads its answer. A status that could not be written says what
the page will go on showing. A deploy whose tools could not be recorded
answers as a failure — "The server is running, but its tools could not be
recorded: …. Agents keep calling the previous tool list until they are —
deploy again." — instead of reporting the new tools. A version the
history could not take is said as one that cannot be rolled back to, the
logs as a Logs tab that will be empty for this attempt, and an unrecorded
use as what the reaper will see.

**Driven.** Before the fix, on the R88 container: MCP Builder → `HTTP
Test` → Open, the app `Stopped` → Deploy — after about 90 s `The
operation was aborted due to timeout` and the app `Error`, while its
sandbox `nb-dbc29e1c…` was up and finished starting moments later;
Deploy again — after 33 s `Deployed — 2 tools.` and the app `Running`
with `Stop` beside it. That second deploy drives the whole chain this
round guards, and every write landed. After the rebuild (container
`00a64721c026`) the same deploy: `Deployed — 2 tools.`, the app
`Running`. What a failure now says is held by the tests, a failed
database write not being producible from the browser against the MCP
service. The first attempt's `Error` over a server that came up is a
mismatch between the request's patience and the server's 90-second
cold-start budget, not a dropped write; it is queued as its own
candidate. Recorded in [UI test results](./UI_TEST_RESULTS.md).

**Tests:** 5 source-anchored on the status write, the deploy's record and
its early return, the version history, the touch and the logs; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — One conversation's transcript, under another conversation's name

#### R88 · S1 · Agent Chat across a selection change

The class R76 opened, swept to the page where it costs the most. Agent
Chat keys two lists on a selection: the conversations on the chosen
agent, the messages on the chosen conversation. Neither was cleared when
its key changed. Picking another conversation left the previous one's
messages on screen, under the new conversation's name and its highlight,
until the new read landed — and when that read FAILED, the early return
after the toast left them there for good. Driven before the fix: the
second conversation selected and highlighted, `Could not load this
conversation's messages: TypeError: Failed to fetch`, and the first
conversation's thirteen messages still on screen, ten seconds later,
reading as this conversation's transcript. A reply typed into that state
goes to the conversation the sidebar highlights, not the one the page is
showing. The same on the agent side: the previous agent's conversation
list stands under the new agent's name.

Picking an agent now clears its predecessor's conversations, picking a
conversation clears its predecessor's messages, and a read that comes
back for a selection no longer on screen is dropped — so a slow read
cannot overwrite a newer one. Both loaders mark their list read on the
failure path too, and the message area says "Loading this conversation…"
instead of the empty state that invites a first message over rows it has
not read.

**Driven.** Before the fix, on the R87 container: Agent Chat → `Sample ·
Graph RAG Explorer (Acme Corp)` → the conversation `Make a 2-slide
PowerPoint…`, 13 messages; then the second conversation `List my data
tables…` with every `GET /rest/v1/messages` rejected — 2.5 s in, the same
13 messages under the second conversation's highlight; 11 s in, the toast
`Could not load this conversation's messages · TypeError: Failed to
fetch` and still those 13 messages. After the rebuild (container
`bc6e32cc54f1`), the same rejection: 2.5 s in, nothing listed and a
`role="status"` line `Loading this conversation…`; 11 s in, the same
toast over an empty transcript and the page's own invitation. The
selection and the transcript agree. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 7 source-anchored on the two clears, the two late-read guards,
the failure path's mark and the loading state; 5 behaviour-changing
mutants each killed, control missed, baseline green first.

### 2026-09-22 — A prep flow that doubled its dataset, and called it a success

#### R87 · S1 · The prep flow's rebuild

`bi/prep.server.ts` materialises a flow's output into a dataset:
snapshot the previous rows for the version history, delete them, write
the new schema, insert the new rows. Three of those four read their
answer. The delete did not. A delete that failed left the old rows in
place and the insert below appended the new ones beside them, so the
dataset came out DOUBLED — every sum, count and average over it wrong, on
every chart and every agent question that reads it — under a flow that
reported success and a version snapshot that said the rebuild had
happened. Nothing downstream recomputes a row count, so nothing would
ever have caught it. This is the same rule R82 wrote for lineage — the
insert must wait for the delete's answer — with rows instead of edges,
and the consequence is not a wrong graph but wrong numbers.

The same file's incremental refresh replaced rows inside a guarded delete
and insert and then set the dataset's column list in a write whose error
went unread, so a renamed column would be described by its old name for
every reader; and its semantics writes sat in a catch a supabase answer
never reaches (R86's shape).

The rebuild's delete now stops the write: "The dataset's previous rows
could not be cleared: …. Nothing was written, so <name> still holds the
rows it had." — the dataset is left exactly as it was rather than
doubled. The incremental refresh fails with what is where. The semantics
write reads its answer and says the data is there and the descriptions
are not.

**Driven.** Before the fix, on the R86 container: BI Workspace → Data
preparation → `Summary data`, output set to `r87_prep_probe` → Run & save
dataset — `Saved "r87_prep_probe" with 9,992 rows`; run again, the
rebuild branch — the same toast; Data Catalog → `r87_prep_probe · 3
columns · 9,992 rows · 81.6 KB`, replaced rather than appended. After the
rebuild (container `04cfed91a5fc`) the same two runs and the same 9,992
rows. That second run is the path this round guards: snapshot, delete,
schema, insert. Its delete landed both times, so the count held; had it
failed, the same success toast would have stood over 19,984 rows and
every figure read from the dataset would have doubled — which is what the
tests now hold, a failed database write not being producible from the
browser against the prep service. The probe dataset was deleted
afterwards through the impact dialog. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 3 source-anchored on the delete's throw standing between the
delete and the insert loop, the schema failure, and the semantics answer;
4 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — A swarm run that finished and stayed "running", under four catches that never caught anything

#### R86 · S1 · The swarm run's trace

`observability/serverTracer.server.ts` writes the whole of what the
Observability page shows: a run row, a step row per node, an edge row per
hop, and the run's close with its totals. All four sat in
`try { … } catch { /* best-effort */ }` — and a supabase call answers with
its error rather than throwing, so those catches never caught anything.
Every one of the four was unconditionally silent. The step insert was the
compounding one: read back only for its id, a failed insert left no id in
the map, and the `if (!stepId) return` below then dropped that step's
outcome, while its edges were written with a null endpoint. And the close
is the R75 shape again: a swarm that had finished stayed `running` on the
Observability page for ever, with no final output, no step count, no
tokens and no cost.

Each write now reads its answer and says what the trace will be missing:
a step that could not be recorded, an outcome that leaves a step showing
as running, an edge the graph will not draw. The run's close is retried
once — the run is over, so there is nothing to race — and, failing twice,
said with the run, the outcome and "It will show as running until it is
closed." The catches stay, for what can still throw.

**Driven.** Before the fix, on the R85 container: Swarms → `Embed E2E
Mini Swarm` → Open → Run with "Write one sentence about why a run record
must say what happened." — the trace filling live, then `235 tok ↑115
↓120 ~$0.0001`; Observability `8 swarm runs` with the new row `success ·
4 steps · 0 errors · 9219ms · 115/120 · $0.0001`, and its trace `STEPS 4
· ERRORS 0 · DURATION 9219ms`, four steps and `Data flow (3)`. After the
rebuild (container `9571f511504a`) the same run: `9 swarm runs`, `success
· 4 · 0 · 10937ms · 119/126 · $0.0001`, four steps and three edges again.
All four write kinds are on that page and all four land. What a failure
now says — a step that could not be recorded, an outcome that leaves a
step showing as running, an edge the graph will not draw, a close retried
once and then said — is held by the tests, a failed database write not
being producible from the browser against the tracer. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the step insert, the step's outcome, the
edge and the close's retry; 5 behaviour-changing mutants each killed,
control missed, baseline green first.

### 2026-09-22 — A schedule whose next run never moved, and an alert that fires again on every check

#### R85 · S1 · The BI schedule's clock and the alert's edge

`bi/refresh.server.ts`, four writes with their result dropped, and the two
that matter carry state nothing else recomputes. An alert's `last_state`
is not a display column: it is the edge that decides whether a person is
told. Checked and triggered, the alert notifies and then writes
`triggered` — and that write's error was dropped, so a failure left the
state on its previous value and the same alert was sent again on the next
check, and the one after that, for as long as the write kept failing. The
"could not be evaluated" branch did the same with `partial`. Worse, the
schedule's stamp carries the CLOCK: `last_run_at`, `last_status` and
`next_run_at` in one write. Dropped, a refresh that ran left `next_run_at`
in the past, so the next sweep — a minute later — refreshed the whole
dashboard again, and the one after that: a refresh loop, paid for in
warehouse queries, with nothing on the page to say why. And in
`bi/versions.server.ts`, restoring a version replaced the rows under a
guarded delete and insert and then set the dataset's column list in a
write whose error went unread, leaving exactly the state its own comment
forbids — this version's rows under the previous version's columns —
reported as a restore that worked.

The alert's state writes now say what a failure means for the next check,
naming the alert and the dashboard. The schedule's stamp is retried once
and, failing twice, logged and told to the owner: "The dashboard
refreshed, but the schedule still says it is due: …. It will keep
refreshing every sweep until the schedule can be written." The prep
flow's stamp says what the page will go on showing. And the restore fails
with what is where: "The table now holds this version's rows under the
previous column list — restore it again."

**Driven.** The three writes this round guards are made by the cron
sweep and by a restore: the alert's state and the schedule's clock are
written only by `processDueSchedules`, and no dataset in this account has
a version to restore. What the browser reaches is the surface they drive,
and it is unchanged by the fix. Before, on the R84 container: BI →
dashboard `db14d61a…` → "Scheduled refresh & data alerts" — `Scheduled
refresh` off, the rule's wording `notifies once when it trips and re-arms
when the condition clears`; Data Catalog → Local tables → `snow_prepared`
— `VERSION HISTORY — No previous versions.` After the rebuild (container
`1edfd98ba6c9`), both the same. Every failure path — an alert that would
fire again, a schedule that would refresh again, a restore under the
previous column list — is held by the tests. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 5 source-anchored on the two alert states, the schedule's retry
and its notice, the prep flow's stamp and the restore's failure; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — "Recovered", over an incident still open, and an alert with no incident at all

#### R84 · S1 · The data monitor's records

The survey's next single-site file, `dataMonitors/run.server.ts`. A check
runs, writes its run row — that one insert reads its error — and then
stamps the verdict on the monitor itself, which did not: the run said
`alert`, the monitor's own row went on saying what the previous run had
said, and the page, and anything gating on `last_status`, read the table
as fine. Below it `reconcileIncident` made three writes and read none of
their answers. An alert with no open incident inserted one and read the
row back only for its id, so a failed insert meant an alert with no
incident anywhere and an owner told of one. An alert with an incident
already open extended it — occurrences, last seen, last message —
silently. And a passing check resolved the open incident and told the
owner "Recovered: <name>" whether or not the resolve landed: the
incident stayed open on the page, repeating, while the person had been
told it was over.

The verdict's stamp now reads its answer, says what the monitor will go
on showing, and hands the failure back to the caller as `recordError`. An
incident that could not be opened is said in the audit detail and in the
notification itself — the alert is real either way, so the message goes
out, carrying "the incident could not be recorded: …". An extend that
failed is said. And a resolve that failed no longer says "Recovered": the
notification's title becomes "Recovered, incident still open: <name>"
with the reason, and the audit entry carries it.

**Driven.** Before the fix, on the R83 container: Data monitors → the
alerting monitor `revenue_facts · negative net rows`, its open incident
`seen 16 times · last 6m ago` → Run now — toast `Value 2 is above the
maximum of 0.` and, two seconds later, `seen 17 times · last 1s ago`.
After the rebuild (container `fe257b08f644`) the same: `seen 17 times ·
last 23m ago` → Run now → `seen 18 times · last 1s ago`. The two writes a
still-failing check makes — the monitor's verdict and the incident's
extension — report themselves as before. The resolve path needs the table
to pass, which means changing the data under it, so the "Recovered,
incident still open" title and the failed-open notification are held by
the tests, along with every write that fails: a failed database write
cannot be produced from the browser against the monitor runner. Recorded
in [UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the verdict's stamp and its return, the
extend, the open and its notification, and the resolve's title; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — A build that finished and stayed "running", and an "edited" badge that outlived the build of that edit

#### R83 · S1 · The SQL model build's records

The survey's single-site files begin with the one R60 lives in,
`sqlModels/run.server.ts`, 4 writes with their result dropped. The run's
close dropped its error: a build that had finished — models built, tests
run — stayed `running` on the SQL Models page for ever, with no outcome
and no per-model results to read. `stampModel` dropped two: the model's
`last_status` stamp, so its badge stayed on the PREVIOUS build's outcome,
and the clear of `definition_changed_at` — the "edited … not built since"
mark R60 added — so a model could show as edited and unbuilt over a build
that had just been made of that very definition, the mark lying the other
way from the one R60 fixed. And `writeLineage` deleted the models' edges
and inserted the new ones inside a try/catch that a supabase answer never
reaches: a failed clear drew the new graph beside the old, a failed insert
left it partial, and neither was said.

The run is closed with one retry and, failing twice, said with the run,
the outcome and what the page will go on showing — the R75 shape. The
model's stamps return what they could not write, and the build's own
result carries it: "Built, but the model's record could not be stamped:
…; the page shows the previous build until it is." and "The edited mark
could not be cleared: …; the model shows as edited, not built since, until
the next build." Lineage follows the R82 rule: a failed clear stops the
rewrite and says the old edges stand; a failed insert says the graph is
partial.

**Driven.** Before the fix, on the R82 container: SQL Models →
`stg_revenue` → Build this and what it reads — `Built 1 model`, and the
run on top of Builds as `success · manual · 1m ago · 60.6s · stg_revenue
built 836 rows`. After the rebuild (container `56d9a5952a68`) the same
build, then the round's own pair: the SQL edited by one newline and saved
— `edited 1s ago · not built since`, `last build, of the previous
definition: built · 836 rows · 1m ago` — and built again, after which the
edited mark is gone and the header reads `built · 18s ago · 836 rows`.
Both stamps R83 guards are driven there: the model's outcome, and the
clear of R60's mark by the build of that very edit. The defect half — a
run left "running", a badge left on the previous build or on "edited", a
graph drawn beside what could not be cleared — is held by the tests, a
failed database write not being producible from the browser against the
model runner. Recorded in [UI test results](./UI_TEST_RESULTS.md).

**Tests:** 3 source-anchored on the close and its retry, the stamps and
the build's result, and the lineage rule; 5 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-22 — A crawl that succeeded and left its source "crawling", and a graph drawn over what could not be cleared

#### R82 · S1 · The catalog crawl's records

The server-side write survey's last multi-site file, `catalog/crawler.server.ts`,
6 writes with their result dropped, and the ETL run's lineage delete that
R78 left for it. `runCrawl` marked the source `crawling`, crawled, wrote
the assets, and then dropped the error of marking it `ready`: the assets
were in the catalog, the crawl answered its stats, the page said
"Crawled … 21 assets", and the row stayed `crawling` — refusing every
later crawl as "already running". `persistAssets` reported the stale rows
removed before deleting them and dropped the delete's error, so the
catalog went on listing tables the source no longer had under a crawl
that said it had taken them out. `persistLineage` deleted the previous
edges and inserted the new ones, reading neither answer: a failed delete
drew the new graph beside the old one, a failed insert left it partial,
and the crawl's catch swallowed both as "optional". The ETL run cleared
its pipeline's lineage the same way before re-inserting it; the schema
records that drift is judged against went unread too.

The source is now marked ready with one retry and, failing twice, the
crawl fails with the reason — "Crawled N asset(s), but the source could
not be marked ready: …. It will show as crawling until it is — crawl
again." — so the row says what happened rather than what is not
happening. Stale assets are claimed removed only once they are, and a
delete that failed fails the crawl. Lineage is never written beside what
could not be cleared: a failed clear stops the rewrite and says the old
edges stand, a failed insert says the graph is partial, and the crawl's
catch says why instead of nothing. The ETL run's lineage follows the same
rule, and its schema records read their answers.

**Driven.** Before the fix, on the R81 container: Data Catalog → `Lakehouse
catalog` → Re-crawl — a spinner on the source, the asset list growing as
the crawl wrote, and 85 s later `Crawled "Lakehouse catalog" — 21 assets,
184 columns · 11 added`, the spinner gone. After the rebuild (container
`d218d394edca`) the same re-crawl: 23 s later `Crawled "Lakehouse catalog"
— 21 assets, 184 columns`, the source `ready`. A crawl whose writes land
reports itself as before; the defect half — a source left "crawling" over
a crawl that succeeded, stale assets claimed removed, a graph drawn beside
what could not be cleared — is held by the tests, a failed database write
not being producible from the browser against the crawler. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the stale claim, the lineage rule on both
paths, the ready mark and its retry, and the crawling and error marks; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — "Promoted", by the API and the schedule, whatever the three writes did

#### R81 · S1 · The promotion the API and the schedule make

R73 fixed the page's promotion: five writes, each read, in the order a
failure part-way leaves least — stage, pointer, archive. The survey's next
file, `ml/api.server.ts`, holds a second promotion, `promoteVersion`, used
when a version is registered from outside through the ML API and when a
scheduled retrain judges its candidate better: the same three writes in
the old order — archive, stage, pointer — and every error dropped. A
promotion that failed at the pointer left the model serving nothing with
its old version already archived; one that failed at the stage left the
model pointing at a version not marked production; and either way the API
answered `201` with the version, and the schedule wrote `promoted` and
told the owner "v N is now in production".

The API-path promotion is now the guarded one: it reads the version and
hands it to `applyPromotion`, answering as that went. A registration whose
promotion failed still registers the version and says so — `promoted:
false` and `promotion_error` in the API's answer. The schedule reads the
answer: `last_status` says `kept`, `last_error` carries the reason, and
the owner is told "v N trained, but could not be promoted" with it; the
schedule's own verdict write reads its answer too.

**Driven.** Before the fix, on the R80 container: `revenue_facts · groups`
→ Automation → `Nightly retrain · promote when better` → Run now —
`Training started`; the schedule `kept 4m ago`; the bell `"revenue_facts ·
groups" v25 trained; production kept · silhouette: 0.2490 vs production
0.2490 (not better)`. After the rebuild (container `09f1a7bb3de1`) the
same: `Training started`, Versions (26), the schedule `kept 2m ago`, the
bell `v26 trained; production kept … (not better) · just now`. A verdict
whose promotion is not attempted, or whose writes land, reports itself as
before; the defect half — a promotion that failed part-way said as made,
on the API and the schedule — is held by the tests, a failed database
write not being producible from the browser against a server function,
and the API path needing a key and an artifact these rounds never mint.
Versions v25 and v26 are kept as candidates. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 3 source-anchored on the delegation and its answer, the
registration and the route, and the schedule's verdict and notification;
4 behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — A container the session never learned of, and a stopped one whose row stayed live

#### R80 · S1 · The sandbox session's own record

The server-side write survey reaches the file under every ML endpoint,
training worker, ETL run and notebook kernel: `notebookRuntime/service.server.ts`,
7 writes with their result dropped. `startSession` created the container
and then wrote its ref onto the session row without reading the answer. A
write that failed left a container running that its row did not know:
`stopSession` stops by the ref, `refreshSession` returns early without
one, the reaper's stop is a no-op — a sandbox nothing could reach, under a
row that stayed live and counted against the caps. R77, R78 and R79 each
guarded their own record of a session; this is the record they all rest
on. `stopSession` stopped the container and dropped the error of marking
the row stopped: a dead container listed as running, counted, reaped
again. `refreshSession` handed its caller the reconciled state and dropped
the write that would have put it in the table. `touchSession` dropped the
write the idle reaper reads, so a kernel in use could be taken for idle.
And the error marks on a start that failed, and the app's stopped mark
after a reaped service, went the same way.

A container the row could not take is now stopped again while the ref is
in hand, and the start fails as a start: "The sandbox started but its
session could not record it: …; it was stopped again." A stopped
container's row that could not be marked is said, with what the next
refresh will do; a reconciliation that could not be written is said with
what the table still says; an unrecorded touch is said for the reaper's
sake; the error and app marks read their answers.

**Driven.** Before the fix, on the R79 container: Developer workspace →
`My Python notebook` → Run cell — `Starting kernel…`, the runtime API
answering a session `starting` then `ready`; Running kernels `1 live ·
ready`; Stop — `Kernel stopped`, the panel gone. After the rebuild
(container `c28597f45d18`) the same: a new session `ready` after eleven
polls, `1 live · ready`, `Kernel stopped` 8 s after Stop. A session whose
ref and stopped mark land reports itself as before; the defect half — a
container the row could not take left running, a stopped container's row
left live — is held by the tests, a failed database write not being
producible from the browser against the runtime service. Seen both
times: the page then reports `Kernel connect timed out` over the ready
kernel, `NOTEBOOK_GATEWAY_URL` being unset in this deployment. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 6 source-anchored on the container stopped again, the two error
marks, the reconciliation, the stop, the touch and the app mark; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — A job "succeeded" over a version left training, and workers the job never learned of

#### R79 · S1 · The training job's records

The server-side write survey's next file, `ml/train.server.ts`, 9 writes
with their result dropped. The one that matters most sits at the end of
`writeTrainOutcome`: the job row was claimed `succeeded` — a conditional
update, read back — and then the version's `ready` write, with the
artifact, the metrics and the stage, dropped its error. A write that
failed left a finished job over a version `training` for ever, with no
artifact on its row: the Jobs tab said succeeded, the Versions tab said
training, nothing would ever serve it, and "promote when better" could not
choose it. The model's production pointer after an automatic promotion
dropped its error the same way — the state R73 named, a version marked
production that nothing serves. `startTrainingJob` wrote the started
workers onto the job without reading the answer: workers running that the
row did not count, so cancel could not reach them and the merge waited for
callbacks the row did not know to expect. And the version's `failed` and
`cancelled` marks, the training snapshot, the partial logs and the
assembling worker's record all went the same way.

The version is now recorded with one retry and, failing twice, the job is
failed with the reason — "The model trained, but its version could not be
recorded: …. Train again." — written onto the job, said to the owner, and
the success audit and promotion withheld, so the outcome and the record
agree. Workers the job row could not take are stopped again while their
ids are in hand, and the job fails as a job. A production pointer that
could not be set is said with what to do. The failed and cancelled marks,
the snapshot, the logs and the assembling worker each read their answer.

**Driven.** Before the fix, on the R78 container: `revenue_facts · groups`
→ Train new version, budget 5 → `Training started`; Jobs `running 19s` then
`succeeded 38s kmeans_k2 · Silhouette 0.249`; Versions `v22 candidate`;
again, `succeeded 12s`, `v23 candidate` — too fast for a cancel to be
driven. After the rebuild (container `9112063e9cde`) the same: `Training
started`, `succeeded 52s`, `v24 candidate kmeans_k2 0.249 836`, `v1
production` unchanged. A job whose version write lands reports itself as
before; the defect half — a job "succeeded" over a version left
"training", workers the row never learned of — is held by the tests, a
failed database write not being producible from the browser against the
training service. Versions v22–v24 are kept as candidates. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the workers stopped again, the version's
retry and the job failed in its stead, the pointer said, and the failed and
cancelled marks; 5 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-22 — A run cancelled on screen, a sandbox the run never learned of, a watermark not kept

#### R78 · S1 · The ETL run's records

The server-side write survey's next file, `etl/service.server.ts`, 13
writes with their result dropped, and the page above them. Three change
what a person and the next run believe. `startRunSandbox` started the
sandbox and then wrote the run's `running` state and `session_id` without
reading the answer: a write that failed left a sandbox running that the
run row did not know — nothing could cancel it, since cancelling stops by
session id, and the reconciler saw a queued run with nothing behind it.
`cancelEtlRun` dropped the cancel's error, returned `true`, and stopped
the sandbox anyway: a row still `running` over nothing, for ever. And
`persistEtlWatermarks` dropped each upsert's error after a run that
succeeded: a cursor the next run does not have, so it reads from the
previous one and loads the same rows again — silently, under a green
badge. Above all three, the page: both cancel handlers said "Stopping",
or nothing, whatever the server answered; pressed on a run that had just
finished, Cancel did nothing and said nothing.

A sandbox whose session the run row could not take is stopped again while
the id is in hand, and the attempt fails as an attempt. A cancel writes
the record first and, if it cannot, says so and stops nothing: "The run
could not be marked cancelled: …. It is still running — try again." — and
a run that is not running is answered as such. The watermarks a successful
run could not keep are returned node by node and written onto the run:
"Succeeded, but the watermark could not be saved for …. The next run reads
from the previous cursor." The pipeline's status stamps, the attempt
counter, the partial logs, the progress record, the released cluster's ref
and the consumed ingest events each read their answer and say what a
failure leaves. The page reads the cancel's answer — "Could not stop the
run" and "Could not cancel the run", with the server's reason — or, when
the call itself never reached the server, with that. Left for the catalog
round: the lineage delete before the re-insert.

**Driven.** Before the fix, on the R77 container: `bi_seed` → Run → `Run
started`; Cancel pressed on the run as its sandbox finished — no toast of
any kind, the row `Succeeded` a moment later; Cancel pressed 14 s into the
next run — no toast, the row `Cancelled`. After the rebuild (container
`906b223c7b32`): a cancel that lands shows the row `Cancelled … 11s`; one
whose call is rejected says `Could not cancel the run · Failed to fetch.
It is still running.` over a row still `Running`; one the server refuses,
the sandbox having finished a second earlier, says `Could not cancel the
run · That run is not running.` over the row `Succeeded … 17s`. The
server side — the cancel's write, the sandbox's session, the watermarks —
is held by the tests, a failed database write not being producible from
the browser against a server function. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 6 source-anchored on the sandbox stopped again, the cancel's
order and answer, the server function and the page on both of its failure
paths, the watermarks returned and said, and the two stamps; 7
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — "Serving", over a row that said starting; "stopped", over one that said ready

#### R77 · S1 · The ML endpoint's state writes

The server-side write survey's largest cluster: `serve.server.ts`, 23
writes with their result dropped. Three of them change what the page and
the scorer believe about a running sandbox. The ready stamp at the end of
`ensureDeployment` — the copy up and answering, the row still `starting`
— dropped its error and the call answered ok; the next call, not seeing
`ready`, retired the healthy copy and started another, and did so on every
call for as long as the row stayed so. `undeploy` returned nothing either
way over three writes, so "Endpoint stopped" was said with every copy gone
and the row still `ready` — the address of a stopped sandbox, handed to
the next caller. And a copy whose `session_id` write failed was a copy
nothing could ever stop, since retiring stops by session id. The same in
`setCandidate`: a candidate copy up, the row not naming it, the mirror
never using it, nothing stopping it. `touch` wrapped its writes in a
try/catch that a failed write never reaches, so a served request could go
unrecorded and the idle reaper, which reads what was recorded, take a busy
endpoint for an idle one.

A state the record could not take is now said, and a copy the record
cannot describe is stopped rather than left running. The ready stamp is
retried once and, failing twice, answered as a failure that names the
state left: "It will show as starting, and the next Deploy will replace
the copy, until it is." `undeploy` answers with every write that failed —
"Every copy is stopped, but the endpoint's record could not be updated
(…). It will show as it was until it is — press Stop again." — and the
server function passes that on. A copy whose session or ready state could
not be written is stopped again with the id still in hand. A candidate
the record could not name is retired. `touch` reads its writes' answers
and says what the reaper will see. The autoscaler's per-minute readings
and the mirror's bookkeeping keep their fire-and-forget: a reading is
remeasured a minute later, and nothing decides on it in between.

**Driven.** Before the fix, on the R76 container: ML Models →
`revenue_facts · groups` → Automation → Deploy — `Starting the endpoint and
loading the model…`, a scorer sandbox up, the server function answering
`{ ok: true, version: 1 }`, `Serving v1`, the panel `Warm endpoint serving
v1`; Stop — `{ ok: true }` after 24 s, `Endpoint stopped`, `Warm endpoint
off`. After the rebuild (container `46df8dfdd4a3`) the same deploy and
stop, the same answers, toasts and panel states. A deploy whose stamp lands
and a stop whose writes land report themselves as before; the defect half —
ok over a stamp that failed, "stopped" over a row still ready, a copy
nothing could stop — is held by the tests, a failed database write not
being producible from the browser against a server function. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 9 source-anchored on the stamp and its retry, the copy stopped
again on either failed write, the retire's answer, `touch`, `undeploy` and
its server function, and the candidate paths; 6 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-22 — The previous base's documents, under the next base's name

#### R76 · S2 · The Knowledge Bases page across a base change

Seen while driving the sibling paths of R64. Pick `RAG eval · Halvard
Systems` (12 documents), then `Test` (none): for the seven seconds the
second read spent failing under the client's retries, the page showed
`Test` as the heading and the twelve Halvard documents beneath it, with the
tab reading `Documents (12)`; and when the read had failed and the alert
took the panel, the tab still read `Documents (12)`. Nothing cleared the
previous base's rows: `docs` was replaced only when the next read landed,
and the tab counted whatever `docs` held. A slow read did the same as a
failed one, for as long as it took — and a read that came back late, for a
base no longer selected, would have replaced the current base's list with
the old one's.

Picking a base now clears its predecessor's documents, sources and chunk
counts before the read, marks both lists loading, and drops a read that
comes back for a base no longer selected. The panels say `Loading
documents…` and `Loading sources…` ahead of their empty states, and the
tab counts follow the read: `…` while it is pending, `?` when it failed,
the number once it has been made. The count helper, `listCountLabel`, sits
beside `listState` in `src/lib/listState.ts`.

**Driven.** Before the fix, on the R75 container: `RAG eval · Halvard
Systems` (12 documents), then `Test` with every read of
`knowledge_documents` rejected — 2.5 s in, the heading `Test` over the
twelve Halvard documents and `Documents (12)`; 10 s in, the alert and
`Documents (12)` still on the tab. After the rebuild (container
`ae7506f1384c`), both reads rejected: 2.5 s in, nothing listed, `Loading
documents…`, `Documents (…)` and `Sources (…)`; 10 s in, the alert,
`Documents (?)` and `Sources (?)`; with fetch restored, `No documents in
this knowledge base.` and `Documents (0)`. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 unit on the count label; 4 source-anchored on the clearing,
the late-read guard, the tab counts and the loading branches; 5
behaviour-changing mutants each killed, control missed, baseline green
first.

### 2026-09-22 — A run that finished and stayed "running" for ever

#### R75 · S1 · The workflow runner's closing writes

The server-side write survey's next file, and the one where a dropped
error is not a wrong word but a wrong state that never corrects itself.
`closeRun` wrote the run's outcome with a conditional update — only the
replica that still saw the run as running wins — and read back `won` alone:
`if (!won?.length) return; // another replica closed it first`. A close
whose write FAILED produced the same empty `won`, and so returned without
a word. The run stayed "running" for ever on the Workflows page, the
workflow's last status stayed "running", no audit entry said what the run
did, and the owner who had asked to be told on failure was not told. The
workflow's status stamp and every node's final write dropped their errors
the same way.

A failed close is now told apart from a close another replica made: it is
retried once a second later, and a second failure is logged with the run,
the outcome and what a person needs — "It will show as running until it is
closed." The workflow's stamp keeps its error and says so, and the audit
entry and the notification still go out for a run that did close. A node's
final write says when the step is over but its record is not.

**Driven.** Before the fix, on the R72 container: Workflows → `Test`, a
Wait step of 2 seconds added and saved, Run now — `Run started`, and ten
seconds later `Test manual · less than a minute ago succeeded`, the Runs
tab `succeeded less than a minute ago · manual`. After the rebuild
(container `0dd063722838`) the same run: the same toast, the list and the
Runs tab closing it the same way, two runs now listed. A run whose close
lands reports itself as before; the defect half — a failed close read as
another replica's — is held by the tests, a failed database write not
being producible from the browser against the server-side runner.
Recorded in [UI test results](./UI_TEST_RESULTS.md).

**Tests:** 5 source-anchored on the close, its retry, its message, the
stamp and the node write; 4 behaviour-changing mutants each killed, control
missed, baseline green first.

### 2026-09-22 — "Dropped", with the catalog row that lists it still there

#### R74 · S1 · The lakehouse schema drop and materialized-view removal

The server-side write survey's next file. Dropping a schema runs `DROP
SCHEMA … CASCADE` on the lakehouse, then deletes the schema's catalog row
and its grants — and both deletes dropped their error before the audit
entry said dropped. A schema whose row survived stayed on the Lakehouse
page pointing at a schema that no longer existed, and its grants named it
still. Removing a materialized view did the same with one delete, and a
view whose row survived kept refreshing on its schedule.

Each delete keeps its error now, and the answer says what is already true:
"The schema was dropped, but its catalog entry could not be removed: <why>.
It will still be listed until it is; drop it again to retry." — the grants
likewise — and "Could not remove the materialized view: <why>. It is still
defined and will still refresh on its schedule." The audit entry is written
only after every row is gone.

**Driven.** Before the fix, on the R72 container: Lakehouse → New schema
`r74_probe` → Create, then its drop — `Dropped r74_probe`, the explorer
stale until a reload. After the rebuild (container `0dd063722838`) the
same create and drop: `3 schemas · 21 tables` with `r74_probe (0)`, then
`Dropped r74_probe` and `2 schemas · 21 tables` with the schema gone, on
the page and after a reload. A drop whose catalog-row deletes land
reports itself as before; the defect half — done reported over a row
that stayed — is held by the tests, a failed database write not being
producible from the browser against a server function. Recorded in
[UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the three deletes, their messages and the
audit's place; 3 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-22 — "vN is now in production", over writes that could have failed, in an order that could leave none

#### R73 · S1 · The ML promotion's four writes

The server-side write survey — 237 error-less writes in 64 files — taken
to the one that changes what agents and dashboards compute with. Promoting
a version ran four writes in `applyPromotion` and returned `{ ok: true }`
whatever they answered: the page then said "v21 is now in production" from
that answer. And the order was the worst one for a failure part-way:
archive the old production version first, then point the model at the new
one, then mark the new one — so a failure at the second step left a model
serving nothing, with its former production version already archived.

Each write keeps its error now and the answer names the step and what is
true after it: "Could not mark v21 as production: <why>. Nothing changed.";
"Could not switch the model to v21: <why>. The model still serves its
previous version; v21 is marked production but not served — promote it
again."; "v21 is now served, but the previous production version could not
be archived: <why>. Two versions are marked production until it is." The
order is now the one that never leaves a model with no production version:
the version's own stage first, the model's pointer second, the archive of
the old one last. The audit entry is written only after every write landed.

**Driven.** Before the fix, on the R72 container: `revenue_facts · groups`,
v21 promoted and v1 promoted back — `v21 is now in production`, `v1 is now
in production`, the states following each. After the rebuild (container
`0dd063722838`) the same two promotions, the same toasts and states, the
fixture left as found (v1 production, v21 archived): a promotion whose
five writes land reports itself as before. The defect half — `ok: true`
over a write that failed — is held by the tests; a failed database write
cannot be produced from the browser against a server function. Recorded
in [UI test results](./UI_TEST_RESULTS.md).

**Tests:** 4 source-anchored on the writes, their errors, the order and
the audit's place; 3 behaviour-changing mutants each killed, control
missed, baseline green first.

### 2026-09-22 — A message deleted on screen that came back on reload

#### R72 · S1 · Agent Chat's four deletes

The write-side survey's last file, back on the Agent Chat page. Press
Delete on a bubble with every `DELETE` to `messages` rejected: nine bubbles
where there were ten, nothing said; reload: ten. Four deletes on the page
dropped their error — a message, a chat, the reply a regenerate replaces,
the tail an edit-and-resend replaces — and the last two were worse than
silent: a regenerate whose old-reply delete failed streamed a fresh reply
on top of the old one, and a resend whose tail delete failed inserted the
edited message above the tail it was meant to replace, so a reload showed
both threads.

Each keeps its error now. A message or chat that could not be deleted comes
back on screen — "Could not delete the message: <why>. It is still in the
conversation." — and a regenerate or resend that could not remove what it
replaces restores the conversation and stops: "The previous reply could not
be removed, so it stands." The write survey (40 error-less client writes in
10 files) is closed with this round; what remains of it — the swarm chat
dialog's insert and update, the add-source dialog's insert, evaluations'
two deletes — each reload from the table after the write and so cannot show
a phantom row, and are left as noted.

Driven, before: nine bubbles over a rejected delete, nothing said, ten after
a reload. After the rebuild, the same rejection: ten bubbles at once and the
toast `Could not delete the message · TypeError: Failed to fetch. It is
still in the conversation.` No real delete was made.

**Tests:** 5 source-anchored on the four deletes, their undo and their
stopping; 5 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-22 — Thirty notifications cleared on screen, none in the database

#### R71 · S1 · The notification bell's three writes

The write-side survey's next file. Open the bell — thirty unread — and
press Clear with every `DELETE` to `notifications` rejected: "No
notifications — dashboard alerts and scheduled-refresh results land here.",
the badge loses its count, and nothing is said. Reload: thirty unread. The
bell's three writes — clear all, mark all read, mark one read — were all
optimistic and dropped their error, so the badge a person had just silenced
came back on the next page, and the alert they had dismissed had never been
dismissed.

Each keeps its error now and undoes itself on screen: the list and the
badge return to what is stored, and a toast says "Could not clear the
notifications: <why>. They are still there." — or "still unread" for the
read marks.

Driven, before: the popover empty and the badge without its count over a
rejected delete, nothing said, thirty unread after a reload. After the
rebuild, the same rejection: the list back at once, the badge at thirty
unread, and the toast `Could not clear the notifications · TypeError:
Failed to fetch. They are still there.` No notification was cleared.

**Tests:** 4 source-anchored on the three writes, their undo and their
messages; 4 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-22 — An alert switched off that was still on, and would still fire

#### R70 · S1 · The BI schedule dialog's writes

The write-side survey's next file. Add a data alert to a dashboard —
`Total Sales · row count > 1`, switch on — and press its switch with every
`PATCH` to `bi_alerts` rejected: the switch goes off on screen, and nothing
is said. Reload: the switch is on. The alert was never switched off, and
would have fired on the next scheduled refresh while its owner believed it
silenced. Every write in the dialog was like this: removing the schedule
(the refresh kept running, the dialog showed none), deleting an alert (it
left the list and kept firing), the alert's email setting.

Each keeps its error now. A switch that could not be switched is undone on
screen and says "Could not switch the alert off: <why>. It is still on and
will still fire."; a delete that failed says "It is still set and will
still fire."; a schedule that could not be removed says "It is still
scheduled."; the email setting says "It is unchanged." The dialog shows
what is stored, never only what was pressed.

Driven, before: the switch off on screen over a rejected update, nothing
said, on again after a reload. After the rebuild, the same rejection: the
switch back on at once and the toast `Could not switch the alert off ·
TypeError: Failed to fetch. It is still on and will still fire.`; with
`fetch` restored, the fixture alert deleted for real.

**Tests:** 5 source-anchored on the four writes, their undo and their
messages; 5 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-22 — "Provider disconnected", with the key still stored and the card still Connected

#### R69 · S1 · The Integration Hub's three disconnects

The write-side survey's next page. Disconnect OpenRouter — the dialog says
"The stored key is deleted, not disabled" — with every write rejected:
`Provider disconnected`, and the card reloads still `Connected`, Disconnect
button and all. Three writes on the page dropped their error: the encrypted
provider's credential delete, the integrations-row provider update (the
path OpenRouter takes, which the single-line survey had not listed — the
statement spans four lines), and the notification channel's update.

Each keeps its error now and says what is still true: "Could not
disconnect the provider: <why>. The key is still stored and the provider is
still connected." — or "The provider is still connected." on the row path,
and "The channel is still connected." for a channel — and none says
"disconnected" or reloads until the write landed.

Driven, before: `Provider disconnected` over a rejected update, the card
still Connected after a reload. After the rebuild, the same rejection:
`Could not disconnect the provider · TypeError: Failed to fetch. The
provider is still connected.`, the card still Connected with its Disconnect,
and no "Provider disconnected". No real disconnect was made.

**Tests:** 4 source-anchored on the three writes, their messages and the
order of failure before success; 4 behaviour-changing mutants each killed,
control missed, baseline green first.

### 2026-09-22 — "Document deleted", and the document listed in the same breath

#### R68 · S1 · The Knowledge Bases page's three deletes

The write-side survey's next page. Add a document to a knowledge base,
press Delete, confirm "Its chunks and embeddings go with it…" with every
`DELETE` to `knowledge_documents` rejected: `Document deleted` — and
`Documents (1)`, the document still listed, because the list reloads from
the table where the row still is. Reload: still there. The base delete and
the documents-of-a-source delete did the same; only the source row's own
delete checked its error.

The order on this page is deliberate and kept: the vectors are forgotten
first, while the rows that prove ownership still exist. That order gives a
failed row delete a consequence worth saying — the embeddings are gone, the
row is not — and the message now says it: "Could not delete the document:
<why>. Its embeddings were already removed — re-index the knowledge base to
restore retrieval." Each of the three deletes keeps its error, returns
before "Deleted" or a reload, and the base and source variants say the same
in their own words.

Driven, before: `Document deleted` over a rejected delete, the document
listed in the same breath and after a reload. After the rebuild, the same
rejection: `Could not delete the document · TypeError: Failed to fetch. Its
embeddings were already removed — re-index the knowledge base to restore
retrieval.`, the document still listed and no "Document deleted"; with
`fetch` restored, `Document deleted` and `Documents (0)` — the fixture gone
for real.

**Tests:** 4 source-anchored on the three deletes, their messages, their
returns and the vectors-first order; 5 behaviour-changing mutants each
killed, control missed, baseline green first.

### 2026-09-22 — "Swarm deleted", and the swarm was still there

#### R67 · S1 · The swarm canvas's own create and delete

The write-side survey's next page. The swarm gallery already says "Failed
to create swarm" and "Failed to delete" — with every `POST` to `swarms`
rejected, its New Swarm says exactly that. The canvas has its own create
and delete, and neither said anything. Open a swarm, press Delete swarm,
confirm "Swarm 16 will be permanently removed…" with every `DELETE`
rejected: `Swarm deleted`, and the canvas moves on to Swarm 1. Reload the
gallery: `My Swarms 16`, Swarm 16 still there. The canvas said the swarm
was gone and moved on; the swarm was not gone. Its create did the opposite:
a failed insert did nothing at all — no swarm, no word.

The delete keeps its error, and a delete that fails changes nothing on
screen and says "Could not delete the swarm" with the reason; the list and
the canvas stay as they are. The create keeps its error and says "Could not
create a swarm"; the fresh swarm the canvas opens after the last delete
says when it could not be created instead of leaving an empty canvas with
no swarm behind it.

Driven, before: `Swarm deleted` over a rejected delete, the canvas moving
on, the swarm back in the gallery on reload. After the rebuild, the same
rejection: `Could not delete the swarm · TypeError: Failed to fetch` and the
canvas staying on the swarm; with `fetch` restored, `Swarm deleted` and the
gallery back to fifteen — the fixture gone for real.

**Tests:** 3 source-anchored on the canvas's create, delete and the fresh
swarm after the last delete; 4 behaviour-changing mutants each killed,
control missed, baseline green first.

### 2026-09-22 — A cap that was never saved, under a button that said "auto-saved"

#### R66 · S1 · The Budgets page's writes

The write-side survey's next page. Reject every `PATCH` to
`budget_settings` and type a monthly cap of 25 over the saved 20: the cap
reads 25, the strip reads `Month-to-date spend: $1.79 / $25.00`, and there
is no toast. Press the page's own button: `All settings auto-saved`. Reload:
20. A cap that was never saved was the cap on screen, and the page said so
in so many words — on a page whose one job is to state what the platform
will refuse to spend past.

Every write on the page was optimistic and dropped its error: the budget
update, the per-agent limit update, the per-agent limit insert. The button
toasted a constant. A write that fails is now undone on screen, said in a
toast with the reason ("The value shown is what is saved."), and recorded;
the page's status line is derived by a pure `saveStatusText` from what the
last write did — "Settings auto-save on change" before any write, "Saved
HH:MM" after one that landed, "Not saved — budget: …" after one that did
not — and pressing it toasts the same truth.

Driven, before: cap 25 on screen over a rejected save, `All settings
auto-saved` on the button, 20 after a reload. After the rebuild, the same
rejection: the cap back to 20 at once, the toast `Could not save the budget
· TypeError: Failed to fetch. The value shown is what is saved.`, the status
`Not saved — budget: TypeError: Failed to fetch`; with `fetch` restored, a
real change to 21 reads `Saved 12:56 AM`, and back to 20 for the fixture.

**Tests:** 3 behavioural on `saveStatusText`, 3 source-anchored on the
page's three writes, the undo and the status; 6 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-21 — A turn that was never saved looked exactly like one that was

#### R65 · S1 · Agent Chat's message inserts

The failed-read survey's largest file, the Agent Chat page, and the
write-side twin of the class. Reject every insert to `messages` and send a
probe: "You: R65 probe: reply with the single word OK" · "Assistant: OK" —
twelve bubbles where there were ten, two POSTs rejected, no toast, no mark.
Reload: ten bubbles; the probe turn is gone. Nothing distinguished the two
unsaved messages from the ten saved ones until they were not there.

Five of the page's six message inserts — the user's message, its edited
resend, the assistant's reply on both paths, the BI answer, the document
prompt — read `const { data } = await …insert()` and dropped the error; only
the document save warned ("built, but not saved to this conversation").
Every insert now goes through one `persistMessage`: on failure the on-screen
message is marked `unsaved` with the reason, the bubble says "not saved — it
will not be here after a reload" under the sender's name, and a toast says
why. The two conversation reads keep their error too: a failed
`conversations` read used to be an empty list, and an empty list creates a
fresh "New Chat" — so a network blip could bury the real conversations
under a new one; it now says so and creates nothing.

Driven, before: twelve bubbles, no mark, no toast, ten after a reload.
After the rebuild, the same rejection: under both new bubbles `not saved —
it will not be here after a reload` with the fetch error on hover, and the
toast `This message was not saved to the conversation · TypeError: Failed
to fetch. It will not be here after a reload.` read seconds after the send;
ten bubbles after a reload, as the marks said.

**Tests:** 6 source-anchored on the helper, the six call sites, the bubble
and the two reads; 6 behaviour-changing mutants each killed, control
missed, baseline green first.

### 2026-09-21 — "No agents yet", over nine agents it could not read

#### R64 · S1 · The Agent Builder and Knowledge Base lists

The failed-read survey (55 error-less client reads in 25 files), taken to
the two builder pages every other page starts from. Reject every request for
`agents` and reload the Agent Builder in-app: `No agents yet` — "Create your
first agent to get started — pick a model, write a system prompt, and add
tools as you go." — and a `New Agent` button, over nine agents. Reject
`knowledge_bases` and reload the Knowledge Bases page: `No knowledge bases
yet.` over six. Nothing on either page says a read failed; the obvious
response to either screen is to make another one.

Both pages dropped their read's `error`. The Agent Builder had already
learned that "not fetched yet" is not "none" (its `loaded` flag, for the
first paint), and still had no third state for "could not fetch". A pure
`listState` now says which of loading, error, empty and list a surface may
show — an error ahead of empty and ahead of loading, because a read that
failed is not still loading and is not nothing — and the Agent Builder
renders "Could not load your agents" with the reason and a "Try again"
ahead of its empty state. The Knowledge Bases page keeps the error of each
of its three list reads (bases, documents, sources) and renders each ahead
of the empty state it used to hide behind, as an alert with the reason.

Driven, before: `No agents yet` with its call to action over nine agents,
`No knowledge bases yet.` over six, each with every request for the table
rejected. After the rebuild, the same rejections: `Could not load your
agents · TypeError: Failed to fetch · Try again`, and the nine agents back
when `fetch` is restored and Try again pressed; `Could not load your
knowledge bases: TypeError: Failed to fetch` as an alert, and no empty state
on either page.

**Tests:** 3 behavioural on `listState`, 3 source-anchored on both pages'
reads and the order of their states; 6 behaviour-changing mutants each
killed, control missed, baseline green first.

### 2026-09-21 — "Everything is running", from counts that could not be read and one that could never fire

#### R63 · S1 · The home dashboard's status band

The landing page opens with one sentence — "Everything is running", or "N
things need attention" with a chip for each — built from seven counts. Two
things were wrong with how they were built, and both were found by driving
the page.

**A chip that could never fire.** Give `stg_revenue` a row-count test of
100 (it has 5 rows), build: `failed · row_count_min on the table failed`.
Open the dashboard: `1 thing needs attention · 1 open data incidents` and no
"SQL models failing" chip; the SQL models card says `2 models` with no
warning. The count asked `sql_models` for `last_status = 'error'`, and the
column cannot hold that value — its check constraint allows `built`, `failed`
and `skipped`. Every failing model has been "Everything is running" since the
chip shipped. Sweep item 3's shape — a claim the evidence cannot support —
in its simplest form: a predicate on a value that does not exist.

**A failed read as zero.** Reject every `/rest/v1/etl_runs` request and
reload the page in-app: `1 thing needs attention · 1 open data incidents`,
checked a minute later, and nothing about pipeline runs — the check is
absent, not unknown. Every count landed as `count ?? 0`, with a comment
explaining that a table a deployment has not migrated should not fail the
page. Right for that case; wrong for a read that failed for any other reason,
because zero is the most reassuring possible way to display "we have no
idea". Sweep item 1's shape, on the one page built to say whether the
platform is healthy.

The predicate now asks for `failed`. Each count is a number when its read
answered and `null` when it did not; the band is derived by a pure
`bandSummary`: "Everything is running" only when every check answered and
none found anything; "Nothing failing among what could be checked — N checks
could not be read" when the unread are the only news; "N things need
attention · M checks could not be read" when both. An unread check is a chip
of its own — "? pipeline runs failed today — could not be read", the reason
on hover — never a zero, and each card's warning line says "could not be
checked" for its own. The docs say so.

Driven, before: `1 thing needs attention · 1 open data incidents` over a
model that had just failed its build, and the same sentence with every
`etl_runs` request rejected. After the rebuild: `2 things need attention ·
1 open data incidents · 1 SQL models failing`, the card `2 models · 1
failing`; with the request rejected, `2 things need attention · 1 check
could not be read` and a chip `? pipeline runs failed today — could not be
read` whose hover text is `TypeError: Failed to fetch`, the ETL card `20
pipelines · could not be checked`.

**Tests:** 5 behavioural on `bandSummary`, 4 source-anchored on the page's
reads, the predicate, the cards and the band; 6 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-21 — "Jobs (20)" on a model with twenty-one versions

#### R62 · S2 · The ML model page and its runs: a capped list's length as the count, and failed reads as "nothing yet"

Sweep 2's last named row, ML predictions. Open `revenue_facts · groups` —
"21 versions" on its card — and the tabs read `Versions (21)` and `Jobs (20)`;
the Jobs tab lists twenty rows, oldest "17d ago", and nothing says there
are more. `mlGetModel` read the newest twenty training jobs and the page
printed the length of what came back. The Predictions tab did the same with
the newest fifty runs (`mlListPredictions`), and the Accuracy and Fairness
panels searched those fifty for the newest successful batch run and called
an older one "No successful batch run to measure yet".

The same two handlers dropped the error of every read they made: a failed
versions read was `Versions (0)` and no production version, a failed jobs
read "No jobs yet.", a failed runs read "No predictions yet." — sweep item 1's
shape, in the one module the named list never reached.

Each read now throws with what could not be read, and the page shows the
failure. Each list fetches one row past what it shows (`capList`, the twin of
R61's `semanticTrim` for lists that are not queries) and says when it goes
on: `Jobs (20+)` with "The newest 20 jobs. Older jobs exist and are not listed
here." under the table; the same note under the Predictions tab; and the two
panels say "No successful batch run among the newest 50 runs — older runs
are not searched" instead of "none". The docs say which lists are the newest
N and that a failed read is shown as one.

Driven, before: `Versions (21)` · `Jobs (20)`, twenty rows, no note. After
the rebuild, the same model: `Jobs (20+)`, and under the twenty rows "The
newest 20 jobs. Older jobs exist and are not listed here."; the Predictions
tab lists its eleven runs with no note, being under its cap. The failed-read
half is server-side and held by the tests.

**Tests:** 2 behavioural on `capList`, 7 source-anchored on both handlers
and every surface; 9 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-21 — The governed query that stopped at its cap and never said so

#### R61 · S2 · "100 row(s)" over 9,994 groups, and three more places the prefix was the whole

Sweep 2's next row, the semantic layer. `total_sales` by `order_id` on the
SaaS Sales model — 9,994 orders — run from the Semantics page: `100 row(s)`,
`LIMIT 100` in the compiled statement, a hundred rows in the table. The page
asks for a hundred and nothing says the query has more. The cause is one
level down: `runSemanticQuery` fetched AT its cap and so could not tell a
result of exactly cap rows from one of more, and returned no verdict either
way. Every consumer then decided for itself, and most decided "whole":

- the Semantics page counted the prefix;
- a dashboard widget's **parameter re-run** asked for `limit: 100` — a tenth
  of the widget's own cap — and stored the rows over whatever `truncated` the
  widget already had, so a widget of a thousand rows quietly became a hundred
  with no Partial badge;
- the AI Analyst's governed step wrote `capped: false` over a result the
  runner had cut at a thousand, so a total or a ranking over "revenue by
  customer" was summarised from a thousand of many more, and the write-up was
  never told;
- the scheduled BI refresh guessed from `rows.length >= cap`, which also
  flags a result of exactly a thousand rows that was complete.

Only the agent's `metric_query` tool and the metrics gateway fetched one past
their caps and said so — each on its own, above the runner.

The runner is now the one place that knows. `semanticFetchPlan` takes the
smaller of the query's limit and the caller's budget as the cap and fetches
one row past it; `semanticTrim` cuts at the cap and says whether it did; the
result carries `truncated` and `cap`. The preview says "first 100 rows of a
larger result — the preview stops at 100; add a filter or a coarser grain to
see everything". The parameter re-run asks for the widget's cap and stores
the runner's verdict. The analyst's step is `capped` when it was, with a
note the self-check keeps and the write-up reads: "Partial: the governed
model returned the first N groups of a larger result…". The refresh trusts
the verdict when it has one and keeps its guess for the SQL paths. The tool
and the gateway are untouched — their own cap+1 still lands above the
runner's, and the arithmetic stays right.

Driven, before: `100 row(s)`, `LIMIT 100`, a hundred rows. After the
rebuild, the same query: `first 100 rows of a larger result — the preview
stops at 100; add a filter or a coarser grain to see everything`, `LIMIT
101` in the statement that ran, a hundred rows in the table.

**Tests:** 7 behavioural on `semanticFetchPlan` and `semanticTrim`, 7
source-anchored on the runner and every consumer; 9 behaviour-changing
mutants each killed, control missed, baseline green first.

### 2026-09-21 — A build's stamps outlived the definition they were about

#### R60 · S2 · "built · 836 rows" beside SQL that had just been replaced

Sweep item 2, taken up at last: a badge that outlives what it vouched for.
Open `stg_revenue` on the SQL Models page: `built · 11d ago · 836 rows`, a
green dot. Append `limit 5` to its SQL and press Save: "Saved stg_revenue" —
and `built · 11d ago · 836 rows`, the green dot. The save writes every column
of the definition and none of the stamps; the page reads `last_status` as if
it were about the row it sits on. So the status, the row count and the time
all describe the previous definition, and nothing on the page can tell.

The database now marks a definition change: a `BEFORE UPDATE` trigger on
`sql_models` (migration `20260921000000`) sets `definition_changed_at` when
the SQL, target schema or name, materialization or tests change — and not
when the description, tags, schedule or pause state do, because a model
paused or rescheduled still holds the table its last build wrote. A trigger
for the same reason the semantic layer decertifies in one: every writer goes
through the row, and none can forget.

The runner clears the mark, not the trigger, and only when the mark on the
row is still the one it loaded at plan time. A trigger cannot tell a build
that read the new definition from one that started before the edit and
stamped after it; the runner holds the mark it read, so its clear is the
claim-by-clock pattern the sweeps already use. A mark that survives a build
is one that build did not read.

The page derives what it may claim from both (`modelBuildState`): an edited
model's dot is amber, its header reads `edited <when> · not built since`, and
the previous build's figures are still shown — named as the previous
definition's — because the table in the lakehouse is still that build's.

**On the live database since 2026-09-22.** The migration's push was refused
by the session's permission gate on the day, so the trigger went in when the
owner ran `npx supabase db push`; until then the runner tolerated a row
without the column. Driven afterwards, both directions: a SQL change marks
the model `edited · not built since` with the previous build named as the
previous definition's; a description-only change on a built model leaves it
`built`; the build that reads the definition clears the mark. Recorded under
R60 in the UI test results.

Driven, before: `stg_revenue` at `built · 11d ago · 836 rows`, `limit 5`
appended and saved — `Saved stg_revenue`, and `built · 11d ago · 836 rows`,
green dot. After the rebuild, against the un-migrated database: the same
header (no mark to read), then Build — `Built 1 model`, `built · 22s ago ·
5 rows`. The trigger was proven in both directions against the empty local
Postgres twin in a throwaway schema, dropped afterwards; the edited state
in the browser waits on the push.

**The family.** Every other definition edit in the product keeps its last
result the same way, and none was in the named list: the lakehouse
materialized-view upsert (`last_status`, `last_refreshed_at`, "Last rebuilt
…"), the ETL pipeline save (`last_run_status` chip), the workflow saves, the
data-monitor config update (a rule changed while its `ok` and `last_value`
stand — reachable only through the server function today), and the app-source
re-save (`last_test_status` "Healthy" over credentials that were replaced —
the warehouse and provider saves clear it; this one does not, and the Apps
tab cannot reach it). Listed under sweep item 2; each is a round of its own.

**Tests:** 5 behavioural on `modelBuildState` and 9 source-anchored on the
trigger, the runner and the page; 7 behaviour-changing mutants each killed,
control missed, baseline green first.

### 2026-09-21 — The scheduler's last pass has a surface

#### R59 · S2 · A page that lists every service except the one that runs every schedule

R57 made the scheduler's pass record every folded failure in `errors`, and
the only place that answer went was the JSON of `/api/bi/cron`, which the
page polls and discards. The Monitoring page — "N needing attention" — listed
every service the deployment runs and never the scheduler, so a pass that
could not read its own schedule, or a scheduler that had stopped, changed
nothing on the one page built to say so.

The pass now keeps its last result in process memory (`getLastCronPass`), and
the health handler reports it as a service beside the others through a pure
`schedulerProbe`: **up** with the last pass's age and counts; **degraded**
naming the failures when the last pass had any, or when no pass has run for
five minutes (the tick is one a minute), or when a process has been up that
long without ever passing; and an honest **up** with a note when the
in-process scheduler is disabled by configuration and an external cron drives
the passes. The page's "needing attention" count includes it like any other
service, and the row shows the failures in its message.

Process memory on purpose, and said in the code: the probe answers for the
instance that served the request; a multi-instance deployment reads the one
that answered.

Driven: the Monitoring page after the rebuild shows the Scheduler row — up,
last pass seconds ago, the pass's counts — beside the other services.

**Tests:** 6 behavioural on `schedulerProbe` and 2 source-anchored on the
wiring; 6 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-21 — Retrieval that could not be checked or completed says so

#### R58 · S1 · A failed ACL read showed restricted documents; every failed search said "no match"

`retrieveCitationsServer` answered a bare `Citation[]`, and four things
inside it fell short without a word reaching the model:

- The ACL filter's catch was written for one state — a database that predates
  the connector migration, where the ACL columns do not exist — and its
  comment says so. The catch itself caught EVERY failure and kept the
  unfiltered candidates. A timeout on the ACL read showed restricted documents
  to whoever asked.
- A failed vector search was folded into keyword mode with a warn.
- A failed keyword scan was a bare warn; and the document scan under it
  dropped the error of every page (a failed page was "no more documents") and
  stopped at the first page shorter than it asked for — R41's assumption, with
  `KEYWORD_PAGE` equal to `db-max-rows` by luck.
- The chat route's own catch, "don't block the chat — just continue without
  grounding", let the model answer from memory over a failed retrieval with
  no word that anything had been searched.

And the grounding prompt, told `[]` by any of these, instructed the model:
"It returned no matching passages. … say plainly that you could not find it
in the available documents." The `kb_search` tool said "No matching documents
in any connected knowledge base." Absence asserted over a search that failed.

Now the function reports `{ citations, degraded }` and the old name delegates.
The ACL catch keeps the legacy path only for the pre-migration error
(`does not exist` / `42703`) and otherwise fails CLOSED — the candidates are
withheld and the reason recorded. The vector and keyword failures are
recorded. The document scan pages through `selectAllPages`, which reads every
page's error and does not stop on a short one. The grounding prompt, given
nothing back and a reason, tells the model the search could not be completed
and not to say the documents lack the information; given citations and a
reason, that retrieval was partial. The tool's empty answer carries the reason
instead of "no matching documents", and the chat route's catch tells the
model retrieval failed instead of saying nothing.

Two more reads on the same path answered absence over a failure and go with
this round: the agent's own configuration (`const { data: agent }` — a
failed read left the search covering no knowledge base) and an ML model's
production version (`Production version not found`, over a failed read).
Both read their error now; the first throws with the reason, the second
tells the model the version could not be read.

Server-side throughout, so the browser half is the regression half: a
grounded agent still answers with citations under the live deployment. The
defect half is behavioural on the pure prompt builder and source-anchored on
the rest.

**Tests:** 4 behavioural on `buildGroundingPrompt`, 9 source-anchored on the
report, the ACL catch, the scan, the tool, the route and the two reads; 9
behaviour-changing mutants each killed, control missed, baseline green first.

### 2026-09-21 — A scheduler that reported success over its own failures

#### R57 · S1 · `/api/bi/cron` answered `ok: true` with zeros over a failed schedule read

The scheduler's pass, `runCronPass`, runs some twenty sweeps — BI schedules,
prep flows, analyses, quality checks, catalog crawls, ETL, materialized views,
SQL models, workflows, swarm schedules, retention purges, health checks. All
but the first two were folded to `console.warn` and `return 0`; the three
reads that decide what is due were folded to "nothing due" (`due ?? []`,
`flows` → `return 0`, `alerts ?? []`); and the pass result had no field for
any of it. So the cron endpoint the page polls every few minutes answered
`{ ok: true, processed: 0, prep_flows: 0, … }` over a pass that could not
read its own schedule, and a refresh that crossed an alert threshold, under
a failed alerts read, notified nobody. Per-row failures were already recorded
on the schedule and flow rows; the failures BEFORE a row was reached were the
silent ones.

Every folded step now records itself — `fold(step, e)` warns as before and
pushes `step: reason` into `errors` on the result, and the first two steps
are folded the same way so a failed read does not abort the sweeps after it.
The three reads throw with their reason, which is what `errors` then carries.
The route's `ok` is `result.errors.length === 0`; the counts and the errors
travel either way, still as a 200, so an external cron keeps calling.

Nothing in the UI shows the pass result — the page polls the endpoint and
discards the body — which is the next thing to give a surface. This round's
browser half is the regression half: the endpoint the page polls answers
`ok: true, errors: []` under the live deployment.

**Tests:** 4 behavioural on the real `processDueSchedules` and
`processDuePrepFlows`, forced past their interval guards, against an admin
client whose read fails; 5 source-anchored on the pass, the alerts read and
the route; 7 behaviour-changing mutants each killed, control missed,
baseline green first.

### 2026-09-21 — Two server reads whose failure became an answer

#### R56 · S2 · "No credentials configured" over a failed read, and a person shown as an id

Found by reading, in the two files the failed-read sweep had left: both are
the server's own reads, so neither is injectable from the browser and both
rounds' browser halves are regression only.

`loadCredentialRowShared` fetched the user's OWN credential through
`loadCredentialRow(...).catch(() => null)`. `loadCredentialRow` answers `null`
for "no row" and throws only for a failed read, so the catch turned a failed
read into "no own credential", the lookup fell through to the IAM grants, and
the call then failed downstream with **"No credentials configured. Add them in
Provider Integrations."** — the wrong reason, at the wrong place, for a
credential that exists. `getProviderDefaultModel` folded the same read into
"no default model", which silently changes which model a call uses.

`emailMap` in `audit.functions` paged the Auth admin API and `break`-ed on
error, so a failed page handed back a SHORT map and the audit list attributed
every trace and swarm row after it to an 8-character id where it should show
a person — under an `ok: true` answer (event rows have an `actor_email`
fallback; trace and swarm rows do not). `adminSpendBreakdown` consumed the same
map and dropped the errors of its groups and members reads too: a failed read
answered `ok: true` with an empty group breakdown.

The two catches are gone — a failed read propagates with its reason and the
"not configured" message is said only over a genuine null. `emailMap` reports
a failed page, and both handlers answer `{ ok: false, error }` — which the
Audit Log page already toasts — instead of attributing spend or actions to
ids.

**Tests:** 3 behavioural on the real `loadCredentialRowShared` and
`getProviderDefaultModel` against an admin client whose credential read fails,
3 source-anchored on the two audit handlers; 7 behaviour-changing
mutants each killed, control missed, baseline green first.

### 2026-09-21 — "Upload data first", over a read that failed

#### R55 · S2 · The generate dialogs advised uploading data when the data could not be read

Driven: a saved report opened with every `user_data_tables` request rejected
— two rejected reads on mount and no toast, because the report route's
hydration catch was bare ("the designer still works without them; only
generation needs them"). Then Generate with AI: the source picker's placeholder
and its notice both read **"No local datasets — upload data on the Data & SQL
page first."**, and Plan the report was disabled. Four rejected reads by then.
The account has thirty-three local datasets.

Both generate dialogs take their table list and their "not ready" reason from
`generationSource()`, which turned an empty list into advice to upload. The
dashboard route toasted the failure and moved on; the report route said
nothing at all; either way the dialog received `[]` and had no way to tell a
failed read from an empty account.

The BI data context now carries `datasetsError`. Both routes set it in their
catch (the report route gains the toast it never had), both dialogs pass it
through, and `generationSource` answers an empty list WITH a reason with the
reason — "Local datasets could not be read — …" — while an empty list without
one still says where to get data, and a kept list after a failed re-read is
not blocked.

**Tests:** 3 behavioural on the real `generationSource` and 4 source-anchored
across the context, both dialogs and both routes; 6 behaviour-changing mutants
each killed, control missed, baseline green first.

### 2026-09-21 — A deck whose data could not be read, delivered without a word

#### R54 · S2 · "Here's your PowerPoint" over four rejected reads

Driven in the playground: PowerPoint mode, every `user_data_tables` request
rejected, a request for a two-slide deck with a bar chart of sales by region
and a KPI of row count. At 21 s: **Here's your PowerPoint —
Make-a-2-slide-PowerPoint-about-the-saas.pptx**. Four rejected reads behind
it, no toast, no error, a deck delivered with its chart slides fallen back to
bullets.

`materializePptxWithBI` caught the failed hydration as `datasets = []` and
returned `{ visuals: 0, filled: 0 }` — the same report a plan with no charts
gets. Its caller's "N of M visuals could be filled" warning needs `visuals > 0`
to fire, so a failed read was the one outcome that produced no message at all:
an unanswerable question warns, an empty account is silent by design, and an
unreachable table list was silent by accident.

The report now counts the charts the plan asked for BEFORE reading, so the
count stands whatever happens next, and carries `error` when the datasets could
not be read. The playground toasts that as an error — "Charts could not be
filled — could not read your datasets: …" — with the deck still built and
the reason on screen, and the existing partial-fill warning is unchanged
for the case it was written for.

**Tests:** 3 behavioural on the real filler (a hydration that rejects, one
that answers no datasets, a plan with no visuals — against the unpatched
source the first two reported `visuals: 0` alike) and 1 source-anchored on the
caller; 4 behaviour-changing mutants each killed, control missed, baseline
green first.

### 2026-09-21 — A policy read that fails must fail closed

#### R53 · S1 · A failed IAM read evaluated as "no policy"

Found by reading, not by driving: R51's false lead pointed at the grants
resolver, and the resolver's neighbours turned out to be the finding.
`getEffectiveModelRules` read four tables and dropped the error of each:

```ts
const [{ data: memberships }, { data: rules }, { data: roles }, { data: settings }] = …
const mode = settings?.model_access_default === "deny" ? "deny" : "allow";
```

Under allow mode `collapseModelPolicy` turns "no applicable rules" into
`null` — unrestricted. So a failed `iam_settings` read evaluated a
deny-by-default org as allow, and a failed `iam_group_members` read dropped
every group rule; in both cases a model the policy forbade was called. Four
callers gate model calls on this — the chat API, the embed chat, the notebook
model proxy and the BI planner — and each would have proceeded.

The same shape three more times in the same file and its callers:
`resolveGrantedResourceIds` dropped both of its reads (a failed grants read →
"nothing is shared with you", at sixteen call sites); `requireSuperadmin`
dropped its role read and fell through to the bootstrap claim, which writes;
and two callers of the resolver — `grantedDatasetIds` and `grantedIdsFor` —
caught its throw and answered "no grants", so a prep flow or BI refresh ran
over a short source list and a granted credential became "no credential
configured".

Every one of these reads its error now and throws with the reason. A policy
that cannot be read fails CLOSED: each caller answers the model call with an
error instead of making it, the listings fail with the reason instead of
answering short, and the superadmin guard refuses instead of claiming.

This round's UI half is the regression half only, as R41's was: the failure
cannot be injected from the browser (the reads are the server's own), so it is
proved by behavioural tests on the real functions against a client whose reads
fail one table at a time — the settings case resolved `null` before the fix and the memberships case `[]`
— and the browser confirms that under the live policy (deny-by-default off, no
rules) a model call still succeeds and the IAM page reads the same.

**Tests:** 10 behavioural on `getEffectiveModelRules`, `resolveGrantedResourceIds`
and `requireSuperadmin`, 2 source-anchored on the two callers; 8
behaviour-changing mutants each killed, control missed, baseline green first.

### 2026-09-21 — Loading is not zero, and a pass without a session is not an answer

#### R52 · S2 · "Local tables 0" for ten seconds, then "33" for two, on every full load

The timeline that corrected R51's cause. A fresh load of `/data-sql`, sampled
every two seconds, untouched:

| t    | Sources panel                         | server-function calls |
| ---- | ------------------------------------- | --------------------- |
| 8 s  | `Local tables 0`                      | 0                     |
| 18 s | `Local tables 33`, no `sftest` row    | **0**                 |
| 20 s | `Local tables 26` · `sftest 7`        | 1 (made at 17.97 s)   |

Two wrong answers before the right one. The first is the loading state rendered
as a count: R50 taught the panel to say `—` when the read FAILED, and nothing
covered "not read yet", so the ten seconds of hydration read as an account
with no local tables. The second is a pass that ran before the session had
resolved: `token` was `""`, `reloadLocal` skipped the connections call by
design, filed every synced dataset as an upload, and painted it; the
token-driven re-run corrected it two seconds later. Both were painted as
facts, and the 33 had already sent two rounds of notes after the wrong cause.

Now the local half has a `localLoaded` flag set by the first read's success
OR failure — a failed read is a read — and while it is neither, the panel
shows `Local tables …`, the totals carry `+` with the title "still loading —
crawled assets only". And `reloadLocal` returns before doing anything when
there is no token: the callback is rebuilt on the token, the mount effect runs
again with it, and the first paint is the right one.

**Tests:** 5 source-anchored, R50's moved with the expressions they pin; 6
behaviour-changing mutants each killed, control missed, baseline green first.

### 2026-09-21 — A failed read of where a table came from, answered as "here"

#### R51 · S2 · "Local tables 33" where 26, and a connector's row gone

First seen by accident, and first explained wrongly. After R50's rebuild the
Sources panel read **Local tables 33** with the `sftest` connector row missing,
and R50's notes blamed the connections server call failing while the container
was still `health: starting`. Sampled every two seconds during this round's
validation: the first `reloadLocal` runs before the session has resolved, with
no token, so it never asks for the connections at all — zero server-function
calls — and paints 33 at 18 s; the token-driven re-run makes the one call at
18 s and paints 26 at 20 s. Two seconds of a wrong attribution, by design, not
a failure. Then measured on purpose: with only the attribution read
(`select=id,saas_connection_id`) rejected, the same 33, the same missing row,
and the seven synced `sftest_*` datasets listed with SOURCE "Local tables". No
toast, no banner; 8 rejected requests.

Two reads decide where a table came from, and both dropped their failure: the
attribution query was destructured as `const { data: attribution }`, and the
connections call was `listConnectionsFn(...).catch(() => [])`. Either one
failing made every connector-synced dataset an upload — which is the wrong
source, the wrong sync status, and the wrong "re-crawl" affordance, presented
as fact.

Both failures are read now. The last attribution and connection list that were
actually READ are kept in refs and used across a failed re-read; until a read
has landed, the tables sit under Local tables and a banner says so —
`Where synced datasets came from could not be read — they are listed under
Local tables until it can be: …` — with a Retry. After a failed RE-read the
banner says the attribution shown is the last known one. Each wording is
gated on whether an answer exists, so a first-load failure cannot claim one.

**Tests:** 5 source-anchored; 6 behaviour-changing mutants each killed, control
missed, baseline green first.

### 2026-09-21 — The catalog counted a failed read as zero

#### R50 · S1 · "All assets 21 · Local tables 0" over a rejected read

Seen while validating R49: with every `user_data_tables` request rejected, the
Data Catalog's Sources panel read **All assets 21 · Local tables 0** and the
list footer **21 of 21 assets**. Normally it reads 54 · 26 · 54 of 54. No toast,
no banner — one `console.warn` — and 33 assets gone: the 26 local tables and
the 7 connector-synced datasets that are stored the same way. A search for any
of them answered "no results".

`reloadLocal`'s catch had a comment saying a hydration failure "is not an empty
account", and then did `setLocalAssets([])`. The warn was the whole
disclosure.

The catch records the failure now and leaves the last good list alone. While
the local half is UNKNOWN — a failure with nothing loaded yet — the Sources
panel shows `Local tables —` rather than `0`, the totals read `21+` and `21 of
21+ assets` with the title "crawled assets only", and a banner above the list
says `Local tables could not be loaded: …` with a Retry. After a failed RELOAD
over a populated list the counts stand and the banner says the list may be
stale. The prep tab's collapsed section header, which read `Local tables 0`
beside its own R49 error state, shows `—` there too.

**Tests:** 8 source-anchored; 7 behaviour-changing mutants each killed, control
missed, baseline green first.

### 2026-09-21 — A failed list is not an empty account

Both of these were found by driving the page, and neither could have been found
another way: the first is a handler with no try, the second is a `[]` that
twelve callers each read as "nothing here".

#### R48 · S2 · The first caller to meet R46's throw had nowhere to put it

R46 made the checked reader THROW on a failed window instead of registering a
partial table. Driving `/data-sql` with every `user_data_rows` request rejected
and pressing Refresh: the console showed `Uncaught (in promise) could not count
rows of …`, the icon spun indefinitely, and nothing on screen said the refresh
had failed. The dataset list stayed as it was — right, a failed refresh is not
an empty account — but a control that silently does nothing under failure is a
control the user keeps pressing.

The mount path had a try and toasted; `refreshTables` was four lines with no
try at all. It has one now, the toast says `Could not refresh datasets: …`,
the spinner clears in a `finally`, and the datasets are deliberately left
untouched.

One of the round's own tests matched the word "catch**es**" in the comment above
the try — a bare `/catch[^}]*setDatasets/` ran forward from the prose into the
try's own `setDatasets(tables)`. Pinned as `catch (e) {` now, reading only the
body that opens.

**Tests:** 5, four behaviour-changing mutants each killed, control missed.

#### R49 · S1 · A failed table list answered as an empty account

`hydrateFromSupabase` read the dataset list as

```ts
if (error || !tables) return [];
```

Driving the workbench with every `user_data_tables` request rejected and
pressing Refresh: the thirty real tables in the sidebar were replaced by
**"No tables yet. Upload a file to get started."** — no toast, spinner cleared
after about 3.5 s, 38 rejected requests by then. Restoring `fetch` and pressing
Refresh brought the same list back; nothing was lost, the page had only said so.

The same `[]` reaches the mount path, which reads an empty list as an empty
account and calls `ensureSampleDataset`. The injection log filled with the
seeder's own existence checks — `select=id&name=eq.saas_sales&is_sample=eq.true`
— every one rejected, and `ensureOneSample` reads that result as
`const { data: existing }`: a failed check IS an absent sample, and it seeds.
The registration RPC returns the existing id without writing (its body was
checked), which is the only reason that round changed nothing. The row insert
below it is guarded by a count read whose error is dropped the same way; a
failed count reads as 0, and 0 means "insert every sample row" — on top of the
rows already in the table.

The Data Prep tab's reload wiped its list to `[]` on failure, a false empty
with the copy "upload a CSV on the Workbench tab"; leaving it `null` instead
would have shown the loading skeleton forever, which is R48's shape again. So
both surfaces now have an explicit failed state — "Datasets could not be
loaded: …" with a Retry — tested BEFORE the empty branch, and a list that a
failed refresh could not replace carries "Last refresh failed … showing the
previous list" for longer than a toast lasts.

The list read throws with the server's reason; the existence check and the
count read throw; twelve callers meet that throw, and all twelve already met
the rows-path throw from R46, so no new failure shape reaches any of them.
Three of them render absence on catch and are queued rather than fixed here:
`docGen/biData` drops every chart of a document when the list cannot be read,
`bi_.report` swallows the failure entirely, and `chatBi` answers "no datasets"
— now only on a true empty.

**Tests:** 5 behavioural on the real `ensureSampleDataset` against a client
whose reads fail one at a time — both failure cases resolved `true` before the
fix — and 8 source-anchored on the three call sites; 8 behaviour-changing
mutants each killed, control missed, baseline green first.

### 2026-09-21 — A flag that named the wrong defect, and the last of the pagers

#### R47 · S2 · Two sites I had recorded as mitigated were not

R44 fixed the three offset-advance sites where nothing downstream could tell,
and left `bi/quality` and `etl/service` in the queue with "skips, but `capped`
catches it" and "skips, but `truncated` catches it". That was wrong, and it was
wrong in an interesting way.

Both flags report the same thing: **fewer rows were read than the count**. A
reader takes that to mean the work below ran over a PREFIX of the table — the
first N rows, missing a tail. Under a server cap smaller than `PAGE` that is not
what happened. Their offsets advanced by the request size, so every clamped page
left a hole, and the rows on hand were a SCATTER.

A null rate, a distinct count or a min/max over a scatter is not a partial
answer, it is a wrong one. An ETL step over a scatter produces output that is
wrong rather than short. And the flag sitting beside the result tells the reader
the wrong thing about it, which is worse than no flag: it converts a defect into
a caveat, and caveats get accepted.

The general shape, worth keeping: **a disclosure is only a mitigation if it
describes the defect that actually occurred.** "We read fewer rows" and "the rows
we read have gaps" produce identical flags and completely different answers.

Both read through `selectAllPages` now, ordered by `id`, and `capped` /
`truncated` come from the scan rather than from a count comparison that could
not tell the two apart.

#### R47 · S3 · The sweep's own module had the milder half

`pageTraces` in `lib/traceWindow` — written by this campaign, for exactly this
class — stopped at the first page shorter than the one it asked for.

It never skipped: it stopped rather than advancing past a short page, so the
window headline it feeds stayed honest. On a deployment whose `db-max-rows` sits
below the page size it simply said "showing the most recent 400 of 2,731 traces"
where it could have said 2,731 — truthful, and needlessly degraded. It advances
by what it received now, and ends on a page shorter than one the server has
already produced.

**Tests:** 5 behavioural for `pageTraces` (including every row read at a cap of
400 against 2,731 rows) and 7 for the two server sites, 10 behaviour-changing
mutants applied one at a time and each killed, control missed, baseline verified
green first.

#### R47 · The sweep is closed

Nine hand-rolled pagers were found by grepping for one assumption. All nine are
done: three that persisted (R43), three that skipped unnoticed (R44), the audit
export (R45), the parallel reader (R46), and these three. `audit.functions`
remains and is deliberately out of scope — it pages the Auth admin API, which
honours its own page size and has its own pagination contract; its only issue is
a folded error, which belongs to the failed-read sweep rather than this one.

### 2026-09-21 — Five windows at once, and any one of them could end the read

#### R46 · S1 · Four defects in one loop, feeding the SQL engine

`lib/sqlEngine` loads a whole dataset into the in-page SQL engine five windows at
a time. What a user's query answers — and what the AI SQL path reads — is
whatever this put into the engine.

```ts
let stop = false;
for (const { data: chunk, error: rowErr } of results) {
  if (rowErr || !chunk || chunk.length === 0) { stop = true; break; }
  allRows.push(...chunk.map(...));
  if (chunk.length < PAGE) { stop = true; break; }
}
if (stop) break;
pageIndex += PARALLEL_PAGES;
```

1. **A window's ERROR became `stop`.** One failed request out of five ended the
   read, and the table registered with whatever the other four returned. No
   error surfaced anywhere; the query simply answered from less data.
2. **No `ORDER BY`, while issuing five concurrent windows.** Postgres promises
   no order without one, so the five were not guaranteed consistent with each
   other, let alone a partition of the table.
3. **The first short window ended everything** — including the windows already
   fetched and paid for in the same batch, which were discarded.
4. **Offsets were `pageIndex * PAGE`**, the request size, so a server handing
   back less than a full page left a hole at every window boundary. R44's defect,
   with five chances per batch.

The replacement is `selectAllWindows` in `lib/pagedSelect`, beside the sequential
pager: count, one probe window whose LENGTH is the page size this server
actually honours, then batches of `concurrency` windows of that size, then a
check that the rows add up. Any error aborts the whole load. More rows than the
count is fine — that is a concurrent insert, not a gap.

The count check is what makes parallel offsets safe to use at all: windows
derived from a count either cover the filter or they do not, and a clamped
window, a skipped row or a short page surfaces there rather than in someone's
query result.

#### R46 · S1 · A failed shared read registered an empty table

In the same file, four lines up:

```ts
if (rpcErr || !Array.isArray(data)) return [];
```

A failed `shared_dataset_rows` RPC registered the table with no rows, so a query
against it answered "no results" — which is also exactly what an empty dataset
answers. Nothing on screen separated the two. It throws now.

#### R46 · note · Extracted so the tests could be real

The first version of this fix was written inline in `sqlEngine`, and the tests
for it would have been what the last two rounds settled for: a replica of the
algorithm in the test file, plus source anchors on the production code. That is
weak, and this algorithm — probe, derive the window size, batch, verify — is
intricate enough that a replica proves very little.

So it moved into `lib/pagedSelect` and the tests drive the real thing: every row
read exactly once at a cap BELOW the page size, one failing window aborting the
load, a count mismatch refusing, a stale count accepted, a single-window table
costing one request, and — because a correct-but-sequential version would have
passed everything else — an assertion that the windows really do overlap in
flight.

**Tests:** 14 in `parallelWindows`, 9 behaviour-changing mutants applied one at a
time and each killed. Six of the nine attack the algorithm itself rather than a
source anchor, which is the return on extracting it.

### 2026-09-21 — The one path that ended the evidence stream without saying so

#### R45 · S1 · A complete-looking export of a third of the audit trail

`/api/audit/export` streams the compliance trail as NDJSON so an enterprise can
ship it to its own SIEM. It is careful nearly everywhere: superadmin only,
invalid dates rejected rather than silently widening the range, one page per
`pull` so backpressure is honest, and — the part that matters — a mid-stream
failure emits a final error line, with a comment saying exactly why:

> Mid-stream failure: emit a final error line so the consumer can tell a
> truncated export from a complete one.

Then it closed on a short page:

```ts
if (data.length < PAGE) controller.close();
```

That is the ONE exit that ends the stream without emitting that line, and it
fires whenever the server hands back fewer rows than asked for — `db-max-rows`,
which belongs to whoever runs the database, not to this code. On a project tuned
below `PAGE` the export closes after a single page and writes a file that is
byte-for-byte a valid, complete-looking export of a fraction of the trail. For
evidence that is the worst available property: not missing, not erroring, just
quietly less. Measured here: `audit_events` holds **2,010 rows**, so a full
export is three pages and a cap below 1,000 is all it takes.

A short page proves nothing; an empty one proves the end, and the branch above
already handled it. The close is gone. The cost is one extra request, and only
where a page was actually short — two full pages already needed an empty third
to know they were done, which is why removing it is free in the common case.

**The ORDER BY gained `id`.** `spec.ts` is `created_at` or `started_at`, and two
events can share a timestamp to the microsecond. Offset paging over a non-unique
order is not a sequence: the planner may return one of them at the end of page
one and again at the start of page two, and the other never — a row that did not
happen beside a row that happened twice, in the file someone opens precisely
because they need to know which.

**Tests:** 9 in `auditExportStream`, 8 behaviour-changing mutants applied one at
a time and each killed — including one that drops the superadmin guard — control
missed, baseline verified green first.

The behavioural half runs the route's loop shape against a table that clamps
like PostgREST does, at caps of 1, 7, 500, 999, 1,000 and 4,096, because the fix
is a DELETION and "the line is gone" is the weakest possible assertion about
one. Its honest limit: `drain` replicates the loop rather than importing it, so
it documents the defect while the source anchors pin the code. Driving the real
handler would mean restructuring the route for testability, which is a larger
change than this round should carry.

#### R45 · S3 · The comment answered for the code, again

`expect(SRC).toContain("_export_error")` passed under a mutant that emitted a
bare newline instead of the error object — because the token appears in the
comment above the branch, explaining the feature. Fourth of this family in one
session, third caused by prose in the file under test.

The remedy differed this time. Twice before, the comment was reworded. Here the
key name in prose is genuinely useful to a reader ("look for `_export_error`"),
so the ASSERTION moved instead, onto the encode expression:

```ts
expect(SRC).toMatch(/JSON\.stringify\(\{ _export_error: error\.message \}\)/);
```

Which suggests the general rule is not "never mention the code in a comment" but
**pin something only code can be**: a chained call, an expression, an argument
position. A bare identifier is prose as easily as it is code.

### 2026-09-21 — The offset that advanced by what it asked for

#### R44 · S1 · Not a short tail. Holes.

`start += PAGE` after a page that came back short does not truncate a read — it
puts **holes** in it. Ask rows 0-999, receive 500 because `db-max-rows` says so,
then ask 1000-1999: rows 500-999 are never requested at all.

That distinction is the finding. A missing TAIL can be caught by comparing what
was read against an exact count, and several call sites in this repo do exactly
that — `bi/quality` sets `capped`, `etl/service` sets `truncated`. A missing
MIDDLE reports the same way: fewer rows than the count, a caveat about
truncation, and rows that are not a prefix of anything. Every figure computed
from them is wrong in a direction nothing can predict, and the caveat that fires
describes the wrong problem.

Five internal sites advanced by the request. Three had no way for anything
downstream to tell:

| Site                    | Error     | Order    | Discloses |
| ----------------------- | --------- | -------- | --------- |
| `tools/sql.server.ts`   | folded in | **none** | **no**    |
| `bi/prep.server.ts`     | folded in | **none** | cap only  |
| `bi/versions.server.ts` | correct   | **none** | **no**    |

**The SQL tool is the one that matters most.** It is what an agent calls to
answer a question about a dataset, and it was reading a table with its middle
missing, with the page's error folded into the exhaustion test and no `ORDER BY`
at all. The agent then answers, confidently, from a sample nobody chose.

**The version copy is the one with the sharpest irony.** Its error branch was
already right, and says so:

> A partial copy is worse than an honest metadata-only version: it would present
> itself as restorable and then silently lose rows.

The paging directly beneath that comment did precisely what the comment refuses
— a clamped page left a hole in a snapshot that still called itself restorable.
The fix is to make the paging agree with the doctrine the file already had.

All three read through `selectAllPages` now, which advances by the rows it
RECEIVED, orders by `id`, and reports whether its ceiling stopped it. The SQL
tool refuses rather than answering from a prefix (`SQL_TOOL_MAX_ROWS`, default
200,000); prep keeps naming the datasets it could not read whole; a version
stores metadata only rather than a copy with gaps.

**Tests:** 15 in `offsetAdvance`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

The test file keeps the OLD loop as `legacyPager` so the defect stays
demonstrable rather than described. Against 2,500 rows behind a server that
hands back 400 it asserts not "too few rows" but **which** rows were never
asked for:

```ts
expect(seen.has(399)).toBe(true);
expect(seen.has(400)).toBe(false);
```

#### R44 · S3 · The test double was shaped to the bug

`embedBiAllowList` drives the SQL tool against a fake Supabase client, and the
fix broke it twice over.

The shallow break: the stub had no `.order()`, because the query never had one.
Adding the method is trivial. The interesting break is underneath it — the stub
**ignored the range window entirely** and returned every row of the table for
any page, faking an ending with a flag that made the un-ranged call return `[]`:

```ts
// Second page must come back empty or loadUserTables loops forever.
data: ranged ? (rowsByTable[id] ?? []).map((row) => ({ row })) : [],
```

That only works against a pager that stops at the first short page. The comment
even says so: the stub had to manufacture an ending because the loop it was
written for could not find one honestly. A pager that advances by the rows it
received asks for page after identical page until its ceiling — which is what
happened.

So the double had been built to the shape of the defect, and it would have kept
any correct implementation looking broken. It honours `range` now, which is both
the fix and a truer stand-in, since the real builder does.

A test double that models the call shape a buggy caller happens to make is not
neutral: it votes for the bug. When a fix makes a stub fail, the question is
which of the two was describing the real system.

#### R44 · process · Having the list is not running the list

Before the gate, `tests/` was grepped for everything touching the three files —
eighteen of them, `embedBiAllowList` included — and then eleven were run. The
gate found the other one. The habit added in R40 was "grep for the files the
round touched and run those first"; the habit that was missing is running all of
what the grep returns. Nineteen files, 305 tests, is thirty seconds.

#### R44 · process · The gate was flaky, and the flakiness was measured, not assumed

Two consecutive full gates failed with 10 and 4 failures, every one a 20-second
TIMEOUT, in files this round never touched — `duckdb.test.ts`,
`connectedIntegrations`, `nl2sqlEval`, `aiAnalyst`. Each run reported ~640s of
test time against a suite that normally takes a fraction of that, with a Docker
stack of fifteen containers on the same machine.

Rather than re-rolling the gate until it came up green — which would have meant
trusting a green run after discarding two red ones — every step of `npm run check`
was run separately with its own exit code, and vitest pinned to four threads:

```
typecheck 0 · lint 0 · check:docs 0 · check:md-docs 0
check:doc-commands 0 · check:infra 0 · vitest 0 (396 files) · build 0
```

The suite is green; the aggregate gate is unreliable on this machine under load.
That is a property of running 7,497 tests beside a container stack, not a defect
in the product, and the repo's test timeout was deliberately left alone —
raising it to suit one laptop would hide exactly the kind of slowness a timeout
exists to surface.

### 2026-09-21 — The pagers that write, not the ones that print

#### R43 · S1 · A failed page replaced a lakehouse table with a prefix of itself

R41 fixed the shared helper. Grepping for the assumption it removed found
**seventeen** hand-rolled copies, twelve of them against PostgREST. Three of
those do not render a sentence — they produce a lakehouse table, a materialised
Parquet mirror, and the rows a dashboard widget computes its stored answer from.

Each carried some combination of the same three faults:

- the page's error folded into the exhaustion test, so a statement timeout was
  indistinguishable from the end of the data;
- `chunk.length < PAGE` as proof of the end, which holds only when the server
  returns everything it is asked for;
- offset paging with **no `ORDER BY` at all**, which Postgres makes no promise
  about. That one does not undercount — two pages can repeat one row and drop
  another, moving the answer in either direction.

| Site                     | Error            | Ordering | Short page |
| ------------------------ | ---------------- | -------- | ---------- |
| `lakehouse.functions.ts` | **discarded**    | by `id`  | breaks     |
| `bi/refresh.server.ts`   | **folded in**    | **none** | breaks     |
| `data/parquet.server.ts` | thrown (correct) | **none** | breaks     |

The lakehouse import is the sharpest. It bound no `error` at all — a failed page
simply ended the loop — and the rows gathered so far went into
`CREATE OR REPLACE TABLE ... AS SELECT * FROM read_json_auto(...)`. So a
statement timeout did not fail the import; it **replaced an existing lakehouse
table with a prefix of itself**, which SQL models, BI widgets and training runs
then read as the dataset. Nothing anywhere says a table is short rather than
small.

All three now read through `selectAllPages`, order by `id`, and **refuse at
their ceiling rather than persisting a prefix**. Refusing is the point: a
truncated display can carry a caveat, but a truncated table cannot.

**This round changes behaviour under load, and that is worth saying plainly.** A
workspace with a dataset over `BI_LOCAL_ROWS_PER_TABLE_CAP` (20,000, and now an
env knob precisely because reaching it is a refusal) and no Parquet mirror will
get a failed widget refresh naming the knob, where before it silently got a
number computed from the first 20,000 rows. Datasets that size normally have a
mirror — `PARQUET_MIN_ROWS` defaults to 5,000 — so this is reachable only with
mirroring off or not yet synced. It is the correct trade, and it is a real change
in what an operator sees.

**Tests:** 16 in `rowPagers`, 9 behaviour-changing mutants applied one at a time
and each killed, control missed, baseline verified green first.

#### R43 · S3 · The same two anchor traps, in one round

The negative assertion "the folded-in error is gone" failed on its first run —
against the comment above the new code, which quoted the old expression to
explain why it went. Same shape as R39, and the remedy was the same: change the
PROSE, not the pattern.

And a mutant that passed a bare `20_000` to the scan while leaving
`localRowsPerTableCap()` in the error message survived a plain `toContain`. The
sibling occurrence answered for the one under test — third time this session a
symmetric copy has stood in for the site being checked. The assertion pins the
argument position now.

### 2026-09-21 — Group budgets asked the database for a user with no id

Both findings below came out of driving the pages in a browser, after seven
rounds of unit tests and mutants had found neither. That is the entry's point
as much as the defects are.

#### R42 · S1 · Every group spend query the product has ever made was a 400

The admin Budgets tab had nothing to show, because this deployment has no IAM
groups. So a throwaway group was created — one member, a $5 cap — and the spend
cell rendered:

> unknown

with the reason in its tooltip: **`invalid input syntax for type uuid: ""`**.

`budget_spend_since(_user_id uuid, ...)` is called by both group callers with
`userId: ""` and a member array, so Postgres was being asked to cast an empty
string to `uuid`. Proven directly against the database:

```
_user_id ""    -> 400  invalid input syntax for type uuid: ""
_user_id null  -> 200  1.677463
single user    -> 200  1.677463   (control)
```

That error does not match the "function is missing" test in `spendSince`, so it
returns `ok:false` without trying the row-scan fallback, and `groupSpend` turns
that into `null`. What `null` costs depends on a setting:

- **`BUDGET_FAIL_CLOSED` off** — the default — the guard `continue`s past the
  group cap. A team ceiling is configured, rendered in the admin UI, and
  **enforces nothing**.
- **`BUDGET_FAIL_CLOSED` on** — `decision = { over: true, scope: "group", spend: 0 }`.
  **Every member of every capped group is refused on every call**, with the
  spend that justified it reported as $0.

Neither is visible outside one `console.warn`. The function's own authorisation
branch is written for the right shape — `_user_ids IS NULL AND auth.uid() = _user_id`
— so a group query was always meant to arrive with `_user_id` null.

**Why the suite missed it.** All 100 budget tests passed before the fix and
after. Every one of them is source-anchored: they read `budgetSpend.server.ts`
and assert on its text. Not one had ever put an argument on the wire. The new
`groupSpendRpc` test mocks the admin client and asserts what is actually sent —
null, never `""`, and never anything that is not a uuid — and it was checked
against the code as shipped, where it fails.

R39's display is the reason this surfaced at all: it printed "unknown" rather
than the confident `$0.00` the old browser-side sum would have produced from an
empty array. The fix it received was to say when it does not know, and the first
thing it did was say so.

#### R42 · S2 · The fallback sum had R41's defect, on the path that gates spend

`fallbackSum` — the pre-migration path that still enforces on an un-migrated
instance — ended each page with `if ((data?.length ?? 0) < PAGE) return { ok: true, ... }`.
Same assumption as `lib/pagedSelect` before R41: a page shorter than the
REQUEST proves nothing, because `db-max-rows` is the operator's setting. It now
advances by what came back and only ends on a page shorter than one the server
has already produced. It sums as it goes rather than collecting, so it cannot
call the shared helper — a budget path must not hold fifty thousand rows to add
up one column.

#### R42 · S2 · A truncation caveat over a failed read (in R40's own fix)

Driving the run detail page with the step read failing showed the banner
working — "The detail of this run could not be read — ... The totals above come
from the run itself and still stand" — and directly beneath it:

> Showing the first 0 of 4 steps. The canvas, the timeline and the per-step
> figures cover these only …

That is what a SUCCESSFUL read of a prefix looks like. Two sentences, one
failure, different stories — and the tab beside them said `Data flow (0)`,
claiming zero edges from a read that never returned any. The unit tests could
not see it: `runStepsCaveat({ fetched: 0, total: 4 })` is correct in isolation,
and the defect was entirely at the call site. Both now defer to `loadError`, and
the harness kills a mutant for each.

**The rule this round adds.** A disclosure helper is written for one situation;
the call site has to decide whether that is the situation it is in. "Partial"
and "failed" produce the same empty array, and only the caller knows which
happened.

### 2026-09-21 — The paging helper assumed the server's cap was its own

#### R41 · S2 · The module written to stop the undercount could produce it

Chasing the `db-max-rows` class upstream found where it was already known.
`src/lib/pagedSelect.ts` was written by an earlier round for exactly this
defect — its header records the dashboard reporting **$1.84 for a window whose
real cost was $5.77**, a 68% undercount — and every page it reads ends on this
test:

```ts
// A short page means the filter is exhausted. Only a page that came back
// completely full can have more behind it.
if (page.length < to - from + 1) return { rows, truncated: false };
```

That is sound only if the server returns everything it is asked for. It does not
have to: `db-max-rows` is the OPERATOR's setting, and the module hard-codes
`PAGE = 1000` while calling it "the largest page PostgREST will return" — an
assumption about somebody else's configuration, in a file whose own header
insists the ceiling "is a CEILING, not a default". On a project tuned below
1,000, or a self-hosted Supabase with its own `postgrest.conf`, every page comes
back short and **the first one ends the read with `truncated: false` holding a
fraction of the rows**.

`truncated` is what `dashboard.functions.ts` renders as `partial`. So the failure
mode is this module's own reassurance printed over the undercount it exists to
prevent — and the smaller the operator's cap, the worse the undercount and the
more confident the label.

The fix keeps the offset API and costs the ordinary case nothing. Track the
largest page the server has ACTUALLY handed back, and treat a page shorter than
that as the end: shorter than what was _requested_ proves nothing, shorter than
one the server already produced proves exhaustion at any cap. The offset
advances by what came back rather than by what was asked for, so a smaller cap
simply takes more rounds. All seven pre-existing tests pass unchanged, request
counts included — `seen` is still `[0, 1000, 2000]`.

Two smaller things in the same spirit. A filter matching exactly `maxRows` rows
was reported truncated; a caveat on a complete answer teaches readers to ignore
caveats, so one extra row settles it. And the probe's own error is propagated
rather than swallowed, because it decides the one flag this module exists to
set.

**The finding was available in the test file all along.** `fakeTable(total, cap)`
has always taken a cap, and nothing ever passed one below `PAGE`. The parameter
that would have shown this was sitting in the fixture, unused.

**Tests:** 15 in `pagedSelect`, 8 behaviour-changing mutants applied one at a
time and each killed — the first of them being **the original loop restored in
full**, which is the only way to know the new tests would have caught the old
code — control missed, baseline verified green first.

One mutant survived the first run: dropping the `want === PAGE` guard. When
`maxRows` is not a whole number of pages the last window is narrow by design,
and a page that fills it is not evidence of an end — it is the ceiling arriving.
Reading it as exhaustion returns `truncated: false` on a read that stopped
short: the original silent undercount, moved from the cap to the boundary. The
existing truncation test used `maxRows` of 3,000, a clean multiple, so the
narrow window never occurred. Now one uses 2,500.

#### R41 · note · Why this jumped the queue

The cursor said Semantic layer. This is the shared mechanism under the
dashboard's spend figure and the metrics page, the defect is in the same class
the sweep is working through, and it could be demonstrated deterministically
from a fixture already in the repo rather than argued from configuration. The
two paging modules now cross-reference each other, so the next person choosing
between them is told which question each answers.

### 2026-09-21 — A swarm run's canvas could be a prefix of the run it draws

#### R40 · S2 · A DAG from a prefix is not a smaller graph, it is a wrong one

`/analytics/observability/$runId` read the steps and the edges of one run with
no bound:

```ts
supabase.from("swarm_run_steps").select("*").eq("run_id", runId).order("started_at"),
supabase.from("swarm_run_edges").select("*").eq("run_id", runId).order("created_at"),
```

Past `db-max-rows` the timeline, the data-flow list and the canvas are a prefix.
The canvas is the one that matters: a truncated node set with a truncated edge
set does not draw a smaller swarm, it draws a broken one — edges arriving from
nodes that are not on the page, branches that appear never to have run.

What makes this page tractable is an asymmetry it already had. `step_count`,
`total_cost_usd`, `total_tokens_in/out` and `total_latency_ms` are **columns on
the run row**, written by the executor, so the header describes the whole run
however little detail came back. Verified against this deployment: `step_count`
matched the actual row count on all seven runs checked. So the page can state
exactly when its list is a prefix without asking the database anything extra —
and it must, because otherwise a header reading "Steps 1,400" sits above a
timeline holding a thousand and the page simply looks like it cannot add up.
`runStepsCaveat` goes directly under the metrics row, where that discrepancy is.

Paging is by cursor on `id`, then sorted by `started_at` for display. Ordering
by `started_at` and paging by offset would not have worked: two steps of one run
can share a start instant, and a page boundary inside that tie drops rows.

#### R40 · S1 · A failed read drew a run that did nothing

The same two reads were `?? []`, and the run read's error was discarded outright.
So a failed query rendered an empty timeline, an empty data flow, an empty
canvas — or "Run not found.", which is a claim about the database that a failed
read has not established. All three now say the read failed, and the run's own
totals are kept on screen with a note that they still stand, because they do.

Rather than a new test beside it, the page is enrolled in
`tests/unit/failedReadClaims.test.ts` — the registry of pages that must not
report a failed read as an empty account, which already enforces the contract
(the claim routes through a real branch, the error is kept, a rejection is
handled, the list is never emptied without recording why). A page that satisfies
that contract belongs in the list, or the next person to touch it gets no
warning from the guard built for exactly this defect.

**Tests:** 45 in `traceWindow`, 15 behaviour-changing mutants applied one at a
time and each killed — including one that drops the page back out of the
registry — control missed, baseline verified green first.

#### R40 · S3 · An anchor satisfied by the sibling

Four mutants survived the first run, all for one reason. The page has two
pagers, one per table, and the assertions were `toContain`:

```ts
expect(page).toContain('q = q.gt("id", after)');
expect(page).toContain("{ maxRows: RUN_ROW_SCAN_MAX }");
expect(page).toContain('.order("id", { ascending: true })');
```

Remove the cursor from the STEP pager and the EDGE pager's identical line is
still in the file, and every one of those passes. The mutants that reverted one
pager to a single capped request, that ordered one by a non-unique column, and
that quietly capped one scan at 1,000 all went green.

This is the presence-is-not-use family again, one symmetry along: not a token
that no longer does anything, and not a comment quoting the code — a **sibling**
standing in for the site under test. The remedy is to count rather than to look:
`occurrences(page, needle) === 2`, which says what was actually meant — _both_
pagers are cursor-paged, ordered by a unique key, and bounded. Where a rule must
hold at several symmetric sites, an anchor that does not count checks nothing.

### 2026-09-21 — Group budgets were summed in a browser from a page of the traces

#### R39 · S1 · Three findings of this sweep in a single read

The IAM → Budgets tab read every trace of the current month into the browser and
bucketed the costs by group:

```ts
supabase.from("execution_traces").select("user_id, cost_usd").gte("created_at", iso);
```

**It is capped.** PostgREST answers with at most `db-max-rows`, 1,000 on a
default Supabase project. Measured on this deployment while writing this:
**1,104 traces in the current month**. So the sum was already over a prefix — a
group's spend rendered low, its percentage of cap rendered low, and the red
over-cap colouring withheld from a team that may well be over it. The comment
above the read called this "only for display", but a spend figure shown beside a
cap, in the admin tool for setting caps, is the thing someone acts on.

**A failed read is $0.** `traces ?? []` sums to zero and renders as "nothing
spent" — and `$0.00` is also exactly what an untouched group legitimately shows,
so the two are indistinguishable.

**Unpriced calls are free.** `cost_usd ?? 0` counts a call on a model with no
known price as costing nothing. R34 fixed precisely that in the path that
ENFORCES the cap; the display beside it kept doing it, so the two surfaces
disagreed about the same figure while sitting on the same screen.

The fix asks the enforcing path rather than writing a fourth version of the sum.
`groupSpendTotals` is superadmin-only, reads group membership by cursor — an
unbounded membership select has the same cap and would quietly make a group's
total too small — and calls `spendSince`, which prefers the database aggregate
and reports how many calls went unpriced. A membership list that could not be
read in full yields no total at all rather than a floor of a floor.

`floorTotal` moves the rule that decides whether a figure is the answer or a
lower bound out of JSX and into `spendCompleteness`, beside `formatSpend` and
`spendCaveat`. An unknown unpriced count is a floor, not a complete figure — the
same reading `budgetGuard` already uses — and having it in one place is what
stops the display and the gate from drifting apart again. The percentage carries
`≥` when the total is a floor, and the red stays: over a floor, "over cap" is
sound and "under cap" is not.

An unavailable figure says "unknown".

**Tests:** 11 in `groupSpend`, 11 behaviour-changing mutants applied one at a
time and each killed — including one that drops the superadmin guard and one
that declares the membership ceiling without passing it — control missed,
baseline verified green first.

#### R39 · S3 · The comment satisfied the assertion about the code

`expect(tab).not.toMatch(/\.from\("execution_traces"\)/)` failed on its first
run — against the comment above the new read, which quoted the old query to
explain why it went. The test's own comment claimed it was "anchored on the
chained call, not the table name"; it was not.

The remedy this time was to change the PROSE rather than the pattern: the
comment now describes the old read in words, and says why. A negative assertion
— "this call is gone" — cannot be satisfied by a comment if no comment spells
the call. Sixth of this family, and the first where the fix belonged on the
other side of the anchor.

#### R39 · process · A guard test that had to follow its property

`ownerFkCascades` asserts that a trace whose owner was deleted — `user_id` NULL
under `ON DELETE SET NULL` — is never bucketed under one phantom person and shown
as a team's spend. It pinned that with:

```ts
expect(GROUP_BUDGETS).toMatch(/if \(!t\.user_id\) continue;/);
```

Deleting the browser sum deleted that line, and the test went red. The property
itself did not go anywhere: the panel now asks the server for a per-group total,
and the server scopes the sum to the group's explicit member ids, so a detached
row matches no id and is excluded by the database rather than by a guard someone
has to remember to write — stronger than before.

So the assertion followed the property to where it lives now: the panel must not
bucket traces at all, the server function must pass `userIds`, and `spendSince`
must filter on them. That is the useful shape for a guard test whose subject
moves — re-anchor it at the new home and say in the comment why it moved, rather
than deleting it as stale or leaving it pinned to a line that no longer exists.

### 2026-09-20 — The knowledge base asked a membership question of a prefix

#### R38 · S1 · Documents that were already indexed got embedded a second time

Before embedding, the backfill asks which of the documents in its batch already
have chunks, and skips those:

```ts
const { data: existing } = await writer
  .from("kb_chunks")
  .select("document_id")
  .in("document_id", ids);
const have = new Set(existing.map((r) => r.document_id));
pending = docs.filter((d) => !have.has(d.id));
```

No limit, so it reads everything — except PostgREST answers with at most
`db-max-rows`, **1,000** on a default Supabase project, and supabase-js returns
the short page with no error and no flag. The batch is up to 50 documents; at
the default 500-character chunk size a 10 KB document is about 21 chunks, so
**fifty ordinary documents pass a thousand chunk rows**. Past that point some
indexed documents are simply not in the response, and `!have.has(d.id)` cannot
tell "no chunks" from "not in the page I was given".

What that costs: the documents are embedded again — paid API calls — and a
second copy of their chunks is inserted. Duplicate chunks are not just waste;
they change retrieval, because the same passage now occupies several of the
`KB_CHUNKS_PER_DOCUMENT` slots an answer is allowed to cite.

This is the partiality class at its sharpest. Every earlier finding in the sweep
was a number or a sentence that came out wrong. This one is a **set membership
test over a prefix**, where absence from the page read as absence from the
table, and the wrong answer spends money and mutates data.

The same read, with the same cap, builds the per-document chunk counts on the
Knowledge page — so the same documents carry an amber "Pending embedding" badge
while being fully indexed, "Indexed N/M" counts them as missing, "Embed X
pending" offers to fix what is not broken, and the Re-index button's force
decision (`indexed >= total`) is made from the same prefix.

**Cursor paging, not offset paging.** `lib/cursorScan.ts` asks for rows strictly
after the last one it saw, so it never uses a short page as proof of the end —
which matters, because "stop at the first short page" is wrong exactly when the
server's cap is below the page size asked for, and that assumption is what
produced this bug. Two shapes:

- `scanKeysPresent` answers membership and jumps past the whole of a key as soon
  as one of its rows proves it: a document with 40,000 chunks costs one page,
  not forty. At most one round per key, so it terminates even against a page
  source that ignores the cursor.
- `scanRows` keeps every row up to a ceiling and reports whether the ceiling
  bit. It probes one row past the ceiling before saying so, because a table
  holding exactly `maxRows` rows is not a prefix of itself and a caveat on a
  complete answer teaches readers to ignore caveats.

The failed-probe path changed too. The old read dropped its error, and an errored
probe produces an empty `have` — which is the most expensive possible reading of
a failure: re-embed everything. It now fails the backfill.

**Verified live** against the running deployment: for the 50 documents on hand,
the cursor scan returns the same membership set as the unbounded read (11 of 50
have chunks) in 2 requests, and stays correct past 1,000 rows where the
unbounded read does not.

**Tests:** 13 in `cursorScan`, 15 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

#### R38 · S3 · Presence is not use — the fifth, and the first caught by a mutant

`expect(page).toContain("const CHUNK_SCAN_MAX = 50_000;")` passed happily under
a mutant that declared the constant and then passed `Number.MAX_SAFE_INTEGER` to
the scan, which is the difference between a bounded client read and one that
pulls every chunk row in the workspace into a browser tab. The other four this
session were found by reading; this one was found by the harness, which is what
the harness is for. The assertion now pins `{ maxRows: CHUNK_SCAN_MAX }`.

A second anchor broke in the older way: `{chunkCountsWhole && indexCoverage.total > 0`
matched nothing once prettier wrapped the guard across three lines. Those are
regexes now. Source anchors must be bounded by structure, never by the
whitespace prettier chose that day.

#### R38 · process · The gate said 1 and the notification said 0

Third time this session. The background task reported "exit code 0" while the
shell's own `GATE EXIT` line said **1**; the notification reports the wrapper's
status, not npm's. The failure was real:

```
missing path (1)
  SCALE_AND_LIMITS.md: src/lib/cursorScan.ts
1 problem(s).
```

`scripts/check-md-docs.mjs` resolves a backticked repo path against **git's**
index, not the filesystem — so documentation may only name a file the repo
actually has. `src/lib/cursorScan.ts` existed on disk and was untracked, and the
paragraph describing it was, by that rule, a claim about nothing. The repo's own
tooling caught a drift this campaign exists to prevent, which is the outcome the
checker was written for. A new module has to be `git add`ed before the gate runs,
not at commit time.

### 2026-09-20 — The model registry's ceiling was half what the code thought

#### R37 · S2 · A cap of 2,000 that the database enforces at 1,000

`getModelRegistry` read the catalogue with a single `.limit(2000)` and the page
printed `models.length` as the population: "Browse 770 live models across all
major providers", with the provider dropdown, the modality badges, the
capability list and the search box all derived from the same array.

Two things are wrong with that, and the second is the one that makes it urgent.

**The truncation is not even.** The order is `developer, display_name`, so a
prefix is not a thinned-out sample of the catalogue — it is every developer up
to a letter. Measured against the live table just now: first row `AI21 / Jamba
Large 1.7`, last row `Zhipu AI / GLM-OCR`. Cut at any point and the providers
past the cut do not get fewer models on the page, they vanish from it entirely,
including from the provider filter that is supposed to find them. And because
the search box filters the array in hand, they cannot be searched for either.

**The 2,000 does not exist.** PostgREST caps every response at `db-max-rows`,
1,000 on a default Supabase project, and supabase-js returns the short page
without an error — the same mechanism recorded in `lib/traceWindow`'s header
when `/analytics` asked for 2,000 traces and got 1,000. Re-measured on this
deployment while writing this:

```
execution_traces | total 1,109 | returned for limit=2000: 1000
model_registry   | total   770 | returned for limit=2000:  770
```

So the registry's real ceiling is **1,000**, not 2,000, and the table holds
**770** — 77% of the way there, against a third-party catalogue that only grows
and is pruned to match upstream on every sync. This is the sweep's first finding
that is not yet wrong on the screen; it is wrong in the code, and the distance
to it being wrong on the screen is a few hundred models AIMLAPI has not shipped
yet. Recorded as S2 rather than S1 for exactly that reason.

The fix is the one the repo already has: read the exact count first, then page
with `pageTraces`, and let the header say which of the two situations it is in.
Three details worth keeping:

- The ceiling is `MODEL_REGISTRY_MAX_ROWS` (default 5,000) rather than a
  constant, because the thing it bounds is somebody else's catalogue.
- The ORDER BY gained `id` last. `developer, display_name` is not unique across
  modalities, and a page boundary inside a tie is how `.range()` paging starts
  repeating or dropping rows — a bug that would have arrived with the paging
  rather than being fixed by it.
- A count that fails does not fail the page. Rows on screen beat a perfect
  label; the label then claims only what it holds.

`catalogueCount` is a second sentence rather than another noun passed to
`countHeadline` because "the most recent 1,000" is a lie about an alphabetical
list. `catalogueCaveat` is its own sentence because the cost here is not an
undercount but an unreachable filter.

**Verified live** against the running deployment: exact count 770, paged read
770 rows, 770 distinct ids, `windowComplete` true — the new read returns the
whole catalogue today and knows that it does.

**Tests:** 37 in `traceWindow`, 13 behaviour-changing mutants applied one at a
time and each killed — including one that declares the env ceiling and then
passes the page size instead, and one that drops the unique tiebreaker — control
missed, baseline verified green first.

#### R37 · S3 · An anchor satisfied by the comment that explained the fix

`expect(fn).not.toContain(".limit(2000)")` failed the moment it was written,
because the comment above the new read names `` `.limit(2000)` `` to say why it
went. Had the wording been slightly different it would have passed forever while
the call sat there. It now matches a chained call at the start of a line, which
is a thing only code can be. Fourth of its kind this session, and the first
where the decoy was prose rather than a dead identifier: **pin the branch that
runs, not the token that appears** — and the token can appear in a comment.

### 2026-09-20 — The monitoring board went green when the probes stopped coming

#### R36 · S1 · A health verdict that outlived the probes it was made from

`/monitoring` polls every 15 seconds. When a poll throws, the catch does one
thing:

```ts
} catch (e) {
  setError((e as Error).message);
}
```

`setServices` is never called, so the previous probes stay on screen — and so
does the sentence made from them:

> No problems detected · checked 14:02:11

An hour later, that line still says **No problems detected**. The timestamp is
technically honest (it is also only set on success) but nobody reads a clock and
does subtraction, least of all on a page that advertises itself as auto-
refreshing. The reader sees a red banner — which says the _refresh_ failed — and
a green verdict beside it, and concludes the estate is fine and the UI is being
fussy. This is the canonical monitoring failure: the board that freezes green
when the collector dies, on the one page whose entire job is to say whether
anything is wrong.

**The first pass blessed this in a test**, which is the part worth recording.
Module 26 fixed the empty-probe case and then wrote:

> `it("keeps reporting the last-good status when a refresh fails but data remains")`
> — the error banner carries the failure separately.

Two surfaces, one claim. The banner carries _that the refresh failed_; it does
not carry _that the sentence beside it is therefore old_, and a reader who takes
the header at its word takes a reassurance the page can no longer support. A
test that encodes the defect is worse than no test, because the next pass reads
it as a decision already made.

The fix is the asymmetry this sweep keeps meeting. Over a stale snapshot the two
verdicts are not equally salvageable: **`N needing attention` is a floor** —
those services were broken and nothing has since confirmed a fix, so it is still
worth acting on — while **`No problems` is sound in no direction at all**, since
anything could have broken in the interval. The reassuring half is the unsound
half, exactly as with freshness (R31) and budget spend (R34). So both verdicts
move into the past tense and name the check they came from, which is what the
timestamp beside them has meant all along:

> No problems at the last successful check · checked 14:02:11

#### R36 · S2 · The gauges froze too, under a subtitle promising "right now"

`metrics` is set in the same `try`, so a failed poll freezes CPU, memory, disk
and process RSS at their last values as well — beneath a subtitle that reads
"what the machine running it is doing **right now**". Qualifying eight figures
individually would bury the page; `stalenessNotice` says it once, directly under
the banner, covering everything below it. It stays quiet when there is nothing
stale to warn about — a first load that failed with an empty page already has a
banner and an unknown-health header, and a third line there would be noise.

#### R36 · S3 · "No probe results yet" for a read that came back an error

The services table's empty state says "No probe results yet." The word _yet_
belongs to a load still in flight, not to one that returned an error: an empty
list that failed to read is the absence of an answer, not an answer of none.
That is the next queued sweep's class, found on a page already open, so it was
fixed here rather than filed.

**Tests:** 13 in `servicesSummary.test.ts` (the overturned one rewritten, with
the reason in the comment), 8 behaviour-changing mutants applied one at a time
and each killed — including one that restores the old `&& services.length === 0`
gate and one that computes the notice but never renders it — control missed,
baseline verified green first.

### 2026-09-20 — Swarm Observability presented its first page as the account

#### R35 · S1 · The sibling page's fix had never been applied here

`/analytics/observability` reads `swarm_runs` for the last 30 days with
`.limit(200)` and then says:

> 200 swarm runs · click a row to inspect agent-level traces · auto-deleted
> after 30 days

That is a statement about the ACCOUNT made by a read that saw only the first
page, and "auto-deleted after 30 days" sitting beside it makes the number read
as the whole retained history rather than as a page of it.

The first pass had already fixed this page's OTHER half: `listClaim` makes a
count and an empty state claims only a completed read may make, so a query error
prints "unknown" rather than zero. The capped half was never touched — and the
identical defect had been found and fixed on the sibling page, `/traces`, where
`lib/traceWindow` was written for it. That module's header says it exists "so
they are testable and cannot drift into implying completeness the read does not
have", and one page of the Observability pair was doing exactly that.

So the fix reuses the module rather than adding a second one: the noun is a
parameter, the exact count for the same window is read before the rows, and the
page either states the total or says "showing the most recent 200 of 1,312 swarm
runs from the last 30 days". When the window is cut, the list says so again above
the table — a reader who scrolls past the header is still entitled to know the
rows below are a page.

**Tests:** 24 in `traceWindow`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

#### R35 · S3 · Presence is not use — a third time

The source anchor checked that the file contains `countHeadline(`. A mutant that
put `${runs.length} swarm runs` in front of the call left that string in place
and printed the bare row count anyway, and the assertion stayed green.

This is the third source anchor this session satisfied by an identifier that no
longer did anything: `olderThanShown` still present while always set to zero, a
phrase matched in a doc comment instead of the log line it described, and now a
function still called but no longer rendered. The rule that keeps surviving
contact: **pin the branch that runs, not the token that appears.**

### 2026-09-20 — The budget gate counted unpriced calls as free

Three rows of the partiality sweep. Two clear, one the most consequential
finding of it so far.

**Traces & Logs — clear.** Its first-pass finding was "the capped page presented
as the population", and that fix reached every figure: the header goes through
`traceCountHeadline`, an incomplete window says "filters and counts below cover
these, not all N", a filtered view says "of the loaded traces", and per-row and
per-chain costs carry the unpriced label and the `+?` mark.

**Audit log — clear.** `auditWindowHeadline` already states shown-of-total and
the retention boundary.

#### R34 · S1 · The cap was enforced against a total that omitted part of the spend

`spendCompleteness` exists because a call on a model with no known price is
recorded at `cost_usd` 0 — honest on the row, labelled "unpriced" on the Traces
page. The comment beside that label reads:

> "$0.0000 for a call nothing knew how to price reads as 'free', and budgets
> summed exactly that."

Budgets did. **No file under the budget gate mentioned `pricing_missing`** — not
the spend query, not the guard, not the client mirror. So the cap meant to stop
spending was enforced against a total that silently omitted part of it, and the
omission grows with exactly the models nobody has priced yet.

The same asymmetry as R31, on money:

- **over** — sound. If the floor already exceeds the cap, the true spend does
  too, whatever the unpriced calls cost.
- **under** — not sound. Those calls could carry any amount, and the one that
  would tip it over is exactly the one counted as free.

`spendSince` now reports how many calls contributed nothing, and the guard
treats a floor under the cap the way it already treats a lookup that failed:
allowed by default, refused for an operator who set `BUDGET_FAIL_CLOSED` because
they need the cap to hold. **Nothing changes for a default install.** The floor
is logged and carried on the status either way, so an operator sees the cap is
being enforced against an incomplete figure rather than learning it from a bill.

A count that itself fails reports null rather than zero — "no unpriced calls"
and "we could not tell" lead to different decisions under a cap that must hold,
and collapsing them is the same mistake as reading a failed sum as $0.

**Tests:** 27 in `budgetSpend`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

Two assertions were weak, and mutants found both rather than reading did. One
pinned the whole one-line `SpendResult` type, which prettier reflows the moment
a field is added. The other asserted the phrase "is a floor" — which also
appears in a doc comment, so a mutant that rewrote the message an operator
actually reads stayed green. Both pin something load-bearing now.

#### R34 · S3 · A queue row anchored on its own formatting

The queue update failed on its first attempt: it matched whole table rows
including their padding, and prettier reflows every column width whenever any
cell changes. It matches on the row LABEL now. The same lesson as the source
anchors — pin the thing, not the layout around it.

### 2026-09-20 — A baseline that fell off the end of a list

#### R33 · S2 · The compare control did not shrink, it disappeared

The run detail page offers "Compare against": pick an earlier run on the same
dataset, see which cases improved or regressed. It built that list by filtering
`runs` — the **fifty most recent runs across every dataset**.

On an account that evaluates regularly, a perfectly good baseline stops being
offered once fifty newer runs exist elsewhere. And the control is rendered
behind `comparable.length > 0`, so the user does not get a shorter list: the
feature is absent. No picker, no message, nothing to separate "there is nothing
to compare" from "your baseline is run fifty-one".

The list now comes from a query scoped to the dataset, excluding this run,
newest first — so the fifty is a bound on the PICKER rather than a filter that
removes valid answers, and when the dataset holds more than fifty it says so
beside the control. An empty result states why instead of vanishing.

The rule moved to `evalScoring.isComparableRun`, because one of its three
conditions is subtle: two runs whose `dataset_id` are both null are not on the
same dataset, they are each on no dataset, and pairing them invents a
comparison.

**Tests:** 24 in `evalScoring`, 7 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

One survivor was a gap in an assertion rather than in the code: the source check
said the page contains `olderThanShown`, which stayed true under a mutant that
always set it to zero — silencing the disclosure while leaving the identifier
in place. It pins the computation now.

#### R33 · S1 · The fix reintroduced module 28's own defect, and a guard caught it

`tests/unit/failedReadClaims.test.ts` failed on the first gate run. The new
query destructured `data` and `count` and ignored `error`, so a failed read
would have set an empty list and the page would have stated "there is nothing to
compare against" — the exact false-empty this module was converted to prevent,
arriving through the repair for a different defect.

That guard exists because a previous mutation showed the same thing: dropping a
`setLoadError` beside a `setSecrets([])` restored an S1 while the suite stayed
green. It earned its keep here.

The read now separates a failure from an absence. Worth noting what the shared
guard does NOT cover: it checks that an error setter sits _near_ the emptying
line, and two mutants — deleting the error branch, and hiding what it records —
both preserved that proximity and survived. Those two lines are pinned
explicitly now.

### 2026-09-20 — A spend trend built from two floors

#### R32 · S1 · The uncaveated number sat on the caveated card

`spendCompleteness` exists because a call to a model with no known price is
recorded at $0 — honest on the row, silently under-counted once summed. Its
header says the row-level honesty "never reached the numbers people actually
look at", and the fix at the time routed the analytics month-to-date card
through `sumSpend`: it prints `$41.20+?` with a sentence explaining the mark.

Directly beneath that, on the SAME card, `trend={spendTrend}` — "vs last week" —
was computed from two bare reduces over `cost_usd`. One card saying both "this
total is at least this much" and "spend is down 40%", where the 40% could be
entirely an artifact of which of the two weeks held the unpriced calls.

**A trend is worse than a total, and that decides the fix.** A total has a
half-state: marked `+?` it is still a floor and still useful. A percentage has
none — the arrow points down or it does not — and the difference between two
floors is not a floor, it can be wrong in either direction. So when either week
is partial there is no honest percentage, and the reason is printed in its
place. The card shows no arrow rather than a 0% one, because 0% is a claim that
nothing changed. A zero baseline is treated the same way, by the same reasoning
that produced "0% pass" on an unscored evaluation run in R28 of the first pass.

**Tests:** 23 in `spendCompleteness`, 8 behaviour-changing mutants applied one at
a time and each killed, control missed, baseline verified green first. One puts
the bare reduce back on the page, because the defect was never in the arithmetic
— it was that the page did the arithmetic itself instead of asking the module
that knows what the rows are worth.

#### R32 · S3 · The hunt now has a queue

`docs/ADVERSARIAL_QUEUE.md`. The coverage map above finished a first pass over
all 31 modules in August; running it again module-by-module would mostly re-read
pages already read. What has been finding things for thirteen rounds is the
opposite shape — one defect class swept across every module — so the queue names
the current sweep, states the single question to ask, and tracks a row per
module with a cursor.

Nine rows are settled, three of them **clear** rather than fixed. That is the
point: "checked, on this date, against this question" is a result, and three of
the last five candidates turned out to be already correct. Marking them stops
the next session re-deriving that.

### 2026-09-20 — A freshness test that blamed the data for the reader's cap

#### R31 · S1 · "Stale: 412 days old" about a dataset written five minutes ago

The quality evaluator reads at most `DATA_QUALITY_ROW_CAP` rows — 200,000 by
default — and threads a `capped` flag to every check. The row-scoped tests use
it: `not_null`, `unique`, `accepted_values` and `range` all append "(checked the
first N rows)". **Freshness did not.**

A column-based freshness test takes the newest value it can SEE. On a table
larger than the cap that prefix need not hold the newest row, and if the source
is ordered oldest-first it certainly does not. The test then declares the
dataset stale and names the watermark column as the reason — which is the log's
opening line, _a message that names a cause it cannot support_, occurring in the
one part of the product whose entire job is to say whether data can be trusted.

**The two verdicts are not symmetric under capping**, and the fix turns on that
rather than on suppressing both:

- **pass** — the whole table's maximum is at least the maximum of any prefix, so
  a prefix inside the limit proves the dataset is inside it. Sound. Left as a
  pass, and given the cap note the other tests already carried.
- **fail** — the row that would refute "stale" is exactly the row the cap did
  not read. Now reported as unrunnable, which is what this module does with any
  assertion it cannot evaluate, naming the way out: raise the cap, or order the
  source so the newest rows are read first.

The same reasoning covers "no parseable dates in this column", which a prefix
cannot establish either. The load-time fallback is untouched: with no watermark
column the stamp comes from the dataset's recorded load time rather than from
rows, so no cap can affect it.

**Tests:** 28 in `dataQualityCore`, 7 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first. One mutant
exists to pin the asymmetry itself — downgrading the PASSING capped case is
caught, because that verdict IS supported and must not be discarded along with
the unsupported one.

#### R31 · S3 · en-IN again

Two new assertions compared against `"1,000,000"` and met `"10,00,000"`. Node on
this machine resolves en-IN and the code formats with `toLocaleString()`. They
assert the contract — the same formatter — rather than a literal, which is the
only form that holds wherever CI runs. Third time this has been recorded; the
rule is that a test must never hard-code the output of a locale-aware call.

### 2026-09-20 — The Partial badge did not survive the export

#### R30 · S2 · A caveat that exists on screen and not in the artifact

A dashboard card whose snapshot hit the row cap wears an amber **Partial**
badge. The dashboard PDF keeps it, and by luck rather than design: that exporter
rasterises each card with html2canvas, so the badge travels as pixels.

A **report** does not. `biReportPdf` is a vector builder — it draws the title
and places the chart bitmap itself — and neither it, nor the designer's preview,
nor the report generator contained the word `truncated`. Three surfaces, zero
mentions. So a section whose query returned more rows than the cap exported a
chart of the first N with nothing anywhere saying so, in the one artifact that
leaves the product and gets read as final.

One string, `partialRowsCaveat`, and both surfaces render it: the preview under
the chart and under the table, so the designer sees what will export; the PDF as
vector text in the same two places, beside the title it already draws that way.

Scoped to `truncated` on purpose. A table block's `maxRows` also shows fewer
rows than exist, but that is the author choosing how many to print and it is
visible to them in the editor. The cap is the one nothing on the page reveals.

A flowing table repeats its header on every page and must NOT repeat this —
under each slice it reads as a fresh problem each time — so it appears once,
under the last.

**Tests:** 34 in `biReports`, 9 behaviour-changing mutants applied one at a time
and each killed, control missed, baseline verified green first. Two of them exist
because a caveat is easy to compute and forget to draw: one removes the PDF's
call under the chart, one under the table, and no test of the string itself
would have noticed either.

### 2026-09-20 — The insight card called a prefix "the total"

#### R29 · S1 · The second way a result is partial, which the SQL never says

The card already discloses one: a query that caps ITSELF with a trailing LIMIT,
which `queryRowLimit` finds by reading the SQL. There is a second, and reading
the SQL can never find it — the SNAPSHOT hitting the row cap while the query had
more to give. The query asked for everything; the cap took the tail.

So `generateWidgetInsight` was handed a prefix and told, in its own comment,
that its totals were "computed over EVERY row". Below the cap that is true.
Above it the card states a prefix's total as the total, and its shares as shares
of it, summing to 100% of a fragment.

**What makes this worse than a wrong number: the checker grounds it.** The
figures really are derivable from the rows the card was given. Every mechanism
built in R19 and R21 to stop the model inventing a figure passes this one
through, because nothing was invented — it is an honest summary of the wrong
rows. A verifier can only compare prose against the data it is handed; it cannot
know the data is a fragment unless something tells it.

The widget knows. `truncated` is set by both refresh paths and is what the
Partial badge already reads. It now reaches the insight: the digest gains a
second PARTIAL reason with its own sentence, the shares are withheld for either
reason rather than only for a LIMIT, and the caveat forbids the superlatives a
prefix cannot support — "the largest region", "no other category" — because the
rows that would contradict them were never fetched.

**Tests:** 22 in `biInsightFacts`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

One mutant survived the first run and was a real gap: computing the reason and
handing it over are different things. Dropping the third argument to
`formatInsightFacts` still removed the shares, so every other assertion stayed
green while the caveat simply stopped being written.

#### R29 · S3 · Two source anchors, and what each was really pinning

Both broke, and both deserved to.

`biInsightFacts` sliced `src.slice(at, at + 2600)` to get the function's body.
A few lines of comment pushed its last assertion past the window — one edit from
silently asserting about a DIFFERENT function's text. The slice is now bounded
by the next top-level export, which is what "the body" always meant.

`biNumericClaims` pinned `rowLimit != null ? { ...measured0, shares: [] }`. That
condition was widened to `partial`, which covers both reasons — so the anchor
was pinning one arm of a union that had grown. It now asserts the union itself.
Mutation-checked by narrowing it back: caught.

### 2026-09-20 — An alert that watched the first 500 rows

#### R28 · S1 · The threshold was compared against a prefix, and emailed as fact

`evaluateAlerts` computes an alert's value with
`alertValue(widget.rows ?? [], ...)`, and `widget.rows` is a PREFIX:
`applyResult` slices to WIDGET_ROW_CAP and the engines cap at the same number.
On a table smaller than the cap the prefix IS the result and nothing is wrong.
On a warehouse table it is not — and the alert then compares a threshold
against the sum of the first N rows and sends a notification and an email
stating that figure as fact.

`count` is the worst of them. It returns `rows.length`, which on a capped
snapshot is exactly the cap, so **"row count above 1000" can never fire** and
"row count below 600" always does.

This is invisible at demo scale, which is why it survived: every table in the
seeded data is smaller than the cap. It is systematic on anything real.

When the snapshot is partial the aggregate is now asked of the database, built
through the same validated path pushdown uses — `renderAggregateClauses` for
identifier resolution and per-dialect quoting, `buildDirectQuerySql` for the
wrapping. Where that cannot be done the alert does NOT fall back to the prefix:
it declines to fire and tells the owner once, because a rule that has silently
stopped watching is the same bug one layer down.

A forecast basis is included in the refusal. A curve fitted to a prefix of a
series is not a forecast of the series.

**Verified against a real engine.** The SQL this produces for the live "Revenue
by Region" widget was run on the lakehouse through the Workbench and returned
**51,749.84** — the seeded truth total, and the figure the alert needs instead
of a prefix sum.

**Tests:** 26 in `biRefreshScheduling`, 7 behaviour-changing mutants applied one
at a time and each killed, control missed, baseline verified green first.

#### R28 · S1 · Two defects in the fix, both found by its own tests

The first version built the scalar aggregate with `dims: []` and trusted
`buildDirectQuerySql`. That emits `GROUP BY` **followed by nothing** — a syntax
error in every dialect — because the builder assumed every plan has dimensions.
`aggregationPlan` refuses an empty `dims`, so no chart had ever reached it; an
alert asking for one measure does. The builder now omits an empty GROUP BY.

The tests did not catch that, because they asserted `toMatch(/SUM\(/)` and
"contains the base query" — both true of the malformed string. They assert the
whole SHAPE now.

The second was worse and a mutant found it. The function decided the plan had
been refused by comparing the result against the base SQL — but the builder does
not return the base SQL when it refuses a plan, it returns `SELECT * FROM (…)`.
So a column the validator would not quote produced a RAW-ROW query, which
`scalarFrom` would have read a number out of: a wrong alert value dressed as an
exact one. It now asks `renderAggregateClauses` whether it will render the plan,
rather than inferring from what comes back.

#### R28 · S2 · The harness emptied a source file

Recorded because it nearly cost uncommitted work. A mutation harness restored
files with `io.open(path, "w").write(original)`. That truncates on open and
evaluates the argument afterwards, so when a rename left `original` undefined
the file was emptied and never rewritten — and the `finally: restore()` raised
the same error. 1491 lines gone; `git checkout` recovered them only because the
file was committed.

Harnesses in this repo now compute the bytes first, assert they are non-empty,
and only then open for writing — and assert every target file is non-empty
before starting, so a second run cannot mutate what the first run emptied.

### 2026-09-20 — A live result under sentences written about a snapshot

#### R27 · S1 · The one widget the restatements could not reach

`query_mode: "direct"` re-runs the SQL at view time and draws that instead of
the stored snapshot. The render substitution carried the live columns, rows and
truncation onto the widget — and left the two SENTENCES alone:

```
{ ...w, columns: live.columns, rows: live.rows, truncated: live.truncated }
```

`w.title` still held the reconciliation note and `w.narrative` the prose, both
computed against the snapshot. So a direct widget could read "The data has 3
rows, not 5." above a live result with five bars in it, and its hover text could
quote a total from whenever the snapshot was last written.

The refresh-time restatements built in R24 and R26 cannot reach this. They
rewrite the widget's STORED rows, and a direct widget's stored rows are not what
it is drawing. Nothing in the dashboard ever compared the sentences to the live
answer.

`widgetForLiveResult` derives both from the live result at render. Nothing is
persisted, which is the point twice over: a live result belongs to one view —
two people looking through different filters are looking at different rows, and
the only honest answer is for the card to say different things to them — and a
sentence that is never stored is a sentence that can never go stale.

**Tests:** 8 in `biDirectWidgetDisplay`, 8 behaviour-changing mutants applied one
at a time and each killed, control missed, baseline verified green first.

One mutant survived the first run and was a real gap: the fixture gave the
stored widget and the live result the SAME column names, so "took the live
columns" and "kept its own" were indistinguishable. A test whose fixture cannot
tell the two branches apart asserts the right answer for the wrong reason, which
is the second time this session mutation testing has caught exactly that.

### 2026-09-20 — Prose about a result the widget no longer has

#### R26 · S2 · The narrative outlived its rows, with the figures still in it

The same defect as R24, one field over, and this one carries numbers. A widget
stores the sentence the AI wrote about it and shows it on hover. Neither refresh
path has ever touched it, so the prose describes rows that were replaced
underneath it.

Found live rather than reasoned about. The widget left on the dashboard from
R24's failed first attempt queries five MONTHS, and was still carrying:

> The top region, AMER, generated $25.9k in revenue. The three regions together
> generated $51.7k in total revenue.

Its five rows are monthly figures totalling about 9k. There are no regions in
them at all.

`restateWidgetNarrative` re-checks the figures against the rows the widget now
holds, with the verifier built in R19 and R21 and no model call, and withdraws
prose whose numbers no longer ground. Withdrawn rather than corrected: nothing
here can rewrite an English sentence truthfully, and an absent tooltip beats a
confidently wrong one. The narrative is derived content about one result — when
the result is gone the prose is not about anything the widget has.

Two limits, deliberate. A capped snapshot is not checked: the figure may be true
of the table and simply not derivable from the part of it kept here, and
deleting correct prose on that evidence is the worse error. And a numeric
verifier has nothing to say about "AMER leads the regions", which survives AMER
falling to third — sentences with no figures are left alone rather than deleted
on suspicion.

**Tests:** 33 in `biNumericClaims`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first. A ninth
candidate was dropped as EQUIVALENT rather than counted: removing the no-figures
guard changes no outcome, because prose with zero claims yields zero unsupported
figures and the same null a line later. It earns its place by skipping a scan of
the rows, not by changing a result.

#### R26 · S3 · One withdrawal this round could not be checked

The first run of the check over widgets built in earlier rounds withdrew two
narratives. One is the R24 artifact above, and arithmetic settles it. The other
was **Units Sold by Region**, whose rows are APAC 2121, EMEA 2118, AMER 2115 —
total 6354, average 2118 — against prose beginning "A total of 6.4k units were
sold across all regions, with an average of 2.1k units per region. APAC led with
the highest sales at 2…". Every figure in that fragment grounds: 6.4k is within
tolerance of 6354, 2.1k of 2118, and APAC did lead.

Whatever failed is in the part after the 130 characters that were captured, and
by the time that mattered the prose was gone. Version history offers restore,
not read, and restoring would have destroyed the demonstration. So it is
recorded as unverified rather than assumed correct.

What IS established is that the check does not churn: a second refresh over the
same 23 narratives, with none of their data changed, withdrew **zero**. The risk
worth worrying about with a destructive check is that it fires on prose that is
still true, and on this dashboard it does not fire twice on anything.

### 2026-09-20 — A headline number that was one row of three

#### R25 · S1 · `rows[0]` in the type size reserved for a total

`BiChartRender` draws a KPI as `rows[0]?.[chart.valueField]` and stops. When the
query returned one row that is the whole truth. When it returned three, the card
puts one slice of a breakdown in the largest type on the dashboard and says
nothing about the other two.

Three live instances, read out of React state on a generated dashboard:

| Card                  | Shows          | Of                                                |
| --------------------- | -------------- | ------------------------------------------------- |
| Revenue by Region     | AMER 25,874.92 | 3 rows — EMEA 15,524.94 and APAC 10,349.98 unseen |
| Units Sold by Plan    | free 2,139     | 3 rows — pro 2,118, enterprise 2,097 unseen       |
| Best Month by Revenue | "2025-05"      | 36 rows — and CORRECT                             |

The first is the shape of the problem: 25,874.92 is half of the 51,749.84 total,
displayed under a title promising the breakdown. A reader takes the big number
as the answer, because that is what big numbers on dashboards are.

**The third is why the rule is not "a KPI with more than one row".** "Best Month
by Revenue" is a KPI over thirty-six ORDERED rows whose `valueField` is `month`.
Row zero is the answer there. A caveat on it would be noise, and noise is what
teaches people to ignore the caveats that matter. The check therefore fires only
when the displayed value is a **measure** — a finite number — which is exactly
the case where row zero is one slice presented as a total, and excludes the case
where it is the extreme the title asked for.

`unshownRows` is computed where the number is drawn, not stored on the widget.
That is a deliberate consequence of R24: a count of rows is precisely the kind of
sentence that goes stale when a refresh replaces the rows, and this one cannot,
because nothing keeps it. Single-value charts carry `1 of N rows` under the
figure; the gauge takes the same caveat, since a gauge is a single-value chart
with a dial around it.

**Tests:** 21 in `biChartFields`, 8 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

A ninth candidate mutant was investigated and dropped rather than counted:
removing the `!valueField` guard is a **tsc** error (TS2538, "Type 'undefined'
cannot be used as an index type"), so it is caught by the typecheck rather than
by this suite, and the numeric test below it would swallow it at runtime anyway.
Established by applying it and running tsc, not by reasoning about it — a
surviving mutant is either a test gap or an equivalent one, and which of the two
is not a judgement call to make from the armchair.

### 2026-09-20 — The badge that outlived what it vouched for

The opening paragraph of this log names the failure it exists to hunt: _a badge
that outlives what it vouched for_. The reconciliation notes built over R20-R23
were exactly that, and had been since the first one shipped.

#### R24 · S1 · "The data has 3 rows, not 5." beside a chart drawing five bars

A note is a statement about ONE query result. `refreshAll` in the dashboard
route and `applyResult` in the scheduled refresh both replace that result —
they rewrite `rows`, `columns`, `truncated` and `refreshed_at` — and neither
has ever touched `title`. The note is fused into the title string, so it stands
unchanged while the thing it describes is swapped out underneath it.

The result is worse than the silence it replaced. A reader who takes the
trouble to check the caveat against the chart finds the product contradicting
itself, and learns that its caveats are decoration.

`restateWidgetNote` re-derives the count on every write that replaces the rows
and rewrites the sentence, or withdraws it. It is stored on the widget as
`reconcile_note` rather than parsed back out of the title, because a separator
is not a marker: an owner may put an em dash in a title for their own reasons.

Three things deliberately stop it. A snapshot that hit the row cap has no count
to speak of — `rows.length` is the cap, not the result — so the note stands and
the **Partial** badge explains the widget instead. A title whose suffix is no
longer the note has been rewritten by its owner, and those are their words now.
And a note that is still exactly right is left byte-identical, so a refresh that
changes nothing writes nothing and cannot lose a concurrent edit.

Only the COUNT note is re-derivable, which is why it is stored and why the
generator now emits it last. A field note ("returns no revenue column, so the
rows are shown instead") describes a repair already applied to that widget — its
chart is a table now — so re-running that check would find nothing wrong and
delete a sentence that is still true.

#### R24 · S1 · A new field is not a field every writer knows about

Found by the UI test failing, and it was my own change that caused it.

The first attempt to verify this drove the obvious route: generate a widget with
a note, edit its SQL so the row count changes, refresh, watch the note go. The
note did not go. The widget had no `reconcile_note` at all — `BiBuilderPane`
constructs its widget from an explicit list of fields, and anything not named
there is dropped. Editing any widget therefore ORPHANED its note: the sentence
stayed in the title with nothing able to restate it, permanently.

Adding a field to a type does not add it to the code that rebuilds objects field
by field. The same lesson as the stored-identifier one further down this log —
enumerate every writer — in a new disguise. The pane now carries the note and
restates it on save, for the same reason a refresh does: the owner may have just
changed the SQL underneath it.

The test for it is source-anchored, because no unit test of a pure function can
watch an object literal fail to mention a key.

**Tests:** 39 in `biTitleClaims`, 11 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

### 2026-09-20 — A chart names its columns, and the query need not return them

R22 recorded this open and did not fix it. Fixed here, with the part that is
still only unit-tested said plainly.

#### R23 · S2 · The widget that looked like it was still loading

A generated widget drew five x-axis labels, no y-axis, no bars, and no
explanation. Its query and its chart, both from the same generation:

```
sql:   SELECT month FROM analytics.bi_demo_sales
       WHERE revenue IS NOT NULL ORDER BY revenue DESC NULLS LAST LIMIT 5
chart: { type: "bar", xField: "month", yField: "revenue" }
```

The query orders BY revenue and never selects it. So the chart's measure names
a column that does not exist, and a bar chart with no measure draws an empty
frame that is indistinguishable from one still fetching.

The title check next door cannot see this. It compares a title against a ROW
COUNT, and five rows under a title promising five agree perfectly. Only reading
the chart's FIELDS against the query's COLUMNS finds it.

`reconcileChartFields` now does that, deterministically and with no model call,
in three outcomes ordered by confidence. A missing **series split** is dropped
without comment — a chart that cannot find the column it meant to split by is
not broken, it is a chart with one series. A missing **measure or category** is
re-pointed when exactly one unused column of the right kind could have been
meant; two candidates is a guess, and a guess drawn as a chart is worse than no
chart. Otherwise the widget **shows its rows as a table** and the title names
the missing column, because five months a reader can see beats an empty frame.

Which field must be a number depends on the chart and not on the field's name:
a bar chart's `yField` is its measure, a sankey's is a node label, a heatmap's
axes are both categorical with the measure in `valueField`. A single set of
field names would move a repair onto the wrong column, which is worse than the
blank chart it set out to fix.

The correction is applied to the TURN rather than to the finished widget, so
`widgetFromBiTurn` derives `agg_pushdown` from the spec that will actually be
drawn. A mutant that moves it after the build is caught for that reason.

**Tests:** 15 in `biChartFields`, 14 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

One mutant survived the first run — "columns already drawn are offered to
repairs" — and it was EQUIVALENT rather than a gap. Fixing an earlier defect
(two missing fields both claiming the same spare column) had added a
`!taken.has(c)` guard inside the loop, which made the outer filter redundant.
The redundancy was removed rather than the mutant kept: two guards doing one
job is how a later reader concludes the real one is unnecessary.

#### R23 · S2 · What the UI could not be made to show

Four generations on the rebuilt image, and the repair path did not fire in any
of them: every query the SQL step wrote selected its own measure, including one
run handed the literal one-column SQL and asked to use it unchanged. The bug is
real — it was observed twice in R22, before this check existed — but it could
not be summoned on demand, so `unplottable` and the re-point repair rest on
unit tests and mutants alone.

What the four runs do show is the half most likely to go wrong. A guard that
fires when it should not would have turned four correct charts into tables
carrying an apology. None of the four grew a note.

#### R23 · S3 · An anchor that went stale the moment the line moved

R22's source-anchored test pinned the note application with
`dash.indexOf("fixed.note ? \`${base}")`. This change rewrote that line to join
two notes, so the anchor matched nothing, `indexOf`returned`-1`, and the
assertion failed with _expected -1 to be greater than 16636_.

It failed loudly, which is the good case. The point worth keeping is what did
NOT catch it: the mutation run for the new check passed a green baseline,
because it runs one test FILE and the broken anchor lived in the neighbouring
one. Only the whole gate saw it. A per-file mutation run proves the tests in
that file kill those mutants; it says nothing about the file next door that
pins the same line.

The anchor now names the current expression and also asserts the title note is
still IN the joined list — because every other test in that file stops at
`reconcileTitle`'s return value, so a list that quietly dropped it would leave
the R20 bug fixed in the unit tests and back on the dashboard. Mutation-checked:
removing `fixed.note` from the list fails that test.

### 2026-09-19 — The guard that told the truth about the wrong thing

`widen` was built in R20 to repair a query that capped itself, and R20 recorded
honestly that it had never fired on a live generation. Driving one more
generation to find out why produced the answer, and a worse bug with it: the
repair could not be reached from the case that needed it most, and the branch
that took that case instead printed a false statement about the reader's data.

#### R22 · S1 · "The data has 1 row, not 5" — of a table holding thirty-six

Asked, through the generate dialog, for one bar chart over the seeded 36-month
lakehouse table. The model returned:

```
title: "Top 5 Months by Revenue"
sql:   SELECT month FROM analytics.bi_demo_sales
       GROUP BY month ORDER BY SUM(revenue) DESC LIMIT 1
```

and the widget rendered

```
Top 5 Months by Revenue — The data has 1 row, not 5.
```

The table has thirty-six months. The note is false, and it was written by the
guard whose entire purpose is to stop a widget saying something false.

`reconcileTitle` returns from every path inside `if (claim)`, so the `widen`
branch below it was reachable only by a title naming NO number. A title that
names one — the only kind that can be compared against a row count at all —
fell to `rowCount < claim.n` and was told the data was short. The single input
that makes the check possible was the input that disabled its repair.

The distinction the fix turns on is that **a query which stopped at its own
`LIMIT` has not told you how big the table is**. So `short` is now reserved for
the case where the count is a fact about the DATA — no limit, or a limit the
query never reached — and a query that capped itself below its title's number
is re-run for that number. The re-run carries the same `ORDER BY` requirement
`truncate` already had, because re-running an unordered query returns more
arbitrary rows rather than the top five. When the re-run cannot be made at all,
the note says the QUERY stopped, which is the part that is known to be true.

**Tests:** 8 added, 28 in the file, 11 behaviour-changing mutants applied one at
a time and each killed, control missed, baseline verified green first.

One of the eight did not test what it was aimed at when first written. The
"stopped below its own limit" case used `LIMIT 10` under a claim of 10, so
`limit < claim.n` was already false and the clause under test — `rowCount >=
limit` — was never reached; the mutant flipping it to `<=` survived. A limit
BELOW the claim reaches it. Recorded because the test read correctly and
asserted the right answer for the wrong reason, which is the failure mode that
mutation testing exists to expose and that reading the test cannot.

#### R22 · S2 · OPEN — a chart whose measure is not in its own result set

Found in the same frame and deliberately not fixed here. The repaired widget
draws five month labels and no bars: the model's SQL selects only `month`, so
the chart spec's `yField: "revenue"` has no column to plot, and the widget
renders an empty plot area saying nothing about why. The R20 widget beside it,
whose query selected the measure, draws five bars and a 0-2.0k axis.

The title check cannot see this — it compares the title against the ROW COUNT,
and those agree. Comparing a chart's declared fields against the columns its
query actually returned is a different check. Recorded open rather than folded
into this round's change.

### 2026-09-19 — The analyst's answer, checked the same way a card is

The numeric check shipped on the insight card. The busier surface is the
analyst's written answer: every natural-language question produces one. It
already computed its own facts — added after it once reported "approximately
$1.4M" against a true total of $704,186 — but nothing verified what came back.
It does now, with the same write, check, retry-once, disclose loop.

#### R21 · S3 · A check that would have punished obedience

The design problem was not the checking, it was what counts as checkable.

An analyst answer is handed a prepared FACTS block and told to use it, and some
of those figures are not row values and not totals: how many distinct
identifiers a column holds, how many rows of how many the engine returned
before truncating. Grounding only against rows and computed aggregates would
have flagged the model for quoting exactly what it was instructed to quote —
the fastest way to make a warning worth ignoring.

So anything the writer was GIVEN counts as grounds. `valuesStatedIn` reads the
numbers back out of the same text the model was handed, which keeps the two in
step without the caller having to describe its facts twice in two shapes. A
truncated result still withholds its shares from the checker, for the reason a
`LIMIT`-capped query does: they would be shares of a prefix.

#### Driven, and what it did not show

Two questions through the AI analyst on the rebuilt image, with `window.fetch`
patched to record every `/api/bi` call and clone its reply.

- _"What is total revenue by region?"_ — one narrative call, no retry.
  `$2.3M` against a true 2,297,201.86; `$1.0M` against EMEA's 1,042,800;
  `$415k` against APJ's 415,500, which passes at exactly the ±500 the written
  precision allows.
- _"What share of total sales does each region hold?"_ — chosen because a
  question about shares invites an invented percentage. No retry.
  45.4% and 18.1% are the real shares, and "about 33.3%" is the mean of the
  share column, which the facts state.

**The catch path did not fire in either run, and this entry does not pretend it
did.** Both answers were correct, which is what handing the model computed
facts is for; the check is the backstop behind that, and it is proven by unit
tests and by the mutant that severs it. Two attempts at inducing an invented
figure is not evidence that one cannot occur.

One probe artefact worth recording, because it nearly became a false claim: a
first version detected corrections by looking for the phrase "must not appear"
in the request body, and reported a correction on the **SQL** step, whose
prompt contains that phrase for its own reasons. The marker is now the
narrative correction's own opening sentence. A probe that matches something
other than what it claims to match will happily confirm whatever you hoped.

**Tests:** 27 in `biNumericClaims`, 25 behaviour-changing mutants applied one at
a time and each killed, control missed, baseline verified green first. Two of
those mutants exist because the first run silently SKIPPED them — one anchor
matched twice once the insight card and the narrative shared a retry shape, and
one matched nothing after Prettier reflowed a line.

### 2026-09-19 — A widget's title is a claim, and claims get checked

The numeric verifier (R19) checks the prose a visual is described with. It
cannot check the visual itself, and the two drift apart: the planner names a
chart before it knows what the query will return.

#### R20 · S1 · "Top 5 Products by Sales" over fourteen bars

Verified on the running instance rather than inferred: the widget is a real
recharts bar chart and its category axis carries **fourteen** labels —
ContactMatcher, FinanceHub, Site Analytics, … Storage. Its SQL is

```sql
SELECT "Product", SUM("Sales") AS total_sales FROM saas_sales
GROUP BY "Product" ORDER BY total_sales DESC
```

with no `LIMIT`. The SQL prompt does tell the model to "use LIMIT only when the
question itself asks for a top-N"; the question did, and the model did not.

A title promising N over a query that returned more now takes the N it
promised — **but only when the query sorted its rows**. The first five of an
unordered result are an arbitrary five, which is a different lie from the one
being repaired. No re-query is needed: the rows arrive in the query's own
order, so slicing them is precisely what `LIMIT 5` would have returned, and the
stored SQL is rewritten so a later refresh agrees with what is on screen.

#### R20 · S3 · "Top 10 Customers by Sales" over twelve rows

Nothing to do with SQL. `BarRace` takes `topN = 12` and the requested N never
reached it. The spec now carries `topN`, the generator sets it from the title,
and the renderer passes it through — three places, because a value that stops
at any of them is a title the chart does not keep.

#### R20 · S2 · A promise the data cannot meet

The complement of the first finding, and the one driven end to end here:
"Top 5 Regions by Revenue" over a table with three regions. Rows cannot be
invented, so there is no repair — only disclosure. The widget now reads

> Top 5 Regions by Revenue — The data has 3 rows, not 5.

#### R20 · S2 · And the repair was written where it could not survive

Found by driving it, and it is the reason this round was driven at all. The
note was applied to `widget.title` immediately after the widget was built —
and two lines later the generator does

```ts
widget.title = picks[i].title || widget.title;
```

which overwrote it. The unit suite was green throughout: it asserted the note
was **produced**, never that it **survived**. Twenty tests and seventeen
mutants did not see it; one forced generation did.

The note is now applied with the final assignment, and the test asserts the
ORDER of the two rather than the presence of either — with a mutant that
reinstates the overwrite, which is now caught.

#### On the `widen` repair, honestly

A category chart whose query ends `LIMIT 1` over a `GROUP BY` is re-run without
the limit, because a one-bar bar chart is not a chart. **This guard has no
observed instance.** It was motivated by R19's "Revenue by Region", which that
entry described as a bar chart and which is in fact a KPI — see the correction
there. A KPI reaching for one row with `LIMIT 1` is coherent, and the rule
correctly declines to touch it.

It is kept because the SQL it guards against is real — the generator does emit
`GROUP BY … LIMIT 1` — and the only accident was which widget it landed on. If
the same query had been attached to the bar chart the title implied, the chart
would have drawn a single bar. Recorded as a guard rather than a repair so that
nobody later reads it as evidence of a defect that was never seen.

Mutation testing pushed back on the scope twice while this was written: one
mutant showed the KPI test never exercised the category-chart condition at all
(its SQL had no `GROUP BY`, so the rule was never reached), and another that
there was no test for a widening re-query returning **empty** — where replacing
a rendering widget with nothing is worse than leaving it narrow.

**Tests:** 20 in `biTitleClaims`, 18 behaviour-changing mutants applied one at a
time and each killed, control missed, baseline verified green first.

### 2026-09-19 — The insight card, checked rather than trusted

The card that reported shares summing to 106% was fixed in R18 by computing the
facts and handing them to the model. That made an invented figure less likely
and nothing made it impossible, so this round built the check — every numeral
in generated prose matched back to a row value, a computed total, range or
mean, or a share — and then drove it from the UI, which is where both of the
findings below came from.

#### R19 · S2 · The verifier flagged a correct sentence, because of one letter

Pressing **AI insight** on "Monthly Units Sold Trend" produced two `/api/bi`
calls instead of one — the signature of a rejected first draft. Capturing both
drafts showed the sentence it objected to:

> some months like January 2023 and March **2024 b**oth recording the minimum
> of 159 units

The extractor had read the **"b" of "both"** as a BILLION suffix, turning 2024
into 2.024e9. That also stopped it looking like a four-digit year, so the guard
that exists precisely to skip years never fired, and a correct sentence was
sent back to be rewritten. The same trap was waiting in "300 basis points",
"12 bottles" and "7 key accounts".

A single-letter magnitude must now sit directly against its digits — `$1.2M`,
`3.4k` — while a spelled-out one may take a space, since `$2.3 million` cannot
be misread. Verified on the rebuilt image: the same widget now answers in one
call, and its card still contains the phrase "January 2023".

This is an argument for driving the thing rather than reading it. The unit
tests were green, the mutants were all killed, and the bug was in a regex
branch no test had thought to write, in prose no test had thought to invent.

#### R19 · S1 · A card whose every figure verifies, and whose sentences are false

"Revenue by Region" produced a card headed "What the data shows":

> AMER accounts for **100%** of the total revenue in this dataset.
> There are **no other regions** contributing to revenue.

The seeded table has three regions. The verifier passed the card with zero
corrections — correctly, because the widget's SQL is

```sql
SELECT region, SUM(revenue) AS total_revenue FROM analytics.bi_demo_sales
GROUP BY region ORDER BY total_revenue DESC NULLS LAST LIMIT 1
```

`LIMIT 1`. Relative to the one row the widget holds, 100% is exactly right and
no other region is present.

> **Correction, 2026-09-19.** This entry first described that widget as _"a bar
> chart whose generated rationale was 'easy comparison of revenue across
> different regions'"_. That is wrong on both counts and the error was mine.
> Checked against the running instance, the widget is a **KPI** — no recharts
> node, no axis labels, a single value with a label — and the rationale quoted
> belonged to a _different_ dashboard, the one generated over `saas_sales`. A
> KPI that takes the top region with `LIMIT 1` is coherent SQL, not a defect.
>
> What stands: the insight card's claims were false and the fix is right. A
> card asserting "100% of the total revenue" and "no other regions
> contributing" is wrong about the business whatever chart it sits beside, and
> the PARTIAL caveat is what stops it. What does not stand: the picture of a
> bar chart drawing one bar. The `widen` repair built in R20 was motivated by
> that mistaken picture, correctly does NOT fire here — it is scoped to
> category charts, and a KPI is not one — and is documented there as a guard
> against an adjacent case rather than a repair of an observed one.

**This is the most dangerous shape a generated claim can take**, and it is
worth being precise about why: every figure in it verifies. A check on the
prose cannot catch it, because the prose is not wrong about its data — the
data is wrong about the world. Nothing downstream of the query can fix a
sentence like that; what has to change is what the model is told the data IS.

So a query that caps itself now says so. A trailing `LIMIT n` produces a
PARTIAL line in the facts _instead of_ the shares — "these are the top n rows
only and NOT the whole breakdown; do not state shares of a total, do not call
anything 100%, and do not say other categories are absent" — and the shares are
withheld from the checker too, so a "100%" written against a capped result is
caught rather than grounded.

Verified on the rebuilt image, same widget, same button. The card now reads:

> The AMER region generated a total revenue of $25,875. This revenue figure
> represents the highest revenue among the regions analyzed.
> **Watch out for** — The data only includes the top region, so insights on
> other regions are not available.

It disclosed the truncation itself, which is better than merely not lying about
it, and it needed no correction: told the truth about its data, the model wrote
something true.

#### The same defect as R18's "Top 5", in the mirror

R18 recorded "Top 5 Products by Sales" rendering 14 bars because the generated
SQL carried no `LIMIT`. This is the same defect inverted — a title promising a
breakdown over SQL that returns one row. Two instances now, in opposite
directions, from one generator. Reconciling a widget's title against what its
query actually does is no longer an optional refinement.

#### Method, twice over

Both of this round's process guards were earned rather than designed.

A mutation run over the verifier came back thirteen-for-thirteen **with the
control also caught** — the only visible symptom of a run that measured
nothing, because a rename two steps earlier had left a source assertion red and
every mutant was "caught" by that standing failure. The harness now asserts a
green baseline before it mutates, and that guard fired for real within the
hour: a source assertion with a hard-coded 4,200-character window had stopped
covering the end of a function that grew. It now slices to the next top-level
function.

**Tests:** 37 across `biNumericClaims` (22) and `biInsightFacts` (15), with 19
behaviour-changing mutants applied one at a time and each killed, control
missed, baseline verified green first.

### 2026-09-18 — BI dashboarding and reporting, end to end

Twenty-five of the twenty-six visual types on one dashboard over a series whose
every value was known in advance, then the AI half: generate a dashboard,
generate a paginated report, an insight card, the insight sweep, and an
ontology over the lakehouse. The arithmetic held up almost everywhere — the
forecast to a 1.4% MAPE, the matrix cell by cell, two AI-generated widgets
agreeing on a total to the cent. What did not hold up is what happens to a
number between being computed and being read.

Four of the six defects below are one sentence: **a value the query returned
is not a value a person can read, and nobody converted it** — a country code,
a timestamp on an axis, a timestamp in a table, a float in a report cell. The
other two are the AI inventing arithmetic it was never given, and the largest
generation in the product running on the smallest deadline.

#### R18 · S1 · A column of ISO country codes drew one country

A filled map and a bubble map over `SELECT country, sum(amount) … GROUP BY 1`,
where `country` holds alpha-2 codes — the ordinary way country data is stored.
Both rendered, shaded a single country, and said so in grey 9px text in the
corner: **"10 rows not matched to a country"**.

The matcher worked on the country NAME through a hand-kept alias table whose
only code-shaped entries were `usa`/`us` and `uk`. Of the 280 assigned alpha-2
codes exactly TWO resolved, and `UK` is not one of them in ISO: the real code
for the United Kingdom is `GB`, which drew nothing at all.

Alpha-2 now resolves through `Intl.DisplayNames`, which already knows every
assigned region, and the numeric form through the atlas's own feature ids,
which ARE ISO 3166-1 numeric — rather than a 249-row table in the component
that would be wrong the first time a code is reassigned. Measured against the
bundled Natural Earth 110m atlas: **171 of its 177 countries** now resolve from
a code, up from 2.

Writing the test turned up two aliases that had always pointed at nothing:
`macedonia → "north macedonia"` (the atlas shape is called "Macedonia", so the
plain name vanished) and `cape verde → "cabo verde"` (the 110m atlas carries no
Cape Verde under either spelling). Both removed; a test now asserts every alias
names a shape the atlas can actually draw.

#### R18 · S1 · A date axis on AUTO printed epoch milliseconds

Found on the first report the AI generated. The planner asked for a monthly
revenue trend, the SQL writer produced `date_trunc('month', order_date)`, and
the chart drew a correct line under an axis reading `1667260800000`,
`1696118400000`, `1725148800000` — on the page a finance team reads.

The data was never wrong: pressing the chart's **M** grain button relabelled
the same line `2022-05 … 2025-12`. But the toggle defaults to "auto", and auto
did no bucketing at all, so the unreadable axis is the one every reader gets.
The toggle is offered on line and area charts only, so a column chart over the
same column had no escape hatch whatsoever.

The dashboard's hand-built tiles had escaped this only because their SQL emits
strings; every chart whose query returns a real timestamp was affected, which
is every chart the AI writes.

Auto now picks the finest grain whose labels still fit and **relabels in
place** — an explicit grain is a request to regroup the data (it sorts, sums,
and drops what will not parse), where auto is only a request to make the axis
readable, so no row moves, disappears or changes value. A bar chart still
combines equal categories afterwards, as it always has; a line chart, which
does not aggregate, keeps every point.

#### R18 · S2 · The report preview showed a number the PDF never prints

The "Top Products by Revenue" table read `410379.26499999943` in the preview
while the exported PDF rendered the same cell `410,379.26`. The PDF had a
`cell()` formatter; the preview called `String(v)`.

That contradicts the preview's own stated purpose, which its file header spells
out: it paginates with the same function the PDF uses, because "a preview that
flowed differently would be a picture of a document nobody receives". Cell text
is part of what a reader receives. One formatter now, used by both.

#### R18 · S1 · And a date column in that table printed the epoch too

The AI's "Monthly Revenue Summary" section had an `Order Date` column whose
every row read `1640995200000`. Formatting it as a number — the fix above —
would only have made it `1,640,995,200,000`.

So a table column is now typed from its values before anything is printed:
dates print as dates, and **each row keeps its own**, which is where a table
parts company with a chart axis. An axis may relabel a whole column to one
grain because an axis is a scale; a table is a list somebody checks a row of.

This nearly introduced a worse defect than it fixed. `parseDateValue` maps any
number below 10^10 to seconds-since-epoch, so the money column
`13946.229, 4810.558, 55691.009` parsed as three moments in 1970 and the first
version of this change relabelled the finance team's revenue as dates. Caught
by a test written before the code was trusted. The detector is now deliberately
narrower than `parseDateValue`: integers only, inside a plausible epoch range,
and anything short of unmistakable is left exactly as the query returned it.

#### R18 · S1 · The AI insight's percentages summed to 106%

Pressing **AI insight** on a "Sales by Region" bar produced a card headed
"What the data shows":

> EMEA leads with total sales of $1.0M, accounting for **48%** of overall sales.
> AMER follows with $837k, representing **39%** of total sales.
> APJ has the lowest sales at $415k, making up **19%** of the total.

48 + 39 + 19 = 106. No denominator makes three shares of one total sum to 106%,
so this needs no reference data to be wrong. The prompt had asked the model to
"quote real numbers from the data", which it did for the dollars — the
percentages were not in the data at all, and the model did the division.

The division is no longer the model's job. Totals, ranges and each category's
share are computed over **every** row and handed to the prompt as authoritative
facts, and the model is told not to derive a percentage, share, ratio or total
of its own. That also closes a quieter gap: the prompt sends only the first 30
rows, so on a longer result the model was generalising from a sample while the
card spoke about the whole.

The computed facts refuse to state what would be meaningless rather than
guessing: no shares for a column that can go negative (a "share" of profit
where one row is a loss), none when a category repeats (the rows are not a
breakdown), and no total for a column of timestamps or years — `2023 + 2024 =
4047` is not a fact about anything.

#### R18 · S2 · The ontology's AI step had the deadline of a one-line SQL call

Building an Ontology widget over the built-in lakehouse — 21 tables, default
model — returned:

> AI enrichment unavailable (openai/gpt-4o-mini did not finish within 60s. Try
> again, or pick a different model.) — showing the detected structure with
> heuristic labels.

…and a map of the data estate showing 21 entities and **0 relationships**,
which is not a map. The product disclosed the failure clearly and degraded
honestly, which is why this is S2 and not S1.

The cause is in `llmDeadline.ts`, and that file's own comment names the trap:
the deadline is `floor + maxTokens × msPerToken`, so a call naming no
completion cap lands on the 60-second floor meant for a one-line SQL step.
`enrichOntology` named none — and it is the largest generation in the product,
a record for every entity plus a typed triple for every relation.

The cap is now sized from the shape of the reply the prompt asks for, which
fixes both halves at once: the reply can no longer be truncated, and the
deadline grows with the estate (21 tables: 60s → 87s; a 73-entity estate:
150s). Mutation testing caught that the first version of this test would have
passed with the budget deleted from the call — it exercised the function and
never the one line that puts it on the request.

#### R18 · S3 · The AI writes a title it does not make the data keep

Two instances on one generated dashboard:

- **"Top 5 Products by Sales"** renders 14 bars. Its SQL is
  `SELECT "Product", SUM("Sales") AS total_sales FROM saas_sales GROUP BY
"Product" ORDER BY total_sales DESC` — no `LIMIT`. The SQL prompt does say
  "use LIMIT only when the question itself asks for a top-N"; the question did,
  and the model omitted it.
- **"Top 10 Customers by Sales"** renders 12, because the bar-race component
  takes `topN = 12` and nothing plumbs the requested N through to it.

Left as found. Both are a title and a dataset disagreeing, and reconciling them
is a product decision — rewrite the model's SQL, retitle the widget, or badge
the mismatch — not a defect with one obvious repair.

#### R18 · S3 · Neither AI generator could be pointed at the lakehouse

"Generate Entire Dashboard" offered a local table or a governed semantic model;
the report planner offered `ctx.datasets` alone. Neither listed a warehouse or
lakehouse table, though the manual chart builder reaches both and the
dashboards under test query `analytics.bi_demo_sales` directly. The two dialogs
were the only place in BI that could not see the lakehouse.

It was a gap in the dialogs, not the platform, and nothing new had to be built
to close it: the builder has always offered warehouses, `runBiTurn` already
accepts an `execute` override and a `dialect`, and `widgetFromBiTurn` already
stores whichever source it is handed. Only the dialogs never asked.

Both now resolve their source through one shared, pure function rather than
each remembering the rules. The rules are where the risk is, and they are not
about SQL:

- **Semantic entries and saved metrics are keyed to LOCAL dataset ids.**
  Carrying them onto a warehouse table would offer the planner one table's
  metric definitions for another table's columns — `revenue = SUM(amount)`
  defined on a local `saas_sales` silently applied to a lakehouse table that
  also happens to have an `amount`. That is an ungoverned guess wearing a
  governed number's clothes, so a warehouse source carries neither.
- **A missing schema is not an empty warehouse.** "Still loading", "the
  connection is broken", and "this warehouse has no tables" all end in a table
  list with nothing in it, and only one of them is fixed by waiting — so each
  says something different, and the generator refuses rather than asking a
  model to write SQL against columns it was never shown.
- **A connection that disappears must not fall back to local data.** Generating
  a dashboard over the wrong tables and looking like it worked is the worst
  outcome available here, so that path returns no tables and says why.

The generated widget records the connection it queried, so refresh and
drill-through go back to the warehouse rather than hunting for a local table of
the same name.

**And wiring the dialog turned out to be only half of it.** With the dashboard
generator working against the lakehouse, the report planner still showed no
source picker at all — because the report EDITOR is its own route, and it
handed the dialog `warehouses: []`, `whTables: {}`, a no-op `ensureSchema` and
a `runSql` that threw "A report generates from local datasets". The feature was
impossible there regardless of what the dialog did, and every dialog-level test
passed the whole time. Found by opening the report generator and seeing one
dropdown where the dashboard's had two — which is the same lesson as the
catalog `fqn` in R17: a change is not finished at the component that displays
it. That route now loads connections, fetches schemas lazily, and runs a
report block's SQL at `widgetRowCap()` rather than the workbench's 50-row
preview cap, because a table somebody checks a row of must not quietly stop at
fifty.

#### Verified on the rebuilt image, not just in the tests

Every fix was checked back on the same widgets that produced the finding.

**The maps.** The two widgets that read "10 rows not matched to a country" now
read **"3 rows not matched"**. The lakehouse says why, exactly: `SELECT
country, count(*) FROM analytics.recon_union GROUP BY 1` returns twelve groups
— `BR 35, DE 35, ES 35, FR 38, GB 32, IN 41, JP 33, US 46`, plus `?? 1`,
`U S 2`, `XX 2` and 9 nulls. All **eight real countries now draw, `GB` among
them**, and the three that remain unmatched are the sample's deliberate dirt.
They should stay unmatched: guessing that `U S` means the United States is how
a map ends up quietly wrong instead of visibly incomplete.

**The axes.** The saved report and both time charts on the AI-generated
dashboard render `2022-05 … 2025-12` on AUTO, with no user action and no epoch
anywhere on either page.

**The report table.** `410,379.26`, `340,935.42`, `330,007.05` — the same text
`buildReportPdfBytes` puts on the page. `410379.26499999943` appears nowhere.

**The insight card.** Pressed again on the same widget, so both cards now sit
on the dashboard for comparison. Before: 48% / 39% / 19%, summing to 106%.
After: **45.4% / 36.5% / 18.1%, summing to 100.0%** — and it now states the
total it divided by ($2.3M) and the exact figures ($837.9k, $415.5k) instead of
rounded ones, because it is quoting computed facts rather than doing the
arithmetic. The shares reconcile against the true total of $2,297,201.86.

**The ontology.** Rebuilt from the same button that had failed: **76 entities,
55 relationships, 5 sources, badged "AI-built"** rather than the heuristic
fallback — and that is a job three times the size of the 21-table one that
died at 60 seconds. The relations carry real predicates (`derived_from`,
`defined_in`, `owned_by`, `depends_on`, `on_call_for`, `is_a`,
`interacts_with`), so the map has edges to read.

#### Verified correct, left alone

**The forecast is not a decorative line.** Six projected months against a
series built from `1000 + 25t + 200·sin(2πt/12) + 10·sin(7t)`: 1874.2 / 1997.0
/ 2095.4 / 2148.6 / 2147.7 / 2099.5 against a truth of 1906.24 / 2034.84 /
2131.80 / 2178.14 / 2169.33 / 2116.02 — **MAPE ≈ 1.4%**, the peak at step 4 in
both, and the interval widening 208.5 → 510.6, which is √6 exactly.

**Scan for insights** says on the tin that it is "computed from the snapshots
already on this dashboard — no model call, no cost, same answer every time",
and it is: it found the 2025-11 outlier at 3.1 MAD from the median, and it
listed the four widgets it could NOT sweep with a reason for each ("the
snapshot hit its row cap, so any total or share would be computed from part of
the data"). A feature that discloses its own blind spots.

**The AI's numbers are right even where its prose is not.** Total Sales 2.30M
and Total Profit 286.4k on the generated dashboard match the analyst's
independent `SELECT SUM(Sales), SUM(Profit)`, and the 14-row product breakdown
sums to 2,297,201.86 — the same total by a third route.

The Matrix pivot was checked cell by cell against the seeded series; the
paginated report's running header, footer, `{{page}} of {{pages}}` tokens and
cross-page table header all behave; and a section that fails to build is
disclosed (one of four failed once in three runs, with the reason named).

**Tests:** 51 across `biGeoMapCodes` (11), `biAutoDateGrain` (14),
`biReportCell` (11), `biInsightFacts` (10) and `biOntologyBudget` (8) — all
mutation-verified, 18 behaviour-changing mutants applied one at a time and each
killed, with two misses recorded and justified (a control, and the renderer's
one-line call site, which the live check covers instead).

### 2026-09-18 — A bundled sample, run end to end

One run of the shipped **Orders ↔ payments reconciliation** pipeline. The ETL
half was right to the row — 309 joined, 257 matched, 52 exceptions, every
number equal to a reference computed independently beforehand. Everything
below is about what happened to those 52 rows _after_ they landed, and it is
one assumption wearing five faces: **dlt gzips text output.**

#### R17 · S1 · The catalog globbed a filename nothing has

The crawler stored each folder-dataset as `${dir}/*.${logical format}`. The
logical format of `1789716749.8566182.2f2a328a13.jsonl.gz` is "ndjson", so the
asset was recorded as `finance/recon_exceptions/*.ndjson` — a pattern that
matches nothing in its own folder.

That string is not a label. It is the catalog's join key: the Workbench reads
the bucket through it, an ETL catalog-asset source resolves to it, the lakehouse
mount parses it, and `catalog_lineage.downstream_fqn` is matched against it.
Pressing the catalog's own **Query data** button on the catalog's own asset
returned

```
IO Error: No files found that match the pattern
"s3://etl/finance/recon_exceptions/*.ndjson"
```

Every jsonl or csv target this product has ever written was in this state. The
one bundled sample that reads a bucket back would have hit it too.

#### R17 · S2 · A row count measured in compressed bytes

`estimateRows` counted newlines in the sampled Buffer and scaled by
bytes-per-line. For a `.gz` object those bytes are gzip, so it counted whatever
0x0A fell out of the compressed stream: the 52-row exception report was
cataloged as **10 rows**, and 10 is exactly the sort of number nobody
questions. `inferColumns` a few lines above decompresses; only the counter did
not. It now decompresses first, and when the sample covered the whole object it
returns a count rather than an estimate.

#### R17 · S1 · The object-storage source could not read the target's output

`fs.open(k, 'rb')` hands pandas raw gzip:
`UnicodeDecodeError: 'utf-8' codec can't decode byte 0x8b`. Since this
product's own target is what writes the `.gz`, "pipeline B reads what pipeline
A wrote" — the medallion pattern — was impossible for csv and jsonl.
Reproduced both ways in the runtime image before and after the one-argument
fix, and that reproduction is the test.

#### R17 · S2 · Fixing the crawler alone would have broken lineage instead

A run REPORTS its target's fqn and lineage joins on that string, so the
compiler had to move with the crawler. What dlt actually names its files was
then **measured** — jsonl `.jsonl.gz`, csv `.csv.gz`, parquet `.parquet`,
against dlt 1.30.0 — rather than assumed, since assuming is what produced R17
in the first place. Spark names its own output differently again
(`part-*.json`, `part-*.snappy.parquet`), so the two engines deliberately
report different globs for one graph.

#### R17 · S2 · And four parsers downstream of the join key

Changing a stored identifier is never a local edit. `lineageKey` keys on the
last two **dot** segments, which for `finance/x/*.jsonl.gz` are "jsonl" and
"gz" — a key every compressed dataset in the bucket would share, so one
table's lineage would render as another's. The lakehouse mount's regex
(`/^(.*)\/\*\.([a-z0-9]+)$/`) simply failed to match and counted the asset as
`skipped`, with no message anywhere. `objectSqlName` — whose own header says
both sides must agree or the seeded query names a table the server cannot
resolve — trimmed one extension and left `*.jsonl`. The fourth came out of
pressing the button rather than reading: the Catalog decides whether to offer
**Query data** with an anchored extension test over the fqn, and `*.jsonl.gz`
ends in `.gz`, so the corrected asset had no button at all — a fix that removes
the feature it was repairing, on exactly the assets this product writes most
often. Each is pinned.

#### R17 · S1 · And none of it reached the pipeline that found it

The fixes were deployed, the image rebuilt, the catalog re-crawled — and
re-running `recon_live2` still wrote the OLD target fqn, leaving its lineage
edge pointing at a filename that does not exist while the asset beside it was
right. Pressing **Save** to recompile did nothing: the button is disabled when
the graph has not changed.

The generated program is a CACHE of the graph, and the run executed the cache.
Every visual pipeline on an upgraded deployment keeps running the previous
release's program until somebody edits it for some unrelated reason — with the
runs still succeeding, so nothing points at it. The same sitting had already
paid for this once without noticing: the SQL step's move off ibis did not reach
a pipeline created before that rebuild either, and its stored REQUIREMENTS went
on asking pip for `ibis-framework`, so even a correct program would have run in
the wrong environment.

A visual pipeline's graph is now recompiled at run start, for the engine the
run uses, and its packages derived from the same graph. A graph the current
compiler refuses stops the run with the compiler's own sentence. A code
pipeline — where the source is what somebody typed — is untouched.

#### R17 · S2 · A node nobody finished configuring failed in a library's words

Building the platform-dataset case, the "Choose a dataset" select was never
opened. The graph **saved**. The run **started**. It died inside the sandbox
with

```
requests.exceptions.HTTPError: 404 Client Error: for url:
http://agentswarms:8080/api/notebook/runtime/source
```

— the app's own internal API, named as though it were the problem, with nothing
tying it back to the node or the field. The reader's next move is to go and
look at the runtime.

Targets have said the right thing for as long as they have gone through the
identifier check ("Lakehouse table must be a valid identifier … got ''") and
the bucket check ("Node “Reconciled” has no bucket selected"). Sources and
transforms got it only where a field happened to pass through one of those; the
rest reached pandas, requests or DuckDB first and failed in whichever library
got there. `df.query('')` is "expr cannot be an empty string"; `groupby([])` is
"No group keys passed!"; a join with no right keys is "len(right_on) must equal
len(left_on)". None of them names one of ten nodes on a canvas.

Every required field is now refused at compile with a sentence naming the node.
Fields whose emptiness MEANS something are deliberately left alone — a rename
with no pairs is a no-op, a dedupe or a fill with no columns means every column
— and that line is pinned in both directions: the mutation run includes an
OVER-strict mutant (refusing a rename with no pairs) and the suite catches that
too.

#### R17 · S2 · The proxy refuses ports, and it looks like the endpoint refusing

A reverse-ETL target pointed at `http://echo-target.local:8099/hook`. The host
was on the allow-list, `allowed_domains` carried `.echo-target.local`, the
pre-flight passed — and the run failed with `403 Client Error: Forbidden for
url: http://echo-target.local:8099/hook`. It was squid: `http_access deny
!Safe_ports`, where Safe_ports is 80, 443, 9000 and 19000. The same pipeline
succeeded first try once the receiver moved to port 80.

The allow-list covers HOSTS. Nothing in the product covered ports, so the one
rule that could refuse a fully-configured node was invisible until it fired, in
a library's words, from inside a container — and the SaaS target's 403 hint
("this looks like the egress proxy…") would have pointed at the allow-list,
which was already right. The pre-flight now names the node, the port and the
allowed set, and gives HTTPS-on-a-non-443-port its own sentence since
`http_access deny CONNECT !SSL_ports` is a separate denial with the same
symptom. The app's port list is parsed out of the tracked squid.conf by a test,
mutation-checked in BOTH directions, so a change to either side fails.

**Tests:** 21 in `tests/unit/catalogGzipDataset.test.ts`, 30 in
`tests/unit/etlUnfinishedNode.test.ts`, 7 in
`tests/unit/etlRunRecompiles.test.ts`, 6 in `tests/unit/etlEgressPort.test.ts`.
Twenty-five guards mutation-checked one at a time, every reversion caught, with
a control mutant correctly missed in each set. The mount's regex and the Catalog's "Query data" test are pulled out of
the source and executed, so they are checked by behaviour rather than
spelling.

### 2026-09-17 — Lakehouse, ETL and ML, driven after the fixes

Not a module pass: the round that verifies four fixes in the browser, and what
verifying them turned up. Three of the five below are findings the UI produced
and no amount of reading would have; the last two came from reading the emitter
and the scheduler in the same sitting, and are logged here because they are the
same kind of defect — a control that offers something the code then quietly
turns into something else.

#### R16 · S1 · A comment stripper was written, tested, and never wired in

The fix for lakehouse write authorization needed a stripper that knows what a
string literal is, so one was written (`sqlRefs.ts`, `stripComments`) and used
by the new code. `stripSqlComments` — the one every statement actually goes
through before it executes — kept its two regexes, which do not. The commit
message asserted the opposite.

Typing `SELECT 'A--B'` into the editor returned **"unterminated quoted string"**:
the stripper had cut the statement at the `--` inside the quotes. Worse and
quieter, `SELECT '/*' AS a, '*/' AS b` returned **one column and no error** —
everything between the two literals had been blanked as a comment.

Fixed by delegating (`64e34dd`), with a test that asserts the WIRING rather
than the behaviour of the good function, because the behaviour was already
tested and already passing while the product did the wrong thing. Verified on
the rebuilt image: three columns, `A--B`, `/*`, `*/`.

#### R16 · S1 · The warm scorer is in a different image, and says nothing when it is stale

The decision-threshold fix (`837180d`) has two halves: the app sends the
version's threshold with each warm request, and the scorer applies it. The
scorer is `docker/notebook-runtime/score_server.py`, baked into
`agentswarms/notebook-runtime` — not the app image. A rebuild that named one
service (`docker compose up -d --build agentswarms`) left the old
`def score(rows)` in place, and the warm endpoint went on answering by argmax
while the app dutifully sent a field nobody read. No error, no warning, no
version skew check: the extra JSON key is simply ignored.

The documented upgrade (`docker compose up -d --build`, no service name)
rebuilds both, so this bites a partial rebuild rather than a real install.
docs/DEPLOYMENT.md now says so in the Upgrades section, because the symptom is
invisible in exactly this way.

#### R16 · S2 · "Pipeline has no code to run", on a pipeline the canvas had just explained

A visual pipeline saves even when its graph does not compile — a draft may be
half-wired — and the save toast carries the compiler's real sentence. Four
seconds later the toast is gone. Pressing Run then answered "Pipeline has no
code to run": true, because the graph never compiled and `source_code` is
empty, and useless, because it reads like the pipeline is empty and points at a
code tab a visual pipeline does not have. Found with the refusal still on
screen above the button that gave the wrong reason for it.

`startEtlRun` now recompiles the stored graph and returns what the editor said.

#### R16 · S3 · A quality gate that aborted the run recorded that it had dropped rows

The severity dropdown offered "Drop bad rows" for every check. For
`row_count_min` there is nothing to drop, and both emitters raised — correct —
while appending `severity: 'drop'` to the run's `_quality` metric. The record
of the gate that stopped the run said it had filtered it. The editor no longer
offers the option for that check, and both emitters record what they did.

#### R16 · S2 · Promote-when-better chose the noisier anomaly detector

`ML_PRIMARY_METRIC.anomaly = 'anomaly_rate'`, and `anomaly_rate` is not in
`ML_LOWER_IS_BETTER`, so `beatsProduction` read "better" as "flags MORE rows".
A nightly retrain with promote-if-better on installed whichever version was
noisiest, and told the owner it was better. The trainer disagreed in its own
output — the leaderboard row it writes carries `higher_is_better: False` — so
the two halves of the product had contradicted each other since the metric was
chosen.

Flipping the direction is not the fix: a detector that flags nothing would then
always win. The rate describes the fit rather than scoring it, so it now
decides nothing — production is kept and the notification says why.

#### R16 · S2 · "Explain this answer" on a recommender returned no answer and no explanation

Ticked on `revenue_facts · recommendations`, one row, through the UI. The
prediction succeeded and the stored row says exactly what happened:

```
input:   {"kind": "rows", "count": 1, "explain": true}
result:  {"columns": [...], "explanations": null,
          "warnings": ["1 user(s) had no history; they received the most popular items."]}
```

`explanations: null`, and the only warning is about cold start. The
recommendation branch of `_predict` returns before BOTH explain blocks, so the
flag was carried all the way from the checkbox into the stored request and then
dropped without a word.

The ablation those blocks perform replaces one feature value with a typical one
and asks the model again. A recommender's answer comes from which items other
users chose together, not from this row's columns, so there is nothing to
replace — the honest answer is "not for this kind of model", which is now what
both halves say: the two controls are not rendered for that task, and the
program appends a warning for every other caller (the API, the agent tool, a
scheduled batch) that asks anyway.

#### R16 · S1 · The trainer program was never compiled as Python by the suite

Found by making the mistake. The warning above was first written with an
apostrophe inside a single-quoted Python literal, in a 2,000-line module
carried as a TypeScript `String.raw` template. TypeScript was happy. Python
would have died at import, inside a sandbox, on a line number that maps to
nothing anybody edited.

Twenty-odd test files assert things about that module by searching the string
for substrings, which cannot catch it — the substring is present either way.
`tests/unit/mlTrainProgramParses.test.ts` now compiles the whole module with
the real interpreter, and scans it for control characters (a `\b` written in a
shell heredoc arrives as a literal BACKSPACE and compiles). Mutation check: the
unbalanced quote fails it with `SyntaxError: unterminated string literal`.

The same round also put a backtick inside that `String.raw` template while
writing a comment, which ends the template and breaks the TypeScript — caught
immediately, by the new test file failing to transform.

#### R16 · S3 · And the fix above turned a checkbox into a no-op

Refusing to judge an anomaly promotion leaves the schedule dialog offering
"Promote the new version when its primary metric beats production" for a model
where nothing can beat anything. Ticking it would have written
`promote_if_better: true` and then never fired — one silent wrong answer traded
for a silent nothing. The box is disabled for that task, the reason replaces
the label, and the save writes `false`.

Worth naming as a pattern: a refusal added in the engine is only half a fix
while the control that asks for it still looks available.

**Tests:** `tests/unit/lakehouseSqlRefs.test.ts` and
`tests/unit/lakehouseWriteAuthz.test.ts` (the stripper wiring),
`tests/unit/etlRunRefusalReason.test.ts`, the two gate cases in
`tests/unit/etlPipelines.test.ts`, the anomaly cases in
`tests/unit/mlOps.test.ts`, the recommender case in
`tests/unit/mlExplanations.test.ts`, and the whole of
`tests/unit/mlTrainProgramParses.test.ts`. Every one mutation-verified: removing the fix fails
it, rewording the comment beside it does not.

**Fixtures kept**, all listed in [UI test results](./UI_TEST_RESULTS.md).

---

### 2026-09-14 — Module 3 revisited, Agent Builder (`/agents`): the ML Predictions picker

Found by the UI round of a feature being shipped — a model picker for the ML
Predictions tool — not by a suite. The pass is the usual one: press the button,
then read the row.

#### R1 · S1 · Clearing an allow-list saved the old list back

The save-time `toolConfigs` was assembled as
`{ ...toolConfigs, ...sqlSpread, ...metricSpread, ...mlSpread }`. The SQL and
semantic spreads each dropped their own key by returning `rest` — the whole
config minus that key — so a later spread re-added what an earlier one had
removed, and the base spread of the unpruned state put back whatever the last
spread merely left out.

Measured on "Demo · Friendly Assistant" (`sql_query` limited to `saas_sales`):
untick `saas_sales`, watch the panel read "No selection — the agent can query
every table you can read", save, see "Agent updated". The row:
`sql_query: {"table_names":["saas_sales"]}`. The form said every table; the
agent still had one. Then the same on the new picker: "Allow every model again"
rendered the allow-all state and the save wrote
`ml_predict: {"model_names":["revenue_facts plan classifier"]}` back.

Not a wrong number — a setting that reports one state and persists another.
The persisted state is the narrower one, so it fails closed, which is how it
survived: nothing got wider, and reopening the form showed the restriction
still there, which reads as "I must not have saved".

Fixed in `AgentForm.tsx`: every allow-list key is stripped from the state
first and written back only when it should exist. Verified on the rebuilt image
against the rows: SQL cleared → key absent; ML reset → key absent; restricted →
exactly the one name; untouched → byte-for-byte the before snapshot.

**Tests:** `tests/unit/mlAgentPicker.test.ts` — three guards on the save path,
mutation-verified 6/6 (base spread re-added, key left in the remainder, length
gate on the ML write, a second write, an always-true SQL condition, a re-add
inside the metric branch).

#### R2 · S2 · The model said "verbatim" and had not called the tool

Not a code defect, and logged because it nearly passed as verification. Asked
to call `ml_predict` with a model outside its list and paste the raw response,
the Playground agent answered "The call failed as expected. Here is the tool's
raw response, verbatim:" followed by an error text that exists nowhere in the
codebase. The message row's metadata had no tool source for that turn; the
turn before it — a real `ml_list_models` call — did. A prompt that insisted on
the actual invocation came back with the server's own string,
`"revenue_facts model" is not enabled for this agent. Call ml_list_models for
the models it may use.` — which the model could not have produced otherwise.

The rule this adds to the method: a transcript is not evidence that a tool
ran. The row's `sources`, the audit trail, or a string only the server could
have produced is.

It recurred twice the same day, on the predict-by-key round: a "verbatim"
scoring result with version 1 (the model is at 7), one probability repeated
three times and a nonexistent key reported as found, answered in four seconds
with no `ml_predictions` row; then two error objects in a `{code, message}`
shape the code has never produced. The evidence path that works for error
returns — which `sources` drops by design — is a canvas run: the client
tracer records every `tool_call` and `tool_result` on the step, so the
refusal strings can be read from `swarm_run_steps.tool_calls` verbatim.

#### R15 · S2 · One collection can choose its own index — and the four instance-wide questions that stopped being the right question

The vector store was one switch for the whole deployment: `VECTOR_STORE`
decided where every collection was searched. Asked why there were two stores at
all, the honest answer was that the choice belongs to a collection, not to a
deployment — one collection outgrows Postgres, the rest never will. So the
choice moved into **RAG Settings → Retrieval → Vector index**.

What made this worth doing carefully is the failure mode. Vectors written to
one index and searched in another produce **no error and no empty state**. The
agent simply stops citing that collection, and every page still says it is
indexed. Nothing in the product would have reported it.

Four places had already answered the question instance-wide, and each was wrong
for a collection that differs from its instance:

- **Ingest** exited on `usesExternalStore()` before doing anything. A
  collection on Qdrant, on a deployment defaulting to Postgres, would have been
  indexed nowhere — the write skipped, the search finding an empty index.
- **Deleting** a document or a collection cleared the external store only when
  the INSTANCE used one, so vectors could outlive the rows that authorised
  them.
- **Re-index** skipped whole instances for the same reason, leaving the one
  repair operation unable to reach the collections most likely to need it.
- **The mode pin** in `resolveRetrievalSettings` rebuilt the settings object for
  `semantic` and `keyword`, and would have dropped the store with it: switching
  a Qdrant collection to keyword search would have silently moved it back to
  Postgres. Caught by a mutant, not by reading.

The resolution now runs through two functions that ingest, retrieval, cleanup
and rebuild all call, because the property that matters is not which store is
right — it is that all four agree.

**Changing the choice moves the data.** Saving copies the collection's existing
vectors into the new index, then saves the setting, then clears the old one.
Nothing is re-embedded: the embeddings are a column on `kb_chunks`, so a move
costs no model calls. The order is the guarantee — saving first and failing the
copy leaves a collection pointed at an empty index, while failing this way
leaves a copy in two stores, which costs disk and answers correctly.

**Proved live**, against this machine's real Supabase and the running Qdrant,
with `VECTOR_STORE` unset so the instance default was Postgres — the exact case
the old guards got wrong. A collection that chose Qdrant resolved to Qdrant
while its neighbour resolved to Postgres; its vectors, once copied, came back
from Qdrant at similarity 1.0 in the planted order; the same collection still
answered from Postgres, which is what makes the move reversible; a search
naming a different collection returned nothing; and clearing Qdrant left the
Postgres copy intact. Every row and vector was removed afterwards.

The first run of that file reported **five green ticks and proved nothing** —
the fixture had not been built, and each test began with an early return that
passes. The reason was mundane: the shipped sample collections have a null
owner, so borrowing "the first knowledge base" borrowed nobody. The file now
fails when `QDRANT_URL` is set and the fixture did not build, which is the only
reason it was ever noticed.

**Then driven through the browser**, once the owner signed in to a build of the
commit served beside the running instance. The 100-chunk RAG eval collection was
moved to Qdrant and back through the control itself, and the two directions
prove different halves of the design:

- Saving Qdrant reported "100 vector(s) moved into qdrant"; Qdrant went from 4
  points to 104, exactly 100 of them this collection's, and a search with a
  stored chunk's own vector returned that chunk at 1.0000. The dialog reopened
  on Qdrant rather than the default.
- The agent then answered a multi-hop question from that collection — the
  firmware a controller needs to roll a node back (5.2) and the condition that
  declares a partition (45 seconds on 3 or more links) — with citations, and a
  version-conflict question (768 nodes, noting the older document says 512 and
  why it is superseded).
- **Qdrant's own request counter is what proves the routing.** It rose by one
  per question while the collection was on Qdrant, and did not move at all for
  a question asked after the switch back, which still answered correctly and
  cited the right document. Postgres kept every vector, which is what makes the
  return trip free.
- Switching back reported a plain save with no move, cleared this collection's
  100 points from Qdrant while leaving the other collection's 4 alone, and wrote
  both directions to the audit trail.

The collection was then restored to the settings it had before any of this.

#### R14 · S1 · Every service, every install — and the four things only running it found

Compose put seven services behind profiles, so `docker compose up -d --build`
started the app alone; `--all` was documented and not the default; the
Kubernetes installer left the notebook runtime and the Spark namespace to a
later `kubectl apply`; and several services that did start were never wired —
Qdrant idle until .env said `VECTOR_STORE`, Valkey until `FEATURE_STORE_URL`,
Spark until `SPARK_CONNECT_URL`, the lakehouse catalog until it was named and
given an object store that nothing shipped. The change is in the commits; what
belongs here is what running it found, none of which a test that reads files
could have said.

- **F1 (S1)** MinIO's Docker Hub repository is not publicly pullable.
  `docker pull minio/minio` is "pull access denied … or may require 'docker
  login'" on a daemon that pulls `alpine` in the same second, so every install
  would have failed on the image. Both images come from quay.io now, where
  MinIO publishes.
- **F2 (S2)** The bucket step ran `mc alias set` through a folded YAML scalar.
  YAML turned the line continuations into spaces, mc read the access key as a
  command — "agentswarms: command not found" — and created nothing, while the
  line above it said "Added `lake` successfully". It uses `MC_HOST_lake`, mc's
  own credential form, and a command array: no shell, nothing to fold.
- **F3 (S2)** The object store's health check allowed 20 seconds plus five
  retries. A fresh install starts eleven containers while several images are
  still building, and MinIO formats its pool on first start: under that load it
  missed the window, the bucket step refused to run ("dependency failed to
  start: container minio is unhealthy") and the install ended with no bucket
  and no error anyone would connect to the cause. Idle it is ready in about 30
  seconds — which is why every measurement on a quiet machine passed. 60
  seconds plus twenty retries now.
- **F4 (S3)** `docker-compose.yml` named the egress proxy's container as a
  literal while the app resolves it from `NOTEBOOK_EGRESS_CONTAINER`: the same
  name by coincidence, and two instances on one host collided on it. Compose
  reads the same variable now, so one setting moves both.

Then CI, on the first push: `docker compose config` failed with "yaml: control
characters are not allowed". Two comment lines carried U+0080 U+0094 — an
em-dash that went through a bad decode in an editing script. Windows' compose
accepts those characters and Linux's does not, so every local run passed and
the first Linux run did not. Repaired, and `check-infra` now scans every
tracked text file for U+007F–U+009F, which needs no Docker and so catches it
where it is written.

**Proved on a clone of the commit**, installed from scratch beside the running
stack with its published ports remapped: `bash scripts/setup.sh` brought up 11
services in 444 s, `/api/health` answered 200 five seconds later, the bucket
was created, the catalog password was generated into both halves that must
carry it, and .env arrived wired (VECTOR_STORE, QDRANT_URL, FEATURE_STORE_URL,
SPARK_CONNECT_URL and the four lakehouse values). From inside the app
container: qdrant, minio, docgen, the notebook gateway and the JS sandbox all
answered 200, and valkey's port was open. Two refused at that moment and both
were first-run timing, verified afterwards rather than assumed: the catalog was
still running Postgres' first-boot init and accepts connections once it
finishes, and Spark Connect was still downloading its connector jars — on a
stack whose ivy volume already has them, the port is open.

Recorded, not changed: the app image takes about 55 minutes to unpack on this
machine, nearly all of it in the exporter, so a first install is a long wait
rather than a hang; and the daemon holds a container it cannot kill ("PID is
zombie and can not be killed"), a host condition that cost one attempt at this
proof — it stopped the running stack, hit that container, and left the app down
until it was brought back up.

#### R13 · S2 · The installers, the compose file and the manifests, checked for the first time

Every installation and deployment asset, verified rather than read: the
three shell installers and the PowerShell one, the backup and restore
scripts, the five Dockerfiles, the compose file with and without every
profile, the four Kubernetes manifests, the runtime verifier and the
hardening suite, and the commands the handbook tells an operator to type.
Static where a cluster is not needed, live against the running stack where
it is. `docs/UI_TEST_RESULTS.md` has the table.

- **F1 (S2)** Not one of the six tracked shell scripts was executable:
  100644 in git for `setup.sh`, `setup-selfhosted.sh`, `setup-k8s.sh`, the
  two runtime test scripts and the notebook image's entrypoint. The in-app
  install page said `./scripts/setup.sh --all`, which on a fresh Linux or
  macOS clone is "Permission denied" (every Markdown doc said `bash
scripts/setup.sh`, which works either way; the Dockerfile chmods the
  entrypoint, so images were never affected). Modes fixed, the page reads
  like the rest, and the check pins the mode.
- **F2 (S3)** `setup.sh --help` printed a usage block that had lost the
  seventh profile — `--featurestore` worked, the help did not know it — and
  both installers' comments said "the same six profiles" of seven. The
  check now derives the count from the compose file and demands each
  profile in both installers' flags, in `--all`, and in the help.
- **F3 (S2)** `verify-runtime.sh` tier 4 ("the kernel reaches the platform")
  pointed its test kernel at `host.docker.internal` whenever the app URL
  was localhost — including when the app runs in compose, where the kernel
  sits on an `internal` network with no route to the host. A healthy
  install reported "All connection attempts failed"; 15 of 16 checks
  passed and the one that failed was the verifier. It now mirrors
  `internalAppUrl()`: the service name inside compose, the host gateway for
  a host-run app, `NOTEBOOK_APP_INTERNAL_URL` when set.
- **F4 (S3)** `docker build --check` warned about the publishable Supabase
  key in ENV in the app image. It is the anon key, shipped in every browser
  bundle by design; the directive skips the rule with that reasoning, and
  the other four Dockerfiles were clean already.
- **The gap behind all four:** nothing ran any of this. CI built the app and
  ran the unit tests; `check:doc-commands` existed and ran nowhere. Both
  checks are in `npm run check` and in CI now.

Verified working, no change needed: the compose file renders with and
without every profile; 47 Kubernetes documents with consistent selectors,
images and secret references (the notebooks namespace's LimitRange fills
the requests two Deployments omit); 73 documents' commands resolve; 83
routes load without a server error; a real backup (the catalog dump, 79
lake objects, all 25 catalog-referenced files present) and the documented
restore drill (scratch database restored to snapshot 460 and dropped, 25
objects re-uploaded and verified, prefix removed); the self-hosted
installer's ordering (wait for auth, then for the storage schema, then the
five extensions, then the push, then the admin user, then the app).

#### R12 · S1 · A knowledge-base answer read one chunk, cut in half: the RAG evaluation

A session on Agent Chat with a knowledge base built to be hard: twelve
documents about a fictional vendor — a current and an archived SLA that
disagree on every number, a pricing guide whose discount and support rules
sit in different tables, a runbook, a regional matrix whose Mumbai date is
contradicted by a newer report with the correction buried in the middle of
3,800 words of filler, release notes that raise a limit the product overview
still states, a glossary, a partner FAQ — and twenty questions with an answer
key: current-version, version-diff, multi-step arithmetic, an exception,
multi-hop, a recency conflict, a buried fact, an absent product, an
aggregation, an acronym across documents, a capped credit, an exclusion,
another domain, a follow-up that depends on the previous turn. One agent on
`openai/gpt-5.2`, the knowledge base alone. Every answer read from the
stream, two of them typed into the real chat and read back from the DOM and
from `messages.metadata.sources`. `docs/UI_TEST_RESULTS.md` has the tables.

- **F1 (S1)** Eleven of twenty right, and the model was honest every time it
  was wrong: "the retrieved excerpt does not include the response-time
  table". It did not. Citations were one chunk per document — the
  best-scoring one — cut to 560 characters. On the SLA the paragraph that
  merely talks about response times outranked the table that holds them
  (both are in the same document), the collapse kept the paragraph, and
  even the document whose first chunk won was shown with its second half
  missing: the runbook's RTO sits past character 560 of chunk 0. A citation
  now carries a document's best three chunks in reading order, each whole
  (1,600 characters), under a 12,000-character budget per turn; all three
  are settings (`KB_CHUNKS_PER_DOCUMENT`, `KB_CITATION_CHARS_PER_CHUNK`,
  `KB_GROUNDING_MAX_CHARS`). Same questions, same model: twenty of twenty,
  the grounding 2,400 prompt tokens a turn instead of 700, and the answers
  faster (6.5 s against 9.8 s) because the model no longer reasons about
  what it was not given. The recency conflict (512 or 768 nodes) is
  answered with both figures and the condition; the credit is capped; the
  buried Mumbai date wins over the matrix.
- **F2 (S2)** A collection that never saved retrieval settings searched by
  vectors only, on the argument that an upgrade should change no answers.
  Measured on the same twenty questions: semantic-only lost the exact-term
  ones — "Severity 1", "RTO", "HIPAA" — to look-alike paragraphs, and the
  keyword pass rescued each one it was allowed to run on ("What is the
  Severity 1 response time for Gold support" ranks the two SLA tables first
  and second by keyword and neither by vector). Hybrid, weighted 0.7 toward
  meaning, is the default for the undecided; a saved `semantic` is kept.
- **F3 (S3)** Adjacent chunks are cut with an overlap so no sentence is lost
  at a boundary; joined back to back the overlap read twice ("## Do not
  affic forwarding across the whole fabric … ## Do not Never restart"). The
  second chunk now starts where the first ended (`overlapLength`).

Measured and recorded rather than changed:

- **Tool bloat.** The same agent with thirteen built-in tools enabled (web
  search and browse, graph search, SQL, metrics, data health, ML, calculator,
  date, weather, n8n, MCP, notifications): still twenty of twenty, never the
  wrong tool — the routing guidance holds — but 10,400 prompt tokens a turn
  against 2,400, because every tool's schema rides on every request. The
  credit question went round the calculator three times for arithmetic the
  model had already done in prose: 37,000 tokens and 18 s for an answer the
  bare agent gave in 8.8 s. The four tool-shaped questions (weather, date,
  local tables, a product) each called the right tool once. Prompt caching
  reported zero cached tokens on every request. The handbook's "three tools
  is a good number; eight is not" now carries these figures. Measured per
  tool afterwards (each enabled alone, same question, prompt tokens over the
  bare request): `sql_query` 5,240, `ml_predict` 701, `kb_graph_search` 508,
  `data_health` 264, `weather` 185, `web_browse` 185, `calculator` 162,
  `datetime` 154; n8n, MCP and notifications cost nothing until something
  is connected. The SQL tool's description carried fifteen tables with
  every column — 17,000 characters — so it now has a budget
  (`SQL_TOOL_SCHEMA_MAX_CHARS`, 4,000): columns until it is spent, names
  after, `list_data_tables` for the rest. Two things the per-tool round also
  showed: with web search as the only tool the model searched the web twice
  for a question the grounding answered (adding kb_search beside it, it did
  not), and an explicit `enabledTools` list without `kb_search` switches
  auto-RAG off by design — documented at the gate in chat.ts, easy to trip
  over from the API.
- **Context bloat.** A 24-turn conversation, the page's whole history sent
  each turn: prompt tokens plateaued at 3,200–4,200 (the 20-message window),
  latency stayed 5–13 s, every answer stayed right. The rolling summary is
  folded from persisted rows, so a caller that does not persist its turns
  gets a windowed history with no summary and the model names the wrong
  "first question" with confidence; with the rows persisted the fifth turn
  carried `memory_used {summaryUsed: true}` and the model listed the folded
  questions while saying it could only paraphrase them. A 36,000-character
  question was answered correctly at 10,108 prompt tokens — the query
  embedding did not fail — and the 4,000-character input guardrail is off by
  default. Retrieval ran on every turn, "what is the weather in Frankfurt"
  included: five citations fetched and discarded. Measured afterwards on
  the same collection (text-embedding-3-small): the best chunk of every
  document question scored 0.38–0.75, of every off-topic question 0.10–0.32
  ("how many local data tables" the closest at 0.32), and no off-topic
  question had a keyword hit. A floor (`KB_MIN_SIMILARITY`, 0.3; a keyword
  hit always passes; the tool is never floored) now leaves such a turn
  ungrounded, with the model told the search found nothing.

#### R11 · S2 · The analyst page at a narrow window, and a new analyst with no controls

From the user's screenshot at a small window, reproduced at 1000px: the
analyst rail kept its 256px, the header's six actions never wrapped, so the
page container — which hides overflow so the transcript can scroll inside a
pinned height — held 1173px of content in 744px of room, and focusing the
question box scrolled the rail clean out of view: the analyst list looked
cut off at the left and the actions at the right. The header now wraps, its
labels go icon-only below lg (titles kept), the title input shrinks, the
model badge and the source label are dropped first, the rail narrows below
lg, and on a phone it hides behind a button and comes back full-width,
closing again when an analyst is picked. Verified at 1000, 768 and 375px:
the container's content fits its width at each.

Two smaller ones from the predictive-model round. The analyst just created
showed no owner controls (share, edit, delete) until the page was reloaded:
the insert returned the row without `user_id`, and the card decides
ownership by it. It returns it now. And the "analyst updated" toast sits at
the bottom right, over the Ask button; a pointer resting there keeps it alive
and every click lands on the toast, so three asks went nowhere until the
pointer moved. Left as is — it is the app-wide toast position and a resting
pointer, not a code path — but recorded so the next round does not lose
twenty minutes to it.

#### R10 · S1 · Seven questions to the AI Analyst about seven models: twelve findings

A session rather than a feature: one analyst on `openai/gpt-4o-mini` over the
lakehouse, one question per model kind, every answer read from the DOM and
from `ml_predictions` and the persisted step rather than from the screen.
The full transcript is in `docs/UI_TEST_RESULTS.md`. The findings, by
severity:

- **F1 (S1)** Fifteen scored orders, quoted to the write-up as a summary
  because fifteen is past the twelve-row quote cap: the writer saw
  `order_id total=22104` and three per-class maxima and built its findings
  table out of them — three rows, each with order id 22104. A scored step's
  rows ARE the answer; they are now quoted in full up to the scoring cap.
- **F2 (S2)** The same total made the self-check "correct" a correct query
  ("22104 seems too high for 15 orders"). Identifier columns (`_id`, `_key`,
  `_code`, …) are no longer totalled in the facts; they are named as
  identifiers with a distinct count.
- **F3 (S1)** "Estimate their net_usd with the revenue_facts model" produced
  a step whose goal named the model and whose plan had no score block; it
  was written as SQL over the actual values, the reviewer passed it as
  "accurately estimates … using the model", and the write-up presented a
  table of actual vs "estimated" with identical numbers. A goal that names a
  model in scope is now scored by it; the reviewer is told a step not marked
  as scored did not run the model; the writer is told a step not marked
  SCORED BY holds observed values only.
- **F4 (S3)** The scoring goal's "at most 50 rows" overrode the question's
  own ten, costing a correction round. The goal now says fewer when the goal
  names a number, and one row per DISTINCT entity (F12 — one customer was
  scored thirteen times, once per order).
- **F5 (S2)** Asked what distinguishes each group, the write-up said the
  distinctions "are not provided in the results" — the cluster profiles, the
  class meanings and the trainer's warnings the tool already writes as notes
  were discarded by the analyst's scorer. They now travel with the scored
  step (a collapsible under the disclosure) and into the write-up.
- **F6 (S1)** "Which ten orders look most anomalous": the SQL sampled fifty
  at random (it cannot rank by a score that does not exist yet), the
  reviewer proposed `ORDER BY anomaly_score` and died on a binder error, and
  nothing could rank the scored rows. A plan may now ask for
  `"rank": { "by", "desc", "limit" }` inside `score`; the platform orders
  the scored rows and the disclosure says so. The planner is told each
  model's output columns to rank by.
- **F7 (S2)** The R9 prompt rule ("a correction must not select, filter or
  sort by the model's columns") did not hold with this model. A correction
  that reads a model column is now refused in code, with a note saying what
  it read and that the original result stands.
- **F8 (S2)** Twice, a correction that failed to run was reported by the
  write-up as the STEP having failed ("the SQL query failed to execute
  correctly") over a step that had succeeded and scored fifty rows. The note
  now says the original result stands, and the writer is told a failed or
  refused correction means the step did not fail.
- **F9 (S1)** The two forecast models were invisible to the analyst (they
  take no rows, so they were filtered out of the scorable list); asked what
  monthly net_usd will do over the next three months "using a trained
  forecast model if one fits", the planner scored fifty orders with the
  regression model and the write-up invented "month 1: 480.89, month 2:
  480.89, month 3: 480.89" from their mean. Forecast models are now offered
  as a forecast step — no SQL, the model's projected periods with their
  interval, through the same runner the agent tool uses — the planner is
  told a regression model is not a forecast, and the writer is told never
  to turn per-row estimates into a projection.
- **F10 (S1)** "Score the customers with the churn model" — there is no
  churn model — was answered with the clustering model, silently, as "top
  five at risk". A question naming a model nobody has now stops and asks,
  naming the models that exist.
- **F11 (S2)** That same step scored rows carrying one of the model's seven
  feature columns; the scorer imputed the other six and four of five rows
  came out identical. Rows missing at least half of a model's features are
  refused with the missing columns named; fewer missing are scored and named
  in the notes.
- **F13 (S2)** Found by the re-run: asked the anomaly and the forecast
  questions again on the fixed image, the planner returned `{ "score": {
"model": …, "rank": … } }` and `{ "forecast": { "model": …, "horizon":
3 } }` — the whole plan collapsed into its one interesting block, both
  blocks exactly right — and the analyst said "no analysis steps". A bare
  step-shaped root (or `steps` as one object) is now read as a one-step plan
  whose goal is the question.

- **F14 (S3)** Rows-mode scoring returned the feature columns and nothing
  that named the order, so "the ten most anomalous orders" came back as ten
  unnamed rows. The scoring goal now asks for the entity's identifier beside
  the features.
- **F15 (S3)** The forecaster's period is a week; the question said months;
  the reviewer passed "the next 3 months". It is now told the step's period,
  horizon and last observed period, and to name a mismatch.
- **F16 (S2)** "Go with the assumption" re-asks with the assumption appended,
  and the planner asked the same question again. The planner is now told the
  user has answered, and if it still asks it is asked once more in plainer
  words before a second clarify is honoured. Measured after that: the
  smaller model asked a third time ("Which churn model should I use?") with
  its own assumption, "the churn model is the one defined in the schema" —
  there is none — so a plan that reaches for another model under an
  accepted assumption is now stripped of its scoring and answers from the
  data alone, with the approach saying so. A model that insists on asking is
  shown asking; it can no longer substitute.

- **F17 (S3)** With a rank of ten planned, the SQL writer took "ten" as its
  LIMIT and the ranking ran over ten rows instead of the fifty-row sample.
  The scoring goal now says the platform keeps the top N after scoring, so
  the query must not limit to that number (verified live in the R11 round:
  fifty sampled, the top ten ranked).

Twenty-two mutants, twenty-two caught. The session's analyst and its threads are
kept on the instance for review, and the same seven questions were asked
again on the rebuilt image; the before-and-after is in the UI test results.

#### R9 · S2 · The reviewer "corrected" a column that exists in no table, and a caveat built on arithmetic over an id

Two more, from the health rounds, both in what the self-check is told about
a scored step. A scored step's facts carry the model's columns beside the
SQL's — `order_id | prediction | probability | proba_*` — and nothing said
which was which. The reviewer "corrected" the step with `SELECT order_id,
prediction, probability, proba__unknown_, …` and the rewrite died on
`Binder Error: Referenced column "prediction" not found in FROM clause` —
the model had written that column onto the rows after the query ran. The
original result survived and the step was flagged, so nothing wrong was
shown; but "correction failed" now stood over a correct step.

The second is worse. The contribution detector recognises a two-period
breakdown by shape — a label column and two numeric ones — and read that
same table as a breakdown by `prediction` with `order_id` as the previous
period and `probability` as the current, and computed it. The reviewer
repeated the result as a concern ("a total change of -11,054.852, which is
not consistent with the expected scale of changes based on the order_id
range"), and the write-up listed it under Caveats, beside the real one
about drift. A fabricated caveat is one nobody can act on, and it makes
the true one next to it read as noise.

Now the disclosure records which columns the model added (`columns`, named
as they land on the table, prefixed when they collide); the check's step
block says "SCORED AFTER THE QUERY by <model>: the column(s) prediction,
probability are the model's estimates … they exist in no table"; the
reviewer's rules say a correction returns the same key column(s) and is
scored again on its own; and the facts every prompt reads come through one
helper that keeps the model's columns out of the contribution and series
arithmetic and marks them "(model estimate)" on the columns line. Nine
mutants, nine caught — including the one where the loop simply stops
telling the check which step was scored.

#### R8 · S2 · "Produced no write-up" over a finished analysis, and a rule that never reached the writer

Two more from the same two live rounds. The findings panel said "The
analysis completed but produced no write-up — the step results above stand
on their own", twice, while the ASK NEXT list had three follow-ups from the
same reply. `execution_traces` held the reply: `{ "answer": { "orders": [
{ "order_id": 1000, "predicted_plan": "pro", "probability": 0.9479 }, … ] },
"caveats": [...], "follow_ups": [...] }` — the write-up, as data. The parser
accepted a string under `answer` and nothing else; a perfectly good answer
became "no write-up" because it arrived as a table. It is rendered now — an
array of flat objects as a Markdown table, an object as a list, caveats
appended — and a string answer is untouched.

The second: the planner was told, at length, what a scored step's SQL must
return. The SQL is written in a separate call that sees only the step's
goal, so the rule never reached the writer, and both rounds it reached for
`analytics.revenue_facts_plan_classifier_predictions`, a stored table whose
columns looked like the answer. The goal a scored step hands the writer now
carries the requirement — the model's key column(s), from the source table,
no stored predictions, no prediction of its own — and the test reads the
writer's prompt for it. Prompts are not a chain: what one call is told, the
next is not, unless the text is carried across by hand.

#### R7 · S2 · The model's answer vanished behind the badge that said the model had answered

The first live question to a scored analyst step. The plan asked to score
orders 1000–1010 with the plan classifier; the SQL generator, reading the
lakehouse schema, reached for `analytics.revenue_facts_plan_classifier_predictions`
— a batch-prediction table from an earlier run — so the step's rows already
carried `prediction` and `probability` before the model ran. Scoring ran (an
`ml_predictions` row via `ai_analyst`, four rows, succeeded), and the join
kept the SQL's columns and left the model's out, because it only appended
columns the input did not have. The table showed the stored table's numbers
under a badge saying the model had scored these rows.

Then the self-check narrowed the SQL, and under the first rule a refined step
dropped its predictions and told the reader to "ask again to score them" —
the honest sentence for a governed compile, which cannot be re-run on
hand-written SQL, and the wrong one for scoring, which can simply run again
on whatever the correction returned. Both changed: a colliding prediction
column is kept under a `predicted_` prefix (`joinPredictions`, pure, with the
key-identity join and a null for a key that matched nothing), and a refined
scored step is scored again and says so. Neither was reachable by the unit
test until the live round produced the collision.

#### R6 · S2 · The self-check overwrote what the step had already said about itself

Found by a unit test, not a screen, while giving the AI Analyst a scored
step: a scoring that failed wrote `check = { suspect, "Could not score with
… — the rows below are unscored" }`, and the assertion found `pass` with
"ok". The self-check stage, which runs after every step, assigned its verdict
over whatever `check` held. That was not new to scoring: a governed step
whose compile fails falls back to written SQL and writes "The governed model
could not answer this step … so the SQL below was written by the analyst
instead of compiled" into the same field, before the same check — and had
been losing it to a green **pass** since governed steps shipped. The reader
saw a passed step and no badge, and nothing said a compile had been tried.

Two facts, two authors: how the step was produced (written before the check)
and whether its SQL holds (the check). Both are kept now — a pre-check note
survives as a suspect verdict with the check's own verdict appended, and a
refinement's note is prefixed with it. Pinned by the scoring test; the
governed fallback rides the same line.

#### R5 · S2 · A refused call badged "ok"

Found while giving the Tool Calls panel a prediction table (the panel had
shown every result as its first 400 characters, which for a prediction ends
mid-probability). The ML tools answer an error as JSON rather than throwing —
`{"error": "Send rows or keys, not both."}` — so the loop's `ok` was true, the
panel's badge said **ok** in green, and beneath it the result said the call
had been refused. Two facts on one card, contradicting each other, with the
green one on top. The badge now reads the result: ok only when the call
succeeded and an ML result is not an error. Same round, smaller: a forecast
returns periods, not rows, and the count badge over a table of three weeks
read "0 rows". Both were visible only with the real panel open over a real
call; the parser's tests were green throughout.

R2 recurred a third time here — "8 periods returned (2025-01-01 through
2025-08-01)" with no call behind it; the real call, forced, returned three
weeks starting 2026-04-05.

#### R4 · S3 · An all-miss answer that could never be given

The predict-by-key work gave `ml_predict` its own answer for "no key matched
a row": a structured result with `predictions: []` and every key named in
`keys_not_found`, so an agent would see misses rather than nothing. A guard
pinned it, the docs described it, and the canvas round for the scoring node
ran it — a key of 999999 — and the node failed with the LOOKUP's message:
"No features found for order_id=999999 in order_features". `resolutionError`
already refuses a resolution with no rows, the tool returns that refusal on
the line above the new branch, and the branch was unreachable. Dead code with
a passing test and a paragraph of documentation. Removed; the rule is pinned
where it lives (`resolutionError`: all-miss is an error, a partial miss is
named beside the rows that scored), and the docs say that instead.

What it took to find: not a mutant, not a review — a value that matched no
row, pressed through the real path. The guard was green because it read the
code it was written beside.

#### R3 · S2 · A headless run's steps record no tool calls

Applying R2's rule to the canvas round exposed a gap in the server executor.
The same swarm, the same node, the same input, run twice: from the canvas, the
`research` step in `swarm_run_steps` carries
`tool_calls: [{name: "ml_list_models", type: "tool_call"}, {type: "tool_result",
ok: true, preview: …}]`. From a schedule — the server executor — the step
carries `tool_calls: []`, with the same one-model output. The server tracer
(`observability/serverTracer.server.ts`) has no tool-call field at all; the
client tracer writes `args.toolCalls`. So the Swarm Traces page shows a
deployed run as if its agents never used a tool, which is the case where
someone most wants to know. Left open here — this pass is about the picker —
and queued for the ML/agent integration work, where the deterministic scoring
node will need its calls visible on exactly this path. For this round the
headless evidence is the run's `swarm_snapshot` (the node's
`ml_model_names: ["revenue_facts plan classifier"]`) and an output naming that
one model with "Count: 1", a name the input never mentioned.

**Closed 2026-09-14.** The server read /api/chat's stream for text and the
`cost` event and dropped every `tool` event; the stream reader is now one
pure function (`src/lib/chatStream.ts`, `readChatStream`) that hands the
executor the same events the canvas keeps, the executor collects them per
node, and the server tracer writes `tool_calls` where the canvas tracer
does. A tool node and a retrieve node record their own call and result in
the agent loop's shape (`toolNodeEvents`), an ML result carrying the same
person-readable table the Playground panel gets, so the Score node's calls
are visible on exactly this path. The Traces page reads both shapes — the
loop's `args` string and result preview, and older rows' `arguments`
object. Ten mutants, ten caught.

### 2026-08-18 — Modules 30 & 31, IAM (`/admin/iam`) and Developer runtime (`/admin/runtime`)

The last two modules, and the same finding on both: a failed load that could
not be recovered from. Neither page ever told a lie — which on the two pages
that govern access and code execution is the part that matters most, and both
had it right before the campaign arrived.

#### Module 30 · IAM — S3 · A dead end with the exit in the unreachable room

This is the best-behaved read path in the whole campaign. All **seven**
server-fn reads are checked (`if (!u.ok) return setError(u.error)` and six
siblings); the error is held in state and rendered in two places; and every
list stays `null` on failure because each check returns _before_ any setter
runs. So no "no users", no "no groups", no "no grants" can ever appear from a
failed read. On an access-control page, where an empty grant list read as fact
is the difference between "nobody has access" and "we could not check", that
property is the whole ballgame — and it was already there.

What it lacked was a way out. Measured with `iamListUsers` 403'd (one
interception): three skeletons, one line of red error text, and **no control of
any kind**. The Refresh button exists — in the main view, below the gate that
the null lists keep active. A browser reload was the only recovery.

#### Module 31 · Developer runtime — S2 · The same, one step worse

`RuntimeTab`'s load did `if (!res.ok) return toast.error(res.error)` — the
error going to a **toast only**, `state` left null, gate rendering two
skeletons. Measured with `nbRuntimeGetState` 403'd (two interceptions), then
sampled again nine seconds later:

|               | at 5s          | after the toast expired |
| ------------- | -------------- | ----------------------- |
| skeletons     | 2              | **2**                   |
| toast         | (already gone) | gone                    |
| error text    | **none**       | **none**                |
| retry control | **none**       | **none**                |

A permanently blank page, with nothing on it saying why — governing whether the
Python runtime is enabled, its egress allow-list, and who is granted access to
it. S2 rather than S3 because unlike IAM there is no persistent error at all:
after a few seconds the screen is indistinguishable from a page that is simply
still loading, for ever.

#### Fixed the same way on both

A settled failure now renders the reason, a reassurance that the configuration
itself is untouched — "every user, group, rule and grant is unchanged and still
enforced" / "the runtime's current configuration is unchanged and still in
force" — and a **Try again** wired to the loader. The reassurance is
load-bearing on these two pages specifically: a superadmin who believes IAM is
broken may start re-granting access that never lapsed, and one who believes the
runtime page is broken may re-enable a runtime that was never off.

IAM's branch is gated on `error && !loading` on purpose, so an error latched
from a previous attempt does not replace the skeleton of the retry currently
running — a detail with its own test.

Verified live on both: the failure state shows the error and no skeletons, and
clicking Try again with the injection healed brings the real page back (IAM's
tabs and Refresh; the runtime's switches).

#### Mutations: 6/6 (IAM) and 5/5 (runtime)

Both sets are source tripwires, and the reason is stated in the test file: IAM
is a 2,400-line superadmin route driven by seven server functions and
RuntimeTab is driven by five, so rendering either here would test mocks. Two
of the IAM mutations pin the properties that were _already_ good rather than
what I changed — dropping a read check, and moving `setUsers` above the checks
so a false empty becomes possible. Those exist because this page's existing
correctness is worth protecting from a future refactor, not just my addition to
it.

**Tests:** 9 in `tests/unit/iamRecoverable.test.ts` covering both pages. No
fixtures; nothing was granted, revoked or enabled.

---

## Coverage complete — all 31 modules audited

Every module in the map now has a pass. What the campaign found, in one place:

- **The dominant defect, 16 times over:** a read whose failure was reported as
  a fact about the account — "you have none", "0 connected", "no audit events",
  "no providers connected" — usually with an invitation to fix the emptiness by
  redoing work that already existed. Four modules also _instructed_ the user
  (create a dataset, execute a swarm, connect a provider, add an Evaluate node).
- **Silent truncation, 4 times:** `.limit()` capped below the real row count,
  or PostgREST's max-rows capping below the `.limit()`, with the loaded window
  presented as the population. Once (module 24) the caps were non-uniform in
  time, so a merged feed mixed a 3-day view of one action type with a 13-day
  view of another.
- **Verdicts over work that never happened, twice:** the model that failed
  fastest crowned fastest; a run with nothing scored graded 0%.
- **Unrecoverable states, 4 times:** skeletons with no retry, and once a
  _memoised_ failure that claimed "no providers connected" for a whole session
  from one transient 403.

Reusable primitives left behind: `listClaim`, `countClaim`, `traceWindow`,
`auditWindow`, `budgetLoad`, `compareWinner`, `evalPassRate`, `serviceHealth`'s
`servicesSummary`, and `adhocTools`. `failedReadClaims.test.ts` pins nine
converted pages against eight rules — still deliberately a list, not a rule
over every page.

Two habits earned their place and should outlive the campaign: **positive
injection proof** (a failed-read finding requires the interception counted, not
inferred from what rendered — the rule module 16 cost a whole pass to learn),
and **mutation-verifying every test**, which caught eleven decorative tests
across the run, including one that let the exact defect it was written for pass
straight through.

---

### 2026-08-18 — Module 29, Image Playground (`/image-playground`)

One finding, and it is the first in this campaign that **outlives the request
that caused it**. The fix is in a shared module, so it lands on two pages.

**What the page already does right.** The models read — the second, per-provider
fetch — keeps its error in `modelsError` and renders it; "lists no
image-generation models" is shown only when that error is absent. The defect is
one layer down, in the provider list both this page and `BiModelSelect` share.

#### S1 · "No model providers connected", for an account with two — and it sticks

`fetchConnectedIntegrations` merges two tables and did `?? []` on both, so a
403 produced an empty list and **resolved successfully**. The page's own
`.catch` was therefore never reached: there was nothing to catch. What
rendered was the onboarding empty state —

> No model providers connected. Connect one under **Integrations** to generate
> images.

— to an account with `gemini` and `openrouter` both active. The same shape as
modules 22 and 28: an empty state that doubles as an instruction to redo work
already done.

The second half is what makes it worse than its predecessors. The fetcher
memoises:

```ts
integrationsPromise ??= Promise.all([...])
```

so the empty result was cached for the session. Measured directly: after the
injected failure, a second call returned the same empty list with **zero new
requests** — the network was never touched again. One transient 403 during
page load claimed "you have connected nothing" until the tab was reloaded, on
every surface that uses this fetcher.

Both halves were proven against a cache-busted fresh module instance with the
403 armed, two interceptions recorded: the call resolved `[]` rather than
rejecting, and the follow-up call made no requests at all.

#### Fixed at the source, so both consumers benefit

The fetcher now throws on either read's error, and its `.catch` clears
`integrationsPromise` before rethrowing — so a failure is never memoised and
the next caller genuinely retries. A **success** is still cached; the memo was
never the problem, caching a failure was. The page keeps the rejection reason
in `providersError` and renders it — "Anything you have connected is still
connected" — above the empty claim, which is now unreachable while an error is
held.

Verified live in three states with interceptions counted: failing (rejects,
error panel, no false claim), healed (the retry recovers both providers with
real requests), and healthy.

#### Mutations: six run, all killed after two tripwires

Three fell to the unit tests directly — the two swallowed read errors and the
re-memoised failure. The fourth, "successes stop being cached", is worth
noting: it is a mutation that makes the code _less_ efficient without making
it wrong, and the test that catches it exists to say the cache is deliberate.
The two page-level survivors were the usual UI wiring, pinned by tripwires
including the now-standard ordering assertion.

**Tests:** 6 in `connectedIntegrations.test.ts`, exercising the real exported
function against a stubbed client — including "a genuinely empty account still
resolves empty, not an error", which is the claim the fix must not break —
plus 2 tripwires. No fixtures; the database was read and never written.

---

### 2026-08-18 — Module 28, Evaluations (`/evaluations`)

Two findings, both about a verdict. This page's whole output is a judgement on
whether a swarm's answers were good, so a number that is wrong rather than
missing is the worst thing it can produce.

#### S1 · "0% pass" on a run that had scored nothing

`pct(n, d) => d > 0 ? round(n/d*100) : 0` — a zero denominator returned **0**,
so a run with 0 of 12 cases scored rendered "**0% pass**": a failing grade for
work that had not been marked. Measured live against a fixture run in exactly
that state (`status: running`, `done_count: 0`, `case_count: 12`).

The contradiction was on screen at the same time. `fmtScore` renders "—" for a
null `avg_score`, and did so for this very run — so the page showed "Avg score
—" beside "0% pass", the same absence reported honestly by one card and as a
failing grade by the other. The half that looked like data was the wrong one.

The distinction the fix has to keep: **zero is a real pass rate.** A run where
every scored case failed genuinely is 0%, and hiding that behind the same "—"
the unscored run gets would trade one lie for another. `passRate` returns null
only when nothing has been scored.

#### S1 · "No datasets yet — create one and add test cases." for an account with one

All three list reads — datasets, runs, swarms — discarded their error and fell
to `?? []`, then `setLoaded(true)` regardless. With a 403 injected on the
datasets read (one interception recorded) the page rendered its onboarding
empty state to an account holding a dataset. The now-familiar shape, on the
page where the empty state doubles as a setup instruction.

#### Fixed

`lib/evalPassRate` owns the rate: null when nothing is scored, a real 0% when
everything scored failed, "—" as the display form. The load keeps the first
error of the three reads and renders it — "Any datasets and runs you have are
still saved" — above the empty state, so the onboarding copy is unreachable
while an error is held.

Verified live in all three states with interceptions counted: healthy shows
the fixture dataset and "— pass" for the unscored run; the failed read shows
the error and no "No datasets yet"; restored returns to healthy.

#### Mutations: seven run, four killed by tests, three forced tripwires

The survivors were all UI wiring the pin rules could not see — a local
redefinition of `formatPassRate` keeping every call site intact, the read
errors swallowed while `setLoadError` still appeared in dead code, and the
error branch deleted while `loadError` was still mentioned elsewhere. All
three are pinned by tripwires that state their limits, including the ordering
assertion the audit log needed for the same reason. Second pass: 7/7.

A pin-rule note worth recording: the first attempt aliased the helper as
`const fmtPassRate = formatPassRate`, and the claim rule REJECTED it — an
alias satisfies neither "called" nor "branched on". That is the rule working
as intended, and the fix was to call the shared function directly at both
sites rather than to weaken the rule.

**Tests:** 8 in `evalPassRate.test.ts` plus 3 tripwires; failedReadClaims
gains the evaluations row. **Fixtures:** one `eval_datasets` row and one
`eval_runs` row created directly (the run had to be in a state the UI cannot
produce on demand — started, nothing scored), both deleted afterwards and
both tables re-read at `*/0`.

---

### 2026-08-18 — Suite note: a flake, measured rather than assumed

The module 27 full-suite run came back red with one failure:
`semanticMeasure.test.ts > refuses a relative-date filter and says why`,
"Test timed out in 20000ms" on a dynamic `await import()`.

Checked rather than waved through: the file passes 22/22 in isolation in 4.2
seconds, and `git diff` confirms module 27 touched neither it nor anything it
imports. A clean re-run of the whole suite came back green. Same shape as the
`nl2sqlEval` timeout recorded during module 16 — a dynamic import starved
under full-suite parallel load, not a regression.

Recorded because "the suite went red and I decided it was fine" is exactly the
reasoning this log exists to make people show their work for.

---

### 2026-08-18 — Module 27, Prompt Compare (`/prompt-compare`)

One finding, and the first in this campaign that is not about a database read
at all. This page has none — it streams the same prompt to two or three models
and compares them. The defect is in the comparison itself.

**What this page already does right.** Costs and token counts use real usage
when the server returns it and fall back to a character estimate only when it
does not; estimates carry a `~`, unknowns render `—` rather than `0`, and the
cost winner already skipped nulls. The `~` discipline is exactly the honesty
this campaign asks for, applied before anyone asked.

#### S1 · The model that failed fastest was crowned the fastest model

`minIdx` ranked panels on raw `durationMs`. A request that ERRORS still
records a duration — the catch sets `durationMs: Date.now() - startedAt` — so
a model that fails immediately posts the lowest time and wins.

Measured with three panels, the first two answering and the third failing
fast:

| panel | model                     | time     | answered?                      | crowned            |
| ----- | ------------------------- | -------- | ------------------------------ | ------------------ |
| A     | Gemini 2.5 Flash          | 2.0s     | yes                            |                    |
| B     | GPT-5 Mini                | 2.7s     | yes                            |                    |
| C     | Gemini 2.5 Flash **Lite** | **0.1s** | **no — errored, zero content** | **green "winner"** |

The failing model was highlighted green as the best response time, against two
models that actually answered the question. On a page whose entire purpose is
to help someone pick a model, "fastest" was being awarded for failing quickest.

Two details made it reachable and easy to miss. The stats block is gated on
`panelA.content && panelB.content`, so an errored A or B suppresses the table
entirely — but panel C, the optional third, is in the comparison and NOT in
the gate. And a fast failure is the common kind: a 500 from the gateway, an
unavailable model, a bad key. The slow, thoughtful answer loses to it every
time.

#### Fixed: a competitor is a panel that answered

`lib/compareWinner` encodes two rules. A panel that produced no answer is not
a competitor — its speed measures how fast it failed, which is not the
quantity on display. And a winner over a field where the rivals' values are
unknown is not a winner: with fewer than two comparable panels the helper
returns -1 and nothing is crowned, because highlighting the only measurable
value presents it as the best value.

The header now also carries what the ranking left out — "(ranking excludes 1
did not answer)" — so a comparison covering fewer models than the table shows
says so.

Verified live by re-running the identical three-panel scenario: the crown
moved to Flash at 2.0s, a model that answered, and the caveat appeared. The
streams were fabricated rather than billed — two SSE responses and one 500 —
so the measurement cost nothing and was exactly repeatable.

#### Mutations: six run, five killed by tests, one forced a tripwire

The survivor was the page's own predicate, `answered = () => true`, which
restores the finding precisely and which no test of the pure helper can reach.
It is pinned by a source tripwire that states its limit — `ComparisonStats` is
a route-local component fed by three live streaming panels, so exercising it
here would test mocks. Second pass: 6/6.

**Tests:** 10 in `compareWinner.test.ts` plus the tripwire. No
failedReadClaims row — there is no read here to fail. No fixtures, no API
spend.

---

### 2026-08-18 — Module 26, Monitoring (`/monitoring`)

One finding, an S3, and a page that is otherwise the best-defended in this
range — worth saying plainly, because most of the campaign has been failures.

**What this page already does right, verified by reading and by the live
healthy state:** it holds a `error` in state and renders it in a banner; a
failed refresh KEEPS the last-good probes and metrics rather than blanking
them (stale-but-labelled, the correct choice); null hardware metrics render
"—" not "0"; an empty probe list renders "No probe results yet." in the table
body; and it refreshes both on an interval and on demand. Nothing here reports
a failed read as an empty or healthy account in the body. This is the standard
the campaign has spent twenty-five modules enforcing, already met.

#### S3 · The summary line claims health over an empty probe set

The one seam. The header read:

```
{unhealthy.length === 0 ? "No problems detected" : `${unhealthy.length} needing attention`}
```

`unhealthy.length === 0` is true whenever `services` is empty — a
misconfiguration that returns no probes, an all-filtered set, or the first
load failing (the catch keeps `services` at `[]`). So a monitoring page could
print **"No problems detected"** having probed nothing. In the failed-load
case it prints that beside its own error banner — the header and the banner
contradicting each other on the one screen whose job is to tell an operator
whether anything is wrong.

This is source-certain and injection-independent: the claim is wrong on an
empty set regardless of _why_ the set is empty, so it needs no failed-read
injection to establish. (Which is the honest framing — the live harness could
not re-fire this page's reads through a `fetch` patch: its refresh dedupes,
and unlike the pages with a durable refresh path there was no reliable lever.
I did not claim a failed-read result I could not positively inject; I fixed
the emptiness claim, which is provable without one.)

Severity S3, not higher, because the mitigations are real: the error banner
and the "No probe results yet." body text both appear on a failed load, so the
user is not left with pure false reassurance — only a contradictory header.

#### Fixed with a four-way summary

`servicesSummary` in `lib/serviceHealth` distinguishes the states the old
ternary collapsed: probed-and-healthy → "No problems detected"; probed-with-
problems → "N needing attention"; **empty → "No services to probe"**;
**empty-and-errored → "Health unknown — could not probe"**, deferring to the
banner instead of contradicting it. A later refresh that fails while keeping
its data still summarises that data — the error travels in the banner, not the
count. Healthy path verified live unchanged (22 services → "No problems
detected").

**Mutations 4/4**, including the two that matter: an empty set reassuring
again, and an errored-empty asserting health. **Tests:** 5 in
`servicesSummary.test.ts`. No failedReadClaims row — this page never reported a
failed read as an empty account, which is what that file pins; its defect was
narrower and lives in its own test. No fixtures.

---

### 2026-08-18 — Module 25, Budgets (`/budgets`)

Three findings, all on a spend-**protection** page — where a discarded read
error does not read as "unknown" but as "you are not protected", or "you
cannot see that you are". Credit first: the month-to-date spend figure was
already exemplary — aggregated in the database through `budget_spend_since`,
returned as a discriminated result so a failed compute renders "unavailable"
rather than "$0". The three table reads around it were not.

**Healthy path is exact.** $6.92 of the $20 cap, 34.6% used, 7 agents — the
spend matches `budget_spend_since` to the cent (6.916376).

#### S2 · A failed budget read hangs the page on skeletons for ever

`budget_settings` was read with the error discarded. On failure `budgetRow` is
null — and the code takes null for "this user has no budget yet" and tries to
INSERT one. The `user_id` UNIQUE index rejects the duplicate, that error is
discarded too, `budget` stays null, and the render gate `loading || !budget`
keeps the three skeletons up permanently. No error, no retry, no end. The
unique index is the only reason this does not also write duplicate rows.

#### S1 · "No agents yet. Create one in the Agent Builder first.", for 7 agents

`agents` read failing gave `setAgents([])`, and the empty state does not merely
claim emptiness — it sends the user away to build agents they already have,
on the page where they came to cap those agents' spend.

#### S1 · Every per-agent cap rendered as unset

`agent_limits` failing gave an empty map, so every agent rendered with no cap
configured. On a page whose entire subject is which agents are capped, a read
failure paints all of them as uncapped — the most consequential of the three,
because the false state is "unprotected" and someone might act on it by
setting a cap that already existed, or trusting one that did not load.

#### Fixed by extracting the load, and by not inserting on a failed read

`lib/budgetLoad` assembles all four reads and keeps every error. The one
subtlety it encodes: a null budget row means "create one" ONLY when the read
succeeded — the insert path that both hid the failure and collided with the
unique index is now unreachable from an error. Any read failing returns
`{ ok: false, error }`; the page holds `loadError`, renders an alert with the
reason, "your caps and limits are unchanged and still enforced server-side",
and a Try again, above the skeleton gate so the hang is impossible.

**On verification, stated honestly.** The healthy path is proven live and
exact. The three failure paths are proven by `budgetLoad`'s unit tests rather
than by live injection, because this page's load runs in a mount effect keyed
on `[user]` that fires exactly once — there is no in-page refresh to re-run it
with a `fetch` patch installed, and a reload wipes the patch (the module 16
lesson). Rather than race the boot, the load logic was lifted into a pure
function and tested deterministically: eight cases including the two that
matter most — the insert fires on a real empty read and NEVER on a failed one,
and a genuinely empty agent list still loads as empty rather than as an error.
This is the same choice made for the server-fn tripwires in modules 23–24:
where the live harness cannot reach, a deterministic test is the stronger
proof, and which guard does the work is written down.

**Mutations: 7/7 killed** — each of the three swallowed errors, the
insert-on-failure path, a failed create, and both UI halves (the error branch
and the error recording).

**Tests:** 8 in `budgetLoad.test.ts`, failedReadClaims gains the budgets row.
No fixtures — reads only; no budget row was created or altered.

---

### 2026-08-18 — Module 24, Audit Log (`/audit`)

Two findings on the one page whose entire purpose is evidence. Both were
measured with the injection positively confirmed.

#### S1 · "No audit events in the retention window.", on a window holding 1,922

`load()` caught, toasted, and ran `setRows([])` — the campaign's oldest shape,
on its worst possible page. With the read failed (one interception recorded)
the audit log rendered its empty state, and after the toast expired the only
thing on screen was a bordered box saying **"No audit events in the retention
window."**

What separates this instance from the fourteen pages before it: an audit
log's empty claim is _exculpatory_. "No events" is not a UI state here — it is
a statement about what happened, the kind of statement someone screenshots
into an incident channel. A page that produces it because a token expired is
manufacturing evidence of absence.

#### S1 · 400 rows shown for a window holding 1,922 — with per-action gaps

The log merges three sources — `audit_events`, `execution_traces` (as
`model.call`), `swarm_runs` (as `swarm.run`) — each fetched newest-first with
a 300-row cap, merged, and sliced to 400. Measured against exact counts:

| source             | in window | fetched |
| ------------------ | --------- | ------- |
| `audit_events`     | 361       | 300     |
| `execution_traces` | 1,537     | 300     |
| `swarm_runs`       | 24        | 24      |

Nothing on screen disclosed any of it. And the damage is worse than a missing
count, because the caps are **non-uniform in time**: model.call's 300 of 1,537
reached back roughly three days while audit_events' 300 of 361 reached
thirteen. The merged table silently mixed a 3-day view of one action type
with a 13-day view of another — so "no model calls on the 10th" read off this
screen was an artifact of the cap, not the history. A merged-then-sliced feed
also cannot claim "the most recent 400": a capped source's excluded newer
rows lose their place to another source's included older ones.

#### Fixed: a uniform window or nothing

`lib/auditWindow` owns the rule: a merged feed of capped sources is complete
only down to the **newest "oldest fetched row" among the sources that hit
their cap**. The server fn now computes that boundary, trims the merge to it,
and returns exact head-counts over the same filters, so the visible window is
gap-free for every action type — the property an audit log exists to have.
The headline states it plainly:

> showing all 492 events since 8/14/2026, 2:04 PM — the 7-day window holds
> 838; older activity is beyond the per-source fetch cap

(492 > the old 400: dropping the arbitrary slice while trimming to the honest
boundary showed MORE gap-free rows, not fewer.) A complete window reads
"838 events over the last 7 days". The failed read now renders an error panel
— the reason, "the events themselves are still recorded", and a Try again —
verified in all three states with interceptions counted, restored clean.

The headline deliberately never says "most recent". `auditWindowHeadline`'s
tests pin that word as forbidden in the trimmed form.

#### Mutations: seven run, five killed by tests, two forced tripwires

The survivors were both wiring: the server fn skipping its trim (helpers
imported, never called), and the UI's error branch deleted while `loadError`
still appeared branched elsewhere (the headline gate satisfied the pin rule).
Both are now pinned by tripwires that state their own limits — including an
ORDER assertion that the error branch sits above the empty state in the
ternary chain, since JSX evaluates top-down and reachability is the whole
point. Second pass: 7/7.

**Tests:** 11 in `tests/unit/auditWindow.test.ts` (9 behavioral + 2
tripwires), failedReadClaims gains the AuditLog row. No fixtures — reads
only, and the retention setting was never touched.

---

### 2026-08-18 — Module 23, Traces & Logs (`/traces`)

One finding — and credit where due first: this page's failed-read handling was
already right before the campaign got to it. `loadError` is held in state, the
empty state distinguishes "Couldn't load traces" from "No traces yet", a Retry
button is offered, and the detail dialog surfaces its own errors (verified
live by corrupting the detail call's token — one interception, error shown).
Somebody built this page to the standard the campaign enforces.

#### S1 · "1,000 traces", stated as the population of an account holding 2,774

Both query paths — the `getExecutionTraces` server function and its client
fallback — carry `.limit(2000)`, and PostgREST's max-rows setting silently
truncates both to 1,000. The header printed `filtered.length` as the total:

|        | claimed          | true (90-day window) |
| ------ | ---------------- | -------------------- |
| header | **1,000 traces** | 2,774                |

Everything derived from the loaded rows inherits the truncation: the model and
agent filter dropdowns miss values present only in older rows, the notebook
count, and "Page N of M · X results". This is module 21's defect on its
sibling page — found by the same measurement, an exact head-count compared
against the claim.

#### Fixed as a window claim, not a full fetch — deliberately

Module 21's fix paged through everything, because that page computes KPI
totals and a sum over a fragment is a wrong number. This page is a **log
browser**: rows carry full `prompt` bodies, the 1,000-row load already takes
~25 seconds, and nobody reads 2,774 traces in a table. Completeness is not
the goal here; an honest window is. So:

- `getExecutionTraces` now returns `total` from an exact head-count running
  beside the capped page query — the count travels with the data.
- The header routes through `traceCountHeadline`, which learned to name its
  range ("the last day" … "the last 90 days") instead of assuming 30:
  truncated reads "showing the most recent 1,000 of 2,774 traces from the
  last 90 days"; complete reads "80 traces over the last day".
- A warning line under a truncated header says what the filters below
  actually cover, and points at the fix: narrow the date range.
- With client filters active the header claims only the loaded window:
  "5 of the 1,000 loaded traces match".

All four states verified live: truncated-90d, filtered, complete-1d (warning
absent, exact "80 traces over the last day"), and restored. The 1d count was
checked against the table rather than assumed.

#### Mutations: four run, three killed, the fourth pinned as a tripwire

The survivor was `total: traces.length` inside the server function — the
capped page presented as the population, a value swap no behavioral test can
reach without standing up `createServerFn` and `supabaseAdmin`, which would
test mocks. It is pinned by a source tripwire that says so in its own
comment: its job is to make the dodge visible in review, not impossible.
Second pass: 4/4.

**Tests:** traceWindow 15 → 18 (range labels + the tripwire),
failedReadClaims gains the traces.tsx row — which passed all eight rules on
the first run, the second page in a row already meeting the campaign's bar
for error handling. The cap was the only lie left.

---

### 2026-08-18 — Module 22, Swarm Traces (`/analytics/observability`)

Two findings, one per read, and a verification technique worth keeping.

**Everything matched when the reads succeeded.** 26 runs in `swarm_runs` over
30 days, "26 swarm runs" in the header, 26 table rows. The Quality trends strip
was checked against the app's own `parseEvalScorecard` rather than a
re-implementation of it — 5 scorecards, 75% average, 60% pass rate, 3 distinct
swarms, all four exact.

#### S1 · "0 swarm runs" and "No swarm runs yet", for an account holding 26

`const { data } = await supabase.from("swarm_runs")…` — the error discarded,
`data` null on failure, `setRuns([])`. Measured with the read 403'd and three
interceptions recorded:

|                | healthy       | read failed              |
| -------------- | ------------- | ------------------------ |
| header         | 26 swarm runs | **0 swarm runs**         |
| table          | 26 rows       | **"No swarm runs yet."** |
| any error text | —             | **none**                 |

And the empty state does not stop at claiming emptiness — it instructs:
"Execute a swarm from the Swarms canvas to see traces here." A user whose runs
merely failed to load is told to go and re-run work that already ran.

#### S2 · The onboarding card, shown to an account that had already onboarded

The same shape in `QualityTrends`, and its failure mode is the more
embarrassing of the two. With the eval-steps read 403'd, the whole stat strip
was replaced by:

> **Quality trends.** Add an **Evaluate** node to a swarm to score answers
> (accuracy, tone, safety…) with an LLM judge.

for an account with five scorecards across three swarms. The page did not print
a wrong number here — it printed a wrong _premise_, and told the user to set up
a feature they had already set up. Recorded as S2 rather than S1 on the module
16 reasoning: no count is stated, and the falsehood is carried by onboarding
copy that implies absence rather than asserting it.

#### Fixed, and the honest empty state proven to survive

The run list routes its count and empty state through `listClaim`, and
`QualityTrends` gained an error branch that outranks the onboarding card.

The verification worth keeping is how the _empty_ case was checked. A fix that
stops a page saying "you have none" is only half tested if nobody confirms it
can still say "you have none" when that is true — and emptying 26 real runs to
find out is not an option. So the injection was inverted: instead of a 403, a
**200 with an empty body**. Same code path as a genuinely empty account, no
data touched.

| read         | empty 200                            | 403                      | healthy       |
| ------------ | ------------------------------------ | ------------------------ | ------------- |
| `swarm_runs` | "0 swarm runs", "No swarm runs yet." | "—", error + reassurance | 26            |
| eval steps   | onboarding card                      | "could not be loaded"    | Evaluations 5 |

Three distinct states per read, each with its interception counted. That is the
first time in this campaign the true-empty branch has been positively
demonstrated rather than argued from the helper's unit tests.

#### Mutations: six run, four killed by tests, two by the type checker

The two survivors were the same edit on each file — dropping `error` from the
destructure. They survive the suite because these pin rules read source and
never execute it, but they do not survive `tsc`:

```
analytics_.observability.tsx(60,11): error TS2552: Cannot find name 'error'.
QualityTrends.tsx(83,11):            error TS2552: Cannot find name 'error'.
```

That was checked rather than assumed — the mutation was applied and `tsc` run
against it, both times. A defect caught by the type checker is caught; it is
worth writing down which guard is doing the work, because "the tests pass" and
"this is guarded" are different claims and this campaign exists to keep them
apart.

**Tests:** `failedReadClaims` 84 → 100 (two new rows, both green on the first
run — the first module in a while where no pin rule needed widening). No new
pure module: the run list reuses `listClaim`, which carries its own mutation
coverage. No fixtures; the database was read and never written.

---

### 2026-08-18 — Module 21, Analytics (`/analytics`)

Three findings. The first is the only one in this campaign so far where the
page was wrong about the data it _had_, not merely about a read that failed.

#### S1 · A silent row cap made every number on the page wrong

`load()` asked for `.limit(2000)`. PostgREST's `max-rows` setting capped the
response at 1,000 and supabase-js returned that first page as a complete
result — no error, no truncation flag, and the `.limit(2000)` simply never
mattered. The page then said, in words:

> **1,000 traces over the last 30 days**

to an account holding **2,731**. Every KPI is derived from the same array, so
every KPI inherited it. Measured against a paged read of the same filter:

|               | page said | truth    | error    |
| ------------- | --------- | -------- | -------- |
| traces        | 1,000     | 2,731    | −63%     |
| Spend (MTD)   | $6.01     | $6.36    | −5.6%    |
| Tokens (30d)  | 2,052.6K  | 3,767.9K | −46%     |
| Active agents | 18        | 22       | −4       |
| Avg latency   | 10,498ms  | 7,981ms  | **+32%** |

The latency row is the one worth staring at. The other four are
under-counts — bad, but bad in a direction a careful reader might guess. Average
latency was **biased upward by a third**, because the cap takes the most recent
thousand rows and that window happened to be slower than the month it was
standing in for. A truncated mean is not a smaller mean; it is a mean of a
different population, and nothing on the page said so.

The fix reads an exact `count` first, then pages with `.range()` until a short
page proves the end. The header now says `2,731 traces over the last 30 days`
and all four KPIs match an independent paged computation exactly. If the
client-side ceiling is ever reached the header switches to "showing the most
recent N of M" and a warning appears above the cards — a page is entitled to
describe itself, not the account.

#### S2 · A failed read rendered as an empty account, beside a seeder

Same shape as modules 13–20, with a sharper edge than most. `load()`
destructured only `data`, so a 403 left `traces` at `[]` and the page rendered
"**No execution data yet**" with a **Generate sample data** button — measured
live, 6 interceptions recorded, no error text anywhere.

That button writes ~600 example rows. Its server guard refuses when more than
50 traces already exist, so the write would in fact have been declined here —
but the guard is doing that work by accident. The page offered a write on the
strength of a number it did not have, and the only thing standing between a
failed read and example data mixed into a real account was a threshold chosen
for a different purpose. The error panel now declines to offer seeding at all,
and says why.

#### S2 · The team-spend breakdown said "Loading…" for ever

`TeamSpend` toasted its error and left `users` at `null`, and the render reads
`users === null ? "Loading…"`. So a failed read showed a spinner-shaped
sentence permanently — measured with the JWT corrupted so the real server
returned its own error, and still on screen after the toast expired. Now an
explicit error branch outranks the loading state.

**What was already right.** The `BY USER` table aggregates server-side through
the `admin_spend_by_user` RPC, with no row cap, and its $8.0716 for 2,731 calls
matched a paged sum of `cost_usd` to the cent. Worth recording because it is
the same page: the SQL-aggregate path was correct all along, and the defect was
entirely in the client-side array the KPI cards were built from.

#### Mutations, and a survivor that changed the fix

The first run killed **6 of 9**, and two survivors were behavioural rather than
cosmetic: reverting the paging to a single capped read, and letting an errored
page fall through so a fragment got summed as if whole. Source inspection
cannot see either — the pin test reads files, it does not run them.

So the paging loop moved out of the component into `lib/traceWindow`, where it
could be tested against a fake table: every row across pages, a short page as
the only proof of the end, an extra read when the last full page lands exactly
on the boundary, the ceiling honoured, and an errored page aborting the whole
load rather than resolving to a fragment. Second run: **9 of 11**.

The two that remain are `setLoadError` calls in analytics.tsx, and they survive
for the reason this file has now recorded three times: the rule asks whether an
error is recorded _somewhere in the file_, and this file records it in four
places, so deleting one leaves three. Killing that would need the route
component rendered, which is the thing `emptyStateLoadGate` explains it will
not do. Recorded rather than papered over.

**Pin rules broadened, not weakened.** Two rows were added and both initially
reported correct code. `TeamSpend` has no count and no list, so it routes
through an error-state branch rather than `listClaim` — the claim rule now
accepts a state guard (`loadError !== null`) as well as a helper call. And it
holds its error in state rather than destructuring one, so the "names a read
error" rule now recognises `setLoadError(...)` alongside `error: e`. Both
changes let a correctly-fixed page pass; neither lets a broken one through,
which the mutation run confirms.

**Tests:** 15 in `tests/unit/traceWindow.test.ts`, `failedReadClaims` 67 → 84.
Full suite 215 files, 4039 tests, green — a delta of exactly the 32 added. No
fixtures: this pass only read.

---

### 2026-08-18 — Module 20, Model Registry (`/model-registry`)

One finding, and it is the sharpest version of this class so far: the failed
read does not merely misreport, it argues for an action.

**What matched.** `model_registry` holds 770 rows and all three counts on the
page read 770 — the headline, the provider select and the All tab — against an
exact `0-0/770`. "Last refreshed 3w ago" matched `model_registry_meta`. The
search box filters on name, id, developer and description as it claims.

#### S1 · Four false claims, and a button that acts on them

`load()` caught, toasted, and left `models` at `[]` and `meta` at `null`, with
`setLoading(false)` in a `finally`. The injection corrupted the outgoing JWT so
the **real server** threw, returning its own `$TSR/Error` envelope with
`"Unauthorized"`, and the corruption was recorded per request:

|                                  | healthy | server threw |
| -------------------------------- | ------- | ------------ |
| "Browse N live models"           | 770     | **0**        |
| "All providers (N)"              | 770     | **0**        |
| "All (N)"                        | 770     | **0**        |
| "Last refreshed …"               | 3w ago  | **never**    |
| "No models match these filters." | no      | **yes**      |
| "Run a sync now" (admins)        | no      | **yes**      |

Every one of those is false, and they compose into an argument. The registry
appears empty; the emptiness is blamed on the filters, which is a cause the
page has no evidence for; "Last refreshed never" says the sync has never run;
and an admin is then offered a button to run one. That sync calls an external
provider and rewrites the table. **A failed read talks an administrator into a
write.**

"Last refreshed never" is the detail worth keeping. `timeAgo(null)` returns
"never", which is correct for a registry that has never synced and a lie about
a registry whose sync record could not be read — and it is the single claim on
the page that argues hardest for pressing the button.

#### Fixed, and the fix declines to offer the sync

The counts now come from `countClaim`, the panel decision from `listClaim`, the
timestamp reads "unknown" rather than "never", and the error panel says the
registry "has not been emptied and the filters are not hiding anything". The
sync button is **deliberately absent** from that panel, and the page says why:
a sync started from a failed read would be acting on a number nobody has.

Verified live in four states, each with the injection confirmed:

| Condition                 | Page                                            |
| ------------------------- | ----------------------------------------------- |
| healthy                   | 770 / 770, "3w ago"                             |
| server threw (bad token)  | "—" / "—", "unknown", alert, no sync, Try again |
| request rejected outright | same                                            |
| restored                  | 770 / 770, "3w ago"                             |

And the claim that had to survive the fix: with a healthy read and a filter
matching nothing, the page still says "No models match these filters" and still
shows 770. Filter-empty, registry-empty and read-failed are now three different
statements instead of one.

#### The headline kept its thousands separator on purpose

`countLabels` returns a plain `String(n)`, so routing the headline through it
directly would have dropped the grouping separator the moment the registry
passes a thousand — a small presentational regression smuggled in by a
correctness fix. The label decides _whether_ a number may be shown; the
headline then formats it. Worth writing down because the tempting one-liner is
wrong in a way nobody would notice until the row count grew.

#### Mutations: six run, five killed, then the survivor explained

The survivor disabled the `catch` keyword while leaving its body in place. The
rejection rule is FILE-scoped — this page has an unrelated `catch` in its
clipboard helper — so it passed. Rewritten as a real refactor would do it,
deleting the handler and the `setLoadError` inside it, it is killed by the
"records the error from a real value" rule.

That limit is now written into the test file beside the rule rather than left
to be rediscovered. It is the third time source inspection has been shown to
prove presence rather than use, and the answer each time has been the same:
move the decision into a real function with its own tests, and keep the source
rule as a tripwire rather than a proof.

The rejection rule was also **broadened**, not weakened: it named only
`.catch()`, and this page handles rejection with try/catch around the await. A
rule that reported a page for handling the case correctly would have been the
fourth to cry wolf in this campaign, so it now accepts both shapes.

---

### 2026-08-17 — Module 19, MCP Servers (`/mcp`)

One finding, and the interesting part is why four converted pages did not
prevent it.

**The arithmetic is right when the read succeeds.** Against two fixture servers
— one `connected` exposing 7 tools, one `error` exposing 3 — the header read
"1 connected" and "7 tools available", both matching a figure computed
independently from `mcp_servers`. The errored server's three tools are
correctly excluded from the total, so the sum is a real filter and not a naive
count. `timeAgo` guards a null `last_ping` and renders "never".

#### S1 · "0 connected" and "0 tools available", for an account with seven

`load()` checked its error — better than the pages that discarded it — and
toasted. But it left `servers` at its initial `[]` and ran `setLoading(false)`
regardless, so both header badges were computed from rows that never arrived:

|                        | healthy | read 403'd                      | ~10s later |
| ---------------------- | ------- | ------------------------------- | ---------- |
| "N connected"          | 1       | **0**                           | **0**      |
| "N tools available"    | 7       | **0**                           | **0**      |
| server names on screen | both    | none                            | none       |
| toast                  | —       | 3× "Failed to load MCP servers" | **gone**   |
| any error text         | —       | —                               | **none**   |

The interception was recorded (3 requests failed) rather than inferred. There
was also no empty state on this page at all, so a failed read produced two
confident zeroes above a completely blank grid.

**Zero is the worst possible wrong answer here, because it is also a perfectly
ordinary right one.** Nothing distinguished "you have no MCP servers" from "I
could not find out" — and this page's numbers feed a real decision, since an
agent author checks "N tools available" to see whether their tools are
reachable before blaming their prompt.

#### Why the four earlier conversions missed it

`lib/listClaim` answers "how many rows do I have" for a list with an empty
state. Neither badge here is the row count. They are **derived** — a filtered
length and a conditional sum — so no rule watching for `.length` was ever going
to see them, and a failed read makes both compute to 0 through entirely
innocent arithmetic.

`lib/countClaim` is the missing shape: label every count derived from one read
at once, and withhold them together. Together is the point — they come from the
same rows, so they are true together or unknown together, and labelling them
one at a time is how a page ends up admitting the failure in one badge while
printing a confident 0 in the one beside it.

The page now shows `—` for both when the read fails, an alert naming the reason
that says the counts are "unknown rather than zero", and a **Try again** button.
It also gained the empty state it never had, because otherwise the fix has
nothing to distinguish itself from: verified live, a genuinely empty account
reads "0 connected", "0 tools available" and "No MCP servers yet", while a
failed read reads "—", "—" and the alert. Try again was exercised rather than
assumed — fail, heal, click, back to 1 and 7 with the alert gone.

#### The pin was decorative, and the mutation run is the only reason that is known

Adding the row and running four mutations killed **one of four**. Deleting the
`setLoadError` so the error was toasted and never recorded — the exact defect —
survived. So did replacing the labels with the raw counts, and so did dropping
the line that clears the error on success.

The row had been pinned against `listClaim`, which the page still called for
its panel, so every rule passed while the badges lied again. A pin that names a
helper the file happens to contain proves nothing about the thing that broke.

Three changes came out of that, each mutation-verified:

- the counts moved into `countClaim`, a real function with its own tests, so
  the decision is covered at the logic level rather than by inspection;
- **an error state must be recorded from a real value, not only cleared** —
  `setLoadError(null)` on its own is not recording anything;
- **an error state must also be cleared on success** — otherwise a recovered
  page keeps showing a failure that is over, and Try again appears dead.

A fourth followed: `claim` may now name more than one helper, because this page
guards its badges with `countLabels` and its panel with `listClaim`, and
dropping either one restores a defect. Pinning only the one I had just added
left the other unguarded, which the mutation run caught immediately.

Second pass: **8 of 8 killed.**

**Fixtures:** two `mcp_servers` rows inserted directly rather than through the
Add dialog, because that flow probes a live external MCP endpoint and would
have made the test depend on somebody else's uptime. Deleted afterwards and
`mcp_servers` re-read at `*/0`.

---

### 2026-08-17 — Module 18, Secrets (`/secrets`)

Two findings, both about what this page says when the one read behind it does
not arrive. Everything it says when the read _does_ arrive is exact.

**What matched.** Two fixture secrets were created through the real dialog and
every rendered column was compared against `user_secrets`: names, descriptions,
the `Yours` / `Shared with you` badge (against `user_id === me`), the dates, and
the row count against an exact `0-1/2`. Ordering is by name and not by
insertion — proven by creating the alphabetically-first secret _second_ and
watching it render first. The `value` column is never sent to the browser at
all, which is the security claim the page makes in its own copy, checked
against the response body rather than taken on trust.

**Both failures were injected by making the real server fail**, not by
fabricating a response. The server function's reply is seroval-encoded, so a
hand-written envelope would have proved only that the client mishandles
malformed JSON. Instead the outgoing request's JWT signature was corrupted, and
the real handler's own catch returned its own envelope:

```
{"k":["ok","error"],"v":[{"t":2,"s":3},{"t":1,"s":"Unauthorized"}]}
```

`ok: false, error: "Unauthorized"`, produced by the server, serialized by the
real serializer. The corruption was recorded per-request, so the injection is
proven rather than inferred.

#### S1 · "No secrets yet" for an account holding two

`reload()` toasted the error and then ran `setSecrets([])`, so the failure
rendered as an empty account — on the page whose entire subject is credentials.
Measured at first paint and again after the toast expired:

|                                         | at first paint | ten seconds later |
| --------------------------------------- | -------------- | ----------------- |
| toast "Unauthorized"                    | present        | **gone**          |
| "No secrets yet."                       | present        | **present**       |
| "Create one, then paste its reference…" | present        | **present**       |
| rows                                    | 0              | 0                 |

This is module 15's shape exactly, and the second measurement is the reason
that method exists: the durable half of the contradiction is the false half.
The toast is also the least informative thing on the screen — a bare
"Unauthorized" with no indication of what could not be read.

It is S1 rather than module 16's S2 because this page says it in words. There
is a sentence claiming the account is empty and an invitation to create the
first secret, where /integrations only omitted a badge.

#### S2 · A rejected request left the skeleton up indefinitely

`reload()` had a `.then` and no `.catch`. supabase-js hands a network failure
back as `error`, but a **server function rejects**, and nothing was there to
catch it. With the request rejected outright:

```
{"skeletonUp":true,"anyErrorOnScreen":false,"toasts":[],
 "unhandledRejections":["TypeError: Failed to fetch"]}
```

still true four seconds in. No error, no toast, no empty state — just two
skeleton bars for ever, and an unhandled rejection in a console the user is not
reading. This page has no Refresh control, so there was no way to retry short
of reloading the browser.

#### Fixed with `listClaim`, and with a retry that was tested

The page now holds `loadError`, routes the panel decision through
`lib/listClaim`, and catches the rejection. Verified live in four states, each
with the injection confirmed by the harness:

| Condition                       | Panel                                                  |
| ------------------------------- | ------------------------------------------------------ |
| healthy                         | 2 rows, no alert                                       |
| server returns `ok:false`       | reason + "still there" + Try again, **no** empty claim |
| request rejected                | same                                                   |
| genuinely empty (after cleanup) | "No secrets yet." — the honest claim, still available  |

The last row matters as much as the others: the fix has to keep the true empty
state sayable, and the fixture cleanup doubled as that test.

A **Try again** button was added because the S2 left no way to retry, and it
was exercised rather than assumed: land in the failed state (0 rows, error
shown), heal the network, click it, and the panel returns to 2 rows with the
error gone. A retry control that is never tested is the dead control this
campaign keeps finding.

#### The mutation that survived, and why it is being recorded rather than fixed

Eight mutations, seven killed. The survivor replaced the `listClaim` call's
result with a short-circuit **while leaving the identifier in the file**, which
a source-inspection rule cannot see. Rewritten the way a real refactor would do
it — removing the call — it is killed.

That is a genuine limit of this test file rather than a fixable oversight, and
it is the limit the file already declares: it asserts by source inspection
because standing up a route component wired to Supabase and a session would
test the mocks. A rule that reads source can prove a call is present; it cannot
prove it is on the live path. Recorded here so the next person does not mistake
a green `failedReadClaims` for a behavioural guarantee.

Two new rules were added and both were mutation-verified: a row flagged
`viaServerFn` must catch a rejected read, and no file may empty its list
without setting an error beside it. The second exists because dropping the
`setLoadError` next to `setSecrets([])` restored the exact S1 above while the
suite stayed green.

#### Checked and not a defect

`reload()` returns early when `token` is undefined, which leaves the skeleton
up. That is honest — nothing is known yet — and it is transient: `token` is
`session?.access_token`, `reload` is a `useCallback` keyed on it, so the effect
re-runs the moment the session resolves. `user_secrets.updated_at` is
`NOT NULL DEFAULT now()`, so the unguarded `format(new Date(...))` in the
Updated column cannot be reached with a null.

**Fixtures:** two secrets created through the real dialog and deleted through
the real delete button, with `window.confirm` stubbed to return true because
the automation auto-dismisses it. Both confirm prompts named the right secret.
`user_secrets` re-read afterwards: `*/0`, no probe rows left.

---

### 2026-08-17 — Module 16, Integrations (`/integrations`) — RE-AUDITED

The module whose finding was withdrawn, done again with the proof that was
missing. **The withdrawal was correct and the original observation was also
correct** — what was missing was the link between them, and it turned out to be
mundane.

#### Why the injection did not fire, at last

The `window.fetch` patch was never off-path. It reaches this page's Supabase
client perfectly well; that was measured directly by logging every URL the
wrapper saw:

```
newlySeen: ["https://…/rest/v1/integrations?select=*"]
```

The mistake was in how the read was re-triggered. `loadIntegrations` runs in a
`useEffect(…, [])` and nowhere else on first paint — there is no Refresh
button on this page — so the obvious way to make it run again is to reload the
page. **A reload destroys `window`, and the patch with it.** The reads then
succeed, which is exactly what the probe reported.

That was reproduced deliberately rather than assumed. Arming the patch, setting
a `sessionStorage` marker, and reloading gives:

| After the reload        |                                    |
| ----------------------- | ---------------------------------- |
| `sessionStorage` marker | survived                           |
| `window.fetch` patch    | **gone**, `fetch` native again     |
| the page's own read     | `{integError: null, integRows: 3}` |

which is the earlier session's probe output, character for character.

Modules 13–15 were not luckier, they were differently shaped: each had an
in-page refresh path (a `refresh()`, a tab switch) that re-ran the read without
a document load, so the patch was still installed when it fired.

**The method that replaces it**, and that will be used for modules 18–31:
re-trigger the read with a **client-side remount** — `__TSR_ROUTER__.navigate`
away and back — which re-runs mount effects while leaving `window` intact. The
wrapper records every URL it sees and every URL it failed, so the injection is
confirmed by `failed` naming the request, never by what rendered. Every probe
below is reported beside the same measurement taken with the injection
disarmed, down the identical navigation path.

#### S2 · Both reads discard their error, so a failed read renders as an account with nothing in it

```ts
const [{ data: integ }, { data: creds }] = await Promise.all([…]);
```

No `error` is bound on either side, so there is nothing to report even if the
page wanted to. `data` is null on failure, `merged` stays `[]`, and every badge
on the page is derived from `merged`.

Measured, with a 403 injected on the `integrations` read alone:

|                        | injected 403 | control, same path |
| ---------------------- | ------------ | ------------------ |
| read intercepted       | 2            | 0                  |
| "Connected" on page    | **0**        | 2                  |
| "Disconnect" on page   | **0**        | 2                  |
| any error text on page | **none**     | —                  |

The account had Gemini and OpenRouter connected throughout, and the Gemini card
went from

```
Google Gemini | Gemini via Google AI Studio native API. | Connected | Configure | Disconnect
```

to

```
Google Gemini | Gemini via Google AI Studio native API. | Configure
```

A connected provider rendered exactly as one that was never configured, beside
a Configure button. The obvious response to that screen is to paste the API key
in again. Failing the sibling `provider_credentials` read instead produces the
same screen, so either half of the merge can cause it.

**On the severity, which is deliberately lower than the retracted claim.** The
withdrawn finding called this S1. It is S2. This page has no count and no empty
state — nothing on it prints a number, and there is no "you have no
integrations yet" sentence anywhere. The page's only vocabulary for connection
status is a badge, and what a failed read produces is its _absence_. That is
squarely "hides something true (silent failure, swallowed error, misleading
empty)" and it is not "states something false", which is what separated modules
13–15, where the screen said `My skills (0)` and "You haven't created any
skills yet" in so many words. The user-visible consequence is much the same;
the scale is only worth having if it is applied rather than recited.

#### Fixed, and the fix names the reason

`lib/integrationStatusClaim` is the badge-shaped equivalent of `lib/listClaim`:
a connection badge is a claim only a successful read may make. It adds the
state the page had no way to express — `"unknown"` — which before this existed
could only be rendered as `null`, the same thing an unconfigured provider
renders.

`mayOfferDisconnect` is separate from the badge on purpose. Disconnect is a
**write**, and on a failed read `disconnectProvider` resolves `existing` to
undefined and silently returns — a dead control rather than an honest refusal.

Verified live in both directions, three ways:

| Condition                       | Page                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| healthy                         | 2 Connected, 2 Disconnect, no notice, no "Status unknown"          |
| `integrations` read 403         | 0 / 0, 14 "Status unknown", notice naming the reason, `role=alert` |
| `provider_credentials` read 403 | same                                                               |
| restored                        | back to 2 / 2, notice gone                                         |

The notice says the credentials are still there, which is load-bearing copy
rather than politeness: the failure being fixed is a user concluding their keys
are gone and retyping them.

#### A hypothesis that was wrong, and checked before it was believed

The suspicion worth having here was that the failed read corrupts a **write**:
`saveProvider` resolves `const existing = integrations.find(…)` from the same
emptied state and passes `id: undefined`, which looks like it must insert a
duplicate row. It does not. `saveIntegrationForUser` falls back to a singleton
lookup by `(user_id, type, provider)` when no id is passed, and updates the row
it finds — the code says so, and says the unique indexes are "the backstop, not
the mechanism". Recorded because it was a good guess that reading the server
function disproved in a minute.

The neighbouring write paths were checked for the same reason and are also
safe: `saveGateway` refuses a blank base URL, and `saveNotifChannel` refuses a
blank webhook with no `existing`, so neither can overwrite a real config with
the blank form a failed read leaves behind. What they _do_ lose is the "leave
blank to keep the saved key" affordance — the page tells the user to paste in a
URL it already has — which is the same defect wearing different clothes and is
fixed by the same notice.

#### The mutation that survived, which is the point of doing this

The first mutation run killed 13 of 14. The survivor was the one that matters
most: reverting integrations.tsx to `setReadState({ loaded: true, error: null })`
— **the exact defect this module fixed** — and the whole suite stayed green.

`failedReadClaims.test.ts` asked only that a setter _name_ appear in the file,
and the mutant still contained `setReadState`. A rule satisfied by the presence
of an identifier is satisfied by a page that binds the error and throws it
away. A fourth rule now requires that every error the file names is referenced
again, which is the campaign's defect stated in one line: **an error you
destructure and never mention again is an error you discarded.** It holds for
all five pinned files and kills the mutant.

This is the third rule in this campaign to be wrong on its first draft. The
first two cried wolf at correct code; this one waved a defect through. Both
directions are worth the same amount of suspicion.

**Tests:** 18 in `tests/unit/integrationStatusClaim.test.ts`, plus
`failedReadClaims.test.ts` 13 → 21 (one new row, and the fourth rule applied to
all five). Mutation-verified **14/14**, each applied, confirmed on disk, killed,
restored, restore confirmed, with a clean run after. No fixtures: this pass
read the database and never wrote to it.

---

### 2026-08-17 — Module 17, Web Embedding (`/embeds`)

No findings. Recorded in full because a page that passes deserves the same
evidence as one that fails — otherwise "we checked it" means nothing.

**Counts are exact.** `embed_keys` holds 5 rows; 5 render. Names, resource
types and allowed-domain lists match one for one, and the USES column matches
`use_count` exactly (3 / 1 / 19 / 1 / 4).

**The security claims hold, and were tested rather than read.** The page
promises "disable the key and every iframe stops instantly", and each gate was
exercised against the live `/api/embed/chat` endpoint with a working control:

| Key state                        | Endpoint                                         |
| -------------------------------- | ------------------------------------------------ |
| active, no expiry (precondition) | 200, streaming                                   |
| disabled via the real UI toggle  | 403 "This embed has been disabled by its owner." |
| expiry lapsed, still active      | 403 "This embed key has expired."                |
| expiry set to 2099               | 200, streaming                                   |
| domain allow-list, honest origin | 403 "not authorized for this site"               |
| unknown key                      | 400 "Invalid embed key."                         |
| restored to baseline             | 200, streaming                                   |

The lapsed-expiry case is the interesting one: the key was left **active** so
the 403 could only come from the expiry gate, and the message differs from the
disabled one, which proves which check fired. A future expiry still returns
200, so the gate is not simply refusing everything.

**A first attempt at this test was invalid and was thrown away.** The initial
run sent `key` instead of `embedKey`, so all three cases — including the
control — returned 400 "Invalid embed key." Three identical refusals look like
a working boundary; they were a malformed request. The rule that saved it is
the control: a test where the _should-succeed_ case also fails has measured
nothing.

**A near-miss worth recording.** Calling the domain-locked key while forging
`parentOrigin: https://example.com` returned 200, which looked like an
allow-list bypass. It is not: the request came from the app's own origin, and
`embedOrigin.ts` trusts `selfHost` deliberately so the embed page can call
home. That module already documents both halves candidly — what the browser
`Origin` check closes, and that it "does not close, and cannot", because
`Origin` is only trustworthy from browsers and the embed key is public by
construction. Abuse from a scripted client is bounded by per-key budget, rate
limit and expiry instead. A page whose residual limits are written down is the
opposite of the defect this campaign hunts.

**Fixtures:** one key was disabled and re-enabled, and its expiry moved twice.
Final state re-read and confirmed identical to baseline (`is_active: true`,
`expires_at: null`) with the endpoint back to 200.

---

### 2026-08-17 — Module 16, Integrations (`/integrations`) — RETRACTED

> **Superseded.** The module was re-audited later the same day and the finding
> holds, at S2 rather than S1 — see the module 16 entry at the top. This entry
> is kept unedited because the reasoning that led to the withdrawal is worth
> more than the conclusion it reached.

**A finding was reported here and then withdrawn. It is kept because a
campaign that quietly deletes its mistakes is not evidence of anything.**

The claim was: with the two integration reads failing, a page whose account has
OpenRouter and Gemini connected rendered zero "Connected" badges, zero
Disconnect buttons and no error — an S1, and on a page where the natural
response is to paste an API key in again.

A fix was written for it and did not change the rendering. Restarting Vite,
clearing its transform cache, unregistering the `sw.js` service worker and its
`as-static-v1` cache, and finally a fresh tab with an empty module registry all
failed to make it fire — while the served component chunk demonstrably
contained the new code.

A `console.log` inside `loadIntegrations` settled it:

```
PROBE loadIntegrations {integError: null, integRows: 3, credsError: null}
```

**The reads had succeeded.** The `window.fetch` patch never reached this page's
Supabase client, so the original observation had no established cause and the
fix had no error to report. The fix was reverted; the finding is withdrawn.

Why the same injection worked on modules 13–15 is still unexplained. Those
results stand on their own evidence: there, the injected error _changed the
UI_ — badge to "—", banner appeared — which cannot happen unless the error
reached the code. That asymmetry is the lesson.

**Method change, now in force:** a failed-read finding requires positive proof
that the injection took effect — the code visibly reacting to the error, or a
probe of what the read returned. Inferring it from what rendered is what went
wrong here, and it is exactly the mistake this log exists to catch elsewhere.

Module 16 is therefore **unaudited**, not clean.

---

### 2026-08-17 — Module 15, Skill Library (`/skills`)

"Sample skills (6)" matched the six declared in `lib/sampleSkills`, six unique
ids, no duplicates. One finding, and it is the third page in a row with it.

#### S1 · The error was raised and then overwritten

`refresh()` toasted the error and then ran `setMine((data ?? []) as SkillRow[])`
**anyway** — on the failure path, unconditionally. So a 403 gave "My skills
(0)", "You haven't created any skills yet." and "Create your first skill".

This one was measured twice on purpose: at first paint, and again seven seconds
later once the toast had expired. The false claim was still there; the true one
was not. That is the whole reason a toast does not discharge this duty — it is
the only page element that is guaranteed to be gone by the time someone reads
the page.

Converted to `listClaim`, and verified in both directions: with the read failing
the tab reads `My skills (—)` with the reason and no invitation; healthy, it
reads `My skills (0)` with the honest empty state and no error.

#### A guard for the conversions, deliberately a list and not a rule

Three modules have now converted a page away from this defect, and the sweep
says roughly two dozen more reads could still have it. `failedReadClaims.test.ts`
pins the ones already converted: each must route its count through `listClaim`,
must keep the read's error, and must not print a fetched collection's raw
`.length` as its count.

It is a **list** rather than a rule over every page, because asserting it of
pages nobody has measured would fail for about twenty of them at once, and a
suite that is red by default teaches people to skip it. A row gets added when a
module's pass converts a page.

The first version of that third rule flagged `BUILT_IN_PROMPTS.length` and
`SAMPLE_SKILLS.length` — module constants that ship with the app and cannot
fail to load, so printing their length is entirely honest. It now requires a
lowercase first letter, which exempts SCREAMING_SNAKE constants by
construction. This is the second rule in this campaign to have cried wolf at
correct code on its first draft; both times the fix was to narrow the rule
rather than to weaken what it protects.

Verified by reverting each of the four conversions in turn — all four caught,
all four restored.

**Tests:** 13 in `tests/unit/failedReadClaims.test.ts`. Full suite 3912 tests,
211 files, green (+13, exactly the new file). No new pure module was needed:
the fix reuses `listClaim`, which already carries its own mutation coverage.

---

### 2026-08-17 — Module 14, Prompt Library (`/prompts`)

Both counts on this page were right. "Built-in (23)" matched the 23 prompts
declared in `lib/promptLibrary` (23 `id:` entries, 23 unique, no duplicates),
and "My Prompts (0)" matched an exact `*/0`. The four samples-style claims all
held. Two things did not.

#### S1 · A page that said both "you have none" and "the load failed"

`loadUserPrompts` DID check its error — better than the notebooks module, which
discarded it — but it only raised a toast and returned, leaving `userPrompts`
at `[]`. With a 403 on that one query the page rendered, all at once:

| Element | Said                                 |
| ------- | ------------------------------------ |
| Tab     | **My Prompts (0)**                   |
| Panel   | "You haven't saved any prompts yet." |
| Button  | "Create your first prompt"           |
| Toast   | "Failed to load your prompts"        |

The page contradicted itself, and the durable half was the false half: the
toast fades after a few seconds and the empty state does not. A user who looked
away, or came back to the tab, was left with an account that appeared empty and
an invitation to start over.

Fixed through the same `listClaim` the notebooks list uses — the tab reads
`My Prompts (—)` and the panel carries the reason and "Any prompts you have
saved are still there."

#### S3 · The tag the cards print, that the search box could not find

Every card renders its tags as `#{t}`, so the screen shows `#security`. The tag
is stored and matched as `security`. Measured in the live page:

| Typed       | Cards |
| ----------- | ----- |
| `#security` | **0** |
| `security`  | 1     |

Copying what the page shows you into the page's own search box returned nothing
out of 23. This is the module 11 shape again — _the identifier a page publishes
that its own search cannot find_ — and it is the reason that entry got a name.

A leading `#` now means "this is a tag" rather than being taken literally. Only
the first one, and only at the front, so `C#` still searches for `C#`.

#### The two filters that were one filter

`filteredBuiltins` and `filteredUser` held the same matcher twice, identical
apart from `description` being optional on a saved prompt. That is the shape
that drifts — fix the search on one tab and the other keeps the old behaviour
with nothing to notice it — so both now call `matchesPromptQuery`. Verified on
both tabs against a real saved row: `#probe` and `#adversarial` found it.

#### Not a defect: delete appearing to do nothing

The first delete click did nothing. `deletePrompt` guards on `confirm()`, and
the automated browser auto-dismisses a native confirm, so it returned false.
Recorded because it looked exactly like a dead control for one screenshot.

#### Campaign note: the failed-read class is systemic

After module 13 the same pattern was swept for rather than rediscovered
page by page: **43 reads across 27 files** destructure only `data` from a
Supabase call, and `data` is null on failure. Not all are dangerous — many have
a benign fallback — but each one that feeds a count or an empty state is this
same defect. They will be verified and fixed per module with live evidence
rather than bulk-edited on inference, which is why this is a note and not a
finding.

**Tests:** 21 in `tests/unit/promptSearch.test.ts`, mutation-verified 10/10 —
each applied, confirmed on disk, killed, restored, restore confirmed. Full
suite 3899 tests, 210 files, green (+21, exactly the new file). One fixture
prompt was created through the real dialog and deleted through the real delete
button; removal verified by id and by the table returning to an exact `*/0`.

---

### 2026-08-17 — Module 13, Developer workspace (`/notebooks`)

Four findings, and they are the same finding four times: **every read on this
page treated its own failure as a fact about the account.** No arithmetic was
wrong here. The notebook count badge matched an exact PostgREST count
(`content-range: 0-2/3`) and the four samples on screen matched the four
declared in `lib/sampleNotebooks`. What was wrong is what the page says when it
does not know.

Each was measured by failing exactly one request in the live page and reading
what rendered — never by reasoning about the code.

**S1 — the notebook list called a refused read an empty account.**
`usePyNotebooks` destructured only `data`, and `data` is null on failure, so a
403 produced:

```
{"badgeText":"0","saysNoNotebooks":true,"anyErrorWordOnScreen":false}
```

for an account holding **three** notebooks. Badge `0`, the words "No notebooks
yet — create one to start experimenting.", and nothing anywhere on the page
indicating a failure. The invitation is the sharp edge: the page does not merely
withhold the notebooks, it tells the user their account is empty and offers to
start them over.

**S2 — the running-kernels panel vanished when the runtime was unreachable.**
`load()` collapsed both failure paths to `[]`, and the render hid the panel on
an empty list, so a 503 gave `{"panelVisible":false,"anyErrorOnScreen":false}`.
This panel exists for exactly one moment — you were refused a new kernel with
"you already have the maximum of N" and came to free a slot — so the failure
mode contradicted the only reason to be on the page. The Refresh button lives
_inside_ the hidden panel, so there was no way to retry either.

**S2 — the editor reported a failed read as a deleted notebook.** The load did
`if (!data) setNotFound(true)`, and the copy went further than absence:
"Notebook not found (it may belong to another account)." A network blip named a
cause it had no evidence for, to the owner of a notebook visible in the sidebar
one click earlier.

That page now also promises "It has not been deleted; nothing was saved over
it." That promise was **verified rather than assumed**: the read was failed, the
1200 ms autosave debounce was waited out, and all three notebook rows came back
byte-identical with `updated_at` unchanged and zero writes attempted. The guard
holding it up was one incidental condition in a `useEffect`, so it is now
`mayAutosave` — named, exported and mutation-covered, because the refactor that
defaults `cells` to `[]` instead of `null` would silently turn that sentence
into a lie.

**S3 — the publish dialog said "Loading…" for ever after a failed key read.**
Better than the others (it never claimed "No keys yet." for a notebook with live
keys) but it reported a finished, failed read as still in progress, with a toast
as the only signal. On a panel whose job is telling you which keys can reach
your notebook, that is not good enough.

**The rule extracted.** Two pure modules, because the same sentence kept needing
saying: `lib/kernelPanelState` (the panel's visibility and count) and
`lib/listClaim` (`listClaim` for count-and-empty-state, `mayAutosave` for the
write guard). One line each carries it — _an empty list is a CLAIM, and only a
read that succeeded is allowed to make it._

**A guard that reported a page for getting stricter.** Routing `notebooks.tsx`
through `listClaim` broke `emptyStateLoadGate.test.ts`, which recognises four
source shapes for "a load signal reaches the JSX" and now saw none — even though
the new code gates on the error _as well as_ the load, which none of the four
do. The right fix was to teach the guard the fifth shape, not to loosen it, and
that was checked in both directions: with the gate stripped from `notebooks.tsx`
and, separately, from `secrets.tsx`, the guard reported each one.

**Tests:** 31 across `tests/unit/kernelPanelState.test.ts` (13) and
`tests/unit/listClaim.test.ts` (18). Mutation-verified 19/19 — 6 on
`kernelPanelState`, 7 on `listClaim`, 6 on `mayAutosave` — each applied,
confirmed on disk, killed, restored, restore confirmed. Full suite 3878 tests,
209 files, green; the non-skipped total was checked against the previous run so
a silently-dropped test could not hide in it. No fixtures created, and all three
notebook rows verified byte-identical at the end.

---

### 2026-08-16 — Module 12, BI Workspace (`/bi`)

#### P1 · S1 · A four-page dashboard was advertised as having seven widgets

Every project card prints "N widgets · M views · updated …". The view counts
and timestamps all matched `view_count` and `updated_at` exactly. The widget
count did not.

`BiDashboardRow` documents the rule in the type itself: _"pages — Source of
truth for the dashboard's content; top-level widgets/layout mirror page 1."_
The card counted `parseWidgets(d.widgets)` — the mirror.

Measured across all eleven projects on the account:

| Dashboard               | Card said | Truth  | Pages |
| ----------------------- | --------- | ------ | ----- |
| **Formula 1 Analytics** | **7**     | **15** | **4** |
| Every other project     | correct   | —      | 1     |

Formula 1 holds 7 + 4 + 4 + 0 across its four pages. The other ten have one
page each, so `pages[0]` and the mirror are the same list and the count was
right **by accident everywhere it was checked** — which is why a page whose
whole job is telling projects apart had been understating its largest by 53%
without anyone noticing.

The bias is the familiar shape: never too high, always too low, and it only
goes wrong once someone adds pages — the very thing that makes a dashboard
substantial. `dashboardSize` now counts through `parsePages`, so a
pre-multi-page row still collapses to its single page exactly as the editor
sees it rather than being special-cased twice. The card also shows the page
count when there is more than one; its absence is what let a four-page
dashboard read like a small one.

Verified live: Formula 1 now reads **"15 widgets · 4 pages · 29 views"**, every
single-page project unchanged.

`tests/unit/biDashboardPages.test.ts` (+6 → 13) — the file that already guards
this exact mirror-vs-source invariant for writes, now guarding it for reads.
Mutation: count `pages[0]` only → 1 fails.

#### Note: a generated file lost a route mid-edit

`src/routeTree.gen.ts` came back 21 lines shorter, with the `/bi` route gone —
the dev server regenerated it while an edit had `bi.tsx` transiently
unparseable, and `tsc` then failed in four unrelated files. Restored from git.
Worth recording because the symptom (type errors about `"/bi"` in
`dashboard.tsx`) points nowhere near the cause.

### 2026-08-16 — Module 11, Metrics (`/metrics`)

Everything the page computes was checked against the database and matched
exactly: **23 metrics in 3 models · 0 certified · 23 draft · 0 deprecated**
(7 + 6 + 10 across the three models, all draft), and the freshness stamps —
27d for `saas_sales`, 9d for the other two — matched `data_loaded_at` to the
day. The usage claim was checked too: all 11 dashboards scanned, none
references any of the three models, so "No dashboard widget references it" is
true. The two findings are both about what the page says when it cannot see
everything.

#### P1 · S2 · The identifier the page publishes was not searchable

Every card prints `saas_sales_model.total_sales` as the metric's identity. It
is the form the compiler resolves and the form a colleague pastes. Typing that
exact string into the page's own search returned **nothing** — and the empty
state then said:

> Nothing matches "saas_sales_model.total_sales". Synonyms are searched too, so
> a metric with no match here **genuinely has none of these words**.

The metric has exactly those words; the page had just rendered them. This is
not a missing feature but a false statement, in the one sentence written to be
trusted.

`matchesQuery` tested each field independently, so `saas_sales_model` found ten
metrics and `total_sales` found one while the qualified form found none. Adding
`qualifiedName(m)` to the searched list fixes it, and the partial forms fall
out: `saas_sales_model.` finds ten, `.total_sales` and `model.total` find their
metrics, and `hr_roster_model.total_sales` correctly finds nothing. The route
now renders `qualifiedName(m)` too, so the published string and the searched
string cannot drift.

#### P2 · S2 · The usage scan could be cut short without saying so

This file's header names the expensive mistake outright: _"deprecating a metric
on the strength of an incomplete scan"_. Its disclosure names threads and
embeds as unscanned. It did not name the ceiling on the scan itself.

All three reads were bare selects. `lib/pagedSelect` documents, from a
measurement against this instance, that PostgREST caps a response at 1000 rows
silently — the same cap that made the dashboard's spend panel report $1.84 for
a $5.77 window. The bias is what matters: truncation only ever REMOVES
references, so a capped read pushes every metric toward "no widget uses this" —
the one direction that gets a metric deprecated.

Not reproducible on this account (11 dashboards, 3 models, 33 tables — every
read complete, confirmed against exact counts), so this is a latent defect
reported on the repo's own evidence rather than a wrong number observed. The
reads now page, `describeUsage` takes the truncation flag, and a cut-short scan
says "treat this as unknown" instead of reporting a clean absence. A truncated
POSITIVE result is kept but reported as a floor — a partial scan can still
prove use, it just cannot prove the count.

`tests/unit/metricsCatalog.test.ts` (+9 → 38). Mutations: drop the qualified
name from the search fields → 2 fail; report a truncated scan as clean → 1
fails.

#### One hypothesis dropped

`dataFreshness` resolves the dataset by NAME while the model also carries a
`table_id`, which looked like the "diff two lists that should match" class —
rename the dataset and freshness silently becomes "unknown". There is no
dataset rename anywhere in the product, so the scenario is unreachable; and for
the reachable case (delete and re-upload under the same name) the name lookup
is the more robust of the two. Left alone.

### 2026-08-16 — Connector operations: re-sync, schedule, disconnect

Requested rather than found, but two of the four were defects.

#### R4 · S2 · A connected source could show no sign of being connected

The provider card's "Connected" badge was keyed off
`last_sync_status === "ok"`. A source that was connected but had never synced,
or whose last run failed, showed **no badge at all** — indistinguishable from
one never set up. The card also had no way to disconnect: the only path was the
trash icon in the table below, which is not where anyone looks after reading
"Connected".

Connected now means a connection row exists, with the count when there are
several. Sync health is a different question and stays where it is answered per
row. Disconnect is offered on the card only when there is exactly ONE owned
connection for that provider — with several, a card-level button would have to
guess which, so the per-row buttons remain the only way to say it.

#### R5 · S3 · The disconnect warning could not tell you what it cost

It said credentials are deleted and "datasets already synced are KEPT", which
is true and unhelpful: the reader cannot tell whether that means one table or
forty, and nothing mentioned that scheduled syncs stop. `saas_connection_id`
(R3) makes the number available, so `listSaasConnections` now returns
`dataset_count` and the dialog states both halves — what stops, and what stays,
with the count. A failed count leaves the field UNDEFINED and the dialog falls
back to its general wording: printing a confident "0 datasets" because a query
failed is how someone deletes a source believing it had none. A shared source's
datasets belong to its owner and are invisible to the grantee's read, so those
rows are left uncounted for the same reason.

Verified live: the dialog reported **7 datasets** for `sftest`, matching the
attribution exactly.

#### Re-sync and schedule, wired to the same server functions

The catalog's SaaS rail entries now carry the crawled sources' affordances —
status dot, schedule clock, and a menu with Re-sync now / Schedule / Manage
connection. Both actions call the SAME server functions the Integration Hub
calls, which is what makes a sync started in one place visible in the other:
measured end to end, a re-sync run from the Data Catalog moved the Hub's "Last
sync" from 16 Aug 20:45 to **21:39**, and a cadence changed from the catalog
menu read back as "Every hour · Next in 59 min" on the Hub.

`setSaasSchedule` is a new server function rather than a call to
`saveSaasConnection`, which re-encrypts the whole config: changing a cadence
through that one would demand the credential again and stamp
`credentials_rotated_at` on a change that rotated nothing. It is owner-only —
a grantee may run a sync, but changing the cadence spends the owner's API quota
on the owner's account. A manual run deliberately does NOT move `next_sync_at`;
the scheduled slot is the owner's setting, not a side effect of a button.

`scheduleSummary` is the pure part, and its rules are all about the case where
a cadence is set and the run is **not** coming: an overdue `next_sync_at` reads
"Due now" rather than a countdown, a cadence with no due time is flagged
(the scheduler's claim query can never match it, so it will never run again),
and a manual source with a leftover due time is flagged too.
`tests/unit/saasScheduleSummary.test.ts` (12). Mutations: render overdue as a
countdown → 2 fail; report a missing due time as healthy → 1 fails.

#### Process note: I overwrote an existing test file

Writing `tests/unit/saasSchedule.test.ts` destroyed 145 lines covering the
scheduler's atomic claim, its tenant scoping and its migration constraints. The
full suite still passed — it was 4 tests SHORT and nothing said so. Caught by
comparing the run's totals against the previous run rather than reading
"passed". Restored from git; the new cases live in
`saasScheduleSummary.test.ts` beside it.

### 2026-08-16 — Reported from use: Salesforce connector → BI dashboard

Not a module sweep. Three things reported from a real session, chased with the
same method.

#### R1 · S1 · A `(date)` column is physically text, and nothing said so

Generating a dashboard from a synced Salesforce `opportunities` table:

```
Binder Error: No function matches the given name and argument types
'date_trunc(STRING_LITERAL, VARCHAR)' ... GROUP BY DATE_TRUNC('month', CloseDate)
```

The obvious reading — bad catalog metadata — was wrong. `CloseDate` is typed
`date` and holds clean ISO values (`"2026-06-19"`). `duckType()` maps
`date → VARCHAR` **deliberately**, in both engines
([browserDuckdb.ts:202](../src/lib/browserDuckdb.ts), [duckdb.server.ts:228](../src/utils/data/duckdb.server.ts)),
because values arrive in mixed formats and a failed CAST would drop the row
rather than the value. So the storage was deliberate and the schema description
was accurate; **the sentence connecting them did not exist**. Neither
`biAgent.ts` nor `aiAnalyst.ts` contained `CAST`, `TRY_CAST`, `::DATE` or
`strptime` anywhere.

Measured across the 254 saved widget queries on this account: six use a date
function, **four cast and two do not**. The model was coin-flipping on a rule
nobody had stated.

Fixed in `describeSchema` — shared by the BI agent and the AI Analyst — as a
rule that appears only when a date column is actually present, and that says
plain grouping needs no cast so it does not over-correct.
`tests/unit/schemaDateCast.test.ts` (7). Mutation: change the trigger condition
to `"string"` → 6 of 7 fail.

#### R2 · S2 · A recoverable engine error ended the widget

Verifying R1 end to end: twelve widget plans, eleven built. "Quarterly Win Rate
by Close Date" died on `STRFTIME(CAST(CloseDate AS DATE), '%Y-Q%q')` — DuckDB
has no `%q`. The cast was right; the format specifier was not.

`buildSqlPrompt` has supported a repair pass since it was written, and
`aiAnalyst.ts:1099` uses it — its comment even reads _"One repair pass with the
engine's own error, like the BI analyst."_ **The BI analyst had no such pass.**
`runBiTurn` executed once and went straight to `status = "error"`, so a mistake
the model fixes on sight cost a whole widget.

Given one pass, the same model produced
`EXTRACT(QUARTER FROM CAST(CloseDate AS DATE))` and the widget built and
rendered. When the retry also fails, `repairFailureMessage` reports **both**
errors and says a retry happened — one message reads as a single failed query
and hides that the model was already shown its mistake.
`tests/unit/biSqlRepair.test.ts` (9). Mutation: return only the second error →
2 fail.

Worth recording that the drop was _disclosed_: the dialog already toasts
`Added 11. 1 couldn't be built (…) — <error>`. The defect was giving up early,
not lying about it.

#### R3 · S3 · Seven Salesforce tables filed under "Local tables"

Connector-synced datasets land in `user_data_tables` exactly like an upload —
deliberately, so a synced dataset cannot behave differently to an uploaded one.
The Data Catalog therefore filed them under the only thing it knew: local
storage. True about the bytes, useless as an answer to "where did this come
from", which is the question the rail exists to answer.

The provenance was already written — `source_filename` holds
`"Salesforce · opportunities"` — but as text for a human to read. Parsing that
string back into structure would be inventing the fact; the connection id **is**
the fact. Migration `20260832000000` adds `saas_connection_id` / `saas_stream`,
backfilled by matching on both signals the sync already writes (7/7 attributed,
0 orphans). `ingestRows` and `promoteStaging` now persist it — including the
**replace** branch, the re-sync case that would otherwise never receive it.

Storage did not move. Only what the catalog can say about it changed.

`src/lib/catalogSources.ts` is the mapping, and its load-bearing rule is the
one for a source it _cannot name_: a dataset whose connection row is missing
falls back to "Local tables" rather than to a source id with no rail entry,
because an asset filed under a category that does not exist disappears from
every filter except "All". `tests/unit/catalogSources.test.ts` (11). Mutation:
drop the `known.has(connId)` guard → 2 fail.

Verified live: rail reads `All assets 113 · Local tables 26 · sftest 7 ·
My Snow 80` — 26 + 7 + 80 = 113, and no `sftest_*` row remains under Local. A
synced table's format now reads `table · salesforce` rather than
`table · csv`, which was the same mistake in miniature.

Re-sync verified by writing NULL over `sftest_accounts`' attribution and
running a real connection sync: the write path restored it
(`last_sync_status: ok`, 7 streams, 24s). Probe dashboard deleted, confirmed
gone.

### 2026-08-16 — Module 10, Semantic Layer (`/semantics`)

#### The hypothesis that was wrong, kept because it nearly shipped

The opening move was: certification is gated on clean validation, so does the
badge survive an edit? The save path's UPDATE payload contains name, joins,
dimensions, metrics, assertions, grain — and **not** `status`, `certified_by`
or `certified_at`. Two UI tooltips promise "editing the definition drops this
back to draft". That looked like a false promise and a badge outliving what it
vouched for: the strongest possible finding in this product.

**It was wrong.** `trg_semantic_decertify` (migration 20260820000000) is a
BEFORE UPDATE trigger doing exactly that, placed in the database deliberately
so no write path can skip it. The application omitting `status` is correct —
the trigger is the stronger place for it.

Recorded because the only thing standing between that and a confidently
reported non-defect was checking the alternative explanation. This schema
already uses triggers for version history and audit; not looking would have
been an easy, plausible mistake.

#### P1 · S1 · The decertify trigger watched nine fields; the save path writes fifteen

Diffing the two lists is what turned the wrong hypothesis into a real one. Six
definition fields were written and unwatched:

| Field                     | What changing it does                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `table_id`                | repoints the model at a **different local dataset** — the local twin of `source_table`, which _was_ watched |
| `rollups`                 | aggregate awareness sends the query to a different summary table                                            |
| `calendar`                | redefines what a fiscal period contains (4-4-5)                                                             |
| `fiscal_year_start_month` | changes what "Q1" means, so every fiscal-grain query returns different numbers                              |
| `parameters`              | declared defaults feed computed values and what-if baselines                                                |
| `hierarchies`             | declared drill paths                                                                                        |

The first four **change numbers**. A model could be certified, repointed at
another dataset or given a different fiscal year, and keep a badge whose entire
meaning is "every validation check passed against the live source" — the exact
failure the trigger exists to prevent, reached through a column it did not
happen to name.

`label` and `description` stay excluded, for the original's stated reason:
renaming a display label does not change what "revenue" computes.

Migration `20260831000000_semantic_decertify_full_definition.sql`, applied to
the live database and **proven in both directions** against it:

| Step                                      | Result                       |
| ----------------------------------------- | ---------------------------- |
| create                                    | `draft`                      |
| certify                                   | `certified`                  |
| change **only** `fiscal_year_start_month` | `draft`, `certified_at` null |
| re-certify, change **only** `label`       | stays `certified`            |

The second row is the fix firing; the third is the control proving it does not
over-fire on metadata. Probe model deleted, 0 rows left.

Latent on this account — all 3 semantic models are `draft`, so nothing was
mis-certified in practice. Live for anyone using certification.

### 2026-08-16 — Module 9, Data Catalog (`/data-sql`)

#### N1 · S1 · Every local dataset claimed it was crawled seconds ago

The asset drawer rendered
`Crawled {formatDistanceToNow(new Date(asset.last_crawled_at))}`, and the local
mapping set `last_crawled_at: new Date().toISOString()`. So **every** local
table reported "Crawled less than a minute ago".

Measured: 26 tables whose real `data_loaded_at` runs from **2026-07-20 to
2026-08-07** — up to 27 days stale, every one of them displayed as fresh. The
true value was one column away in the same row.

Two errors in one line, worth separating because they have different fixes:

- **A timestamp was invented** where a real one existed.
- **The verb was wrong.** An uploaded CSV was never "crawled". And a warehouse
  table is queried in place and never loaded here at all — for that one there
  is no local timestamp, so the honest output is to say so rather than
  manufacture one.

`last_crawled_at` is now nullable end to end, which is what stops the gap being
filled by invention. `data_loaded_at` and `parquet_bytes` are carried through
`DatasetMeta`; tsc found all five construction sites, and each got the value
that is actually true there — "now" only where rows had just been written, null
for warehouse tables.

Verified live: `hr_dept_monthly` now reads **"Data loaded 9 days ago"**
(`data_loaded_at` 2026-08-07, today the 16th).

#### N2 · S3 · A known size displayed as unknown

`size_bytes: null` was hardcoded in the local mapping while `parquet_bytes` sat
unread on the row. `summary_segment_data` had **83,651 bytes** recorded and its
SIZE column showed "—". Now reads **81.7 KB**.

#### Checked and found honest

The stale row-count problem was already found and fixed, with the reasoning in
the code: local assets go stale within a session, so `reloadLocal` re-reads them
rather than trusting the mount-time snapshot. The comment records the observed
symptom — "a dataset replaced with 10 rows still read ROWS 364".

**Tests:** 8 in `tests/unit/catalogFreshness.test.ts`, mutation-verified — four
reversions, all killed, including a restore of the invented timestamp.

### 2026-08-16 — Deferred live verification (cap raised to $20)

The budget cap was raised from $5 to $20, so the work Modules 4, 5 and 8 had to
skip was run for real. Spend at the time: $5.95 of $20.

#### M4 · The empty-retrieval fix, exercised end to end

Three turns against an agent with a knowledge base attached:

1. **"What is the refund policy for AgentSwarms subscriptions?"** — retrieval
   returned 5 citations, so this exercised the pre-existing non-empty path. The
   agent refused to invent a policy, named what the knowledge base _does_ cover,
   and pointed elsewhere.
2. **"What is our parental leave entitlement in Portugal?"** — also matched
   citations. Worth recording: the document-level keyword fallback has **loose
   recall**, matching an unrelated blog document on common terms. Not a defect
   (recall over precision is the right bias for a fallback) but it makes the
   empty branch rare in practice on a populated KB.
3. **A Portuguese-language question** with no term present in an English
   corpus — **zero citations**, the empty branch. The model answered that it did
   not have access to that data, named what it _did_ have, and fabricated
   nothing.

**What this proves and does not.** It proves the empty path executes cleanly
after the change and the model does not confabulate. It does **not** prove the
new prompt text was the decisive cause — one sample against a capable model that
might have said the same thing regardless. Causation would need an A/B, and
n=1 per arm of a non-deterministic model would not settle it either. The unit
tests prove the instruction is present; this proves the path works.

#### M5 · PII redaction genuinely fires

No existing agent had guardrails switched on, so a disposable probe agent was
created with `piiMode: "redact"` rather than mutating a real one. Sending an
email address and a card number through `/api/chat`, the model replied:

> "I can't repeat that message exactly as written because it contains
> **redacted sensitive information placeholders**."

Neither the real email nor the card reached the model. The agent had been told
to echo verbatim, which is what makes the reply evidence rather than inference.
Probe agent deleted afterwards; its traces are left in place because they are
real spend and belong in the ledger.

#### Correction carried into Module 3

Reading those guardrails is what exposed the overstatement corrected in the
Module 3 entry above — 18 guardrail _keys_, nearly all off, cited as if they
measured lost protection.

### 2026-08-16 — Module 8, AI Analyst (`/ai-analyst`)

**No defect found.** Recorded in full because a log that only lists faults says
nothing about where the ground is solid, and because "I looked and found
nothing" is only useful if it also says _where_ it looked.

This module was built most recently and with these invariants stated up front,
and it held under exactly the lens that broke the six before it.

#### What was attacked, and what held

- **The verdict fingerprint.** `fingerprintSteps` pins each step's `sql` plus
  the governed model that compiled it. Row filters and rollup routing compile
  _into_ the SQL, so a change to either moves the fingerprint and voids the
  verdict. `verificationStatus` recomputes and compares on every read rather
  than trusting a stored flag.
- **Verifying nothing.** `markTurn` refuses a turn with no steps — "a turn that
  never produced steps has no analysis to have checked" — so a verdict can
  never be minted against an empty analysis.
- **Prior-verdict matching.** `normaliseQuestion` only lowercases, strips
  punctuation and collapses whitespace. Deliberately crude, with the reasoning
  written down: a false match is a false claim that someone checked it, a miss
  costs nothing. Empty question returns null rather than matching every other
  empty one. Only `active` verdicts are offered, newest first, so a later
  "wrong" beats an earlier "verified".
- **The export.** `analystExport` calls `verificationStatus` and
  `describeVerification`, so a void verdict travels as _"a verdict was
  recorded… but a step has changed since — it no longer applies"_ rather than
  as a bare "Verified". The artifact that leaves the building carries the
  caveat.
- **Scenarios.** A what-if adds SQL the verifier never saw, which under this
  campaign's own rule looked like a scope mismatch. It is not: the block is
  amber, labelled "not measured data; what the numbers would be under this
  assumption", kept beside the measured result and never folded into the
  findings. Calling it a defect would have been manufacturing one.
- **The "empty means something" lens** (the class named in Modules 3, 5 and 7)
  found nothing here. Every empty case — no steps, no verdict, no question —
  is handled explicitly.

#### Verified against real data

The one live thread has 7 turns. Two carry **zero steps** and both are
`status: "error"` with honest model-timeout messages, not silently empty
answers. The verified turn has 4 steps and a matching fingerprint.

#### Not covered, and why

No live analyst turn — spend is over the $5 cap. That leaves **untested**: the
reasoning loop end to end, self-check correction, clarifying questions, driver
analysis, forecast/anomaly computation, and parallel step execution. Zero
schedules and zero shares exist, so scheduled re-runs and sharing were read but
not exercised. These are gaps in the pass, not passes.

### 2026-08-16 — Module 7, MCP Builder (`/mcp-builder`)

#### L1 · S2 · The most powerful API key was the one with nothing written on it

The key list rendered its scope as:

```js
{
  k.tool_allowlist.length ? ` · ${k.tool_allowlist.length} tools` : "";
}
```

A key narrowed to three tools read "· 3 tools". A key that can call **every tool
the server exposes** read nothing at all. The proxy uses the same encoding —
`allowed.length > 0` is what gates `tools/call`, so an empty list is
unrestricted — but the screen inverted its meaning:

```
prod-key      abc123… · 42 calls              ← can call anything
readonly-key  def456… · 7 calls · 3 tools     ← can call three things
```

An operator auditing their keys saw the unrestricted one as the row with _less_
information rather than _more_ reach. Scope is now always stated, with the
unrestricted case in amber and a tooltip explaining it.

**Third instance of one pattern in this campaign.** Swarm import: an empty
`sql_table_names` meant every table. Model policy: an empty rule array meant
deny-all. Here: an empty allow-list means every tool. The encoding differs each
time; what repeats is a UI reading "empty" as "nothing worth saying".

Latent on this account — zero MCP keys exist — so it is correct by absence, not
by design. Same standing as K1 and J1.

#### Checked and found honest

`tools/call` **is** enforced, not merely filtered from `tools/list`: a
non-permitted name returns 403 with a message naming the tool. The list-side
fail-closed fix from earlier today is still in place.

**Tests:** 7 in `tests/unit/mcpKeyScope.test.ts`, mutation-verified — four
reversions, all killed, including a restore of the original blank label.

### 2026-08-16 — Module 6, Agent Swarms (`/swarms`)

#### K1 · S2 · The "deployed" badge was wired to a column nothing writes

`swarms.is_deployed` appears in the migrations only as `DEFAULT false`, is
**written by nothing anywhere in the application**, and is read in exactly one
place — the gallery badge. It could therefore never become true.

The consequence runs the other way from how it looks. This is not a badge that
lies; it is a badge that can never appear. A swarm with a live API key —
reachable from outside the app right now — showed nothing, and the gallery, the
one screen that lists every swarm, could not answer "which of these are live".

`/api/swarm.run` never consults the column either: it authorises on an API key
row and serves the published graph. **A key that has not been revoked is the
deployment.** The badge now derives from that same fact, so it appears when
traffic can arrive and disappears when the last key is revoked.

Zero API keys exist on this account, so the badge count was 0 before and is 0
now — but for a different reason. It was previously the only possible answer;
it is now the correct one.

#### Checked and left alone

- **Draft vs published is sound.** `swarm.run` serves `published_nodes` via
  `resolveDeployedGraph`, with a documented fallback to the draft for swarms
  deployed before snapshots existed, so editing the canvas cannot change what a
  key returns mid-flight.
- **The executor inlines node config** rather than passing `agentId`, which is
  why the `/api/chat` internal-channel gate does not reach swarm runs (see
  Module 3).

**Tests:** 9 in `tests/unit/swarmDeployment.test.ts`, mutation-verified — four
reversions, all killed, including one that keeps the badge alive after a key is
revoked.

#### Also this session

Sidebar label "Budgets" → **"AI Budgets"** (`src/lib/appNav.ts`). The command
palette reads the same `NAV_GROUPS`, so both update together. The page heading
stays "Budgets & Guardrails", which is accurate — the page covers guardrails as
well as spend.

### 2026-08-16 — Module 5, Agent Chat (`/playground`)

Run **read-only**: month-to-date spend is $5.94 against a $5 cap, so no model
turn was sent. That rules out testing streaming, tool calls and guardrails from
this surface, and those remain uncovered — noted here rather than left to look
like they passed.

#### J1 · S2 (latent) · The recovery dialog offered models IAM would refuse

`use-iam` states the invariant in its own comment: the matcher is shared with
the server "so the UI can never offer a model the server would refuse". Three
pickers honour it — `AgentForm`, `BiModelSelect`, `NodeInspector`.
`ModelFallbackDialog` did not reference it at all, building its list from a
hardcoded array plus the full `PROVIDER_MODELS` catalogue.

**It is the worst of the four to miss.** This dialog opens only after a model
has already failed. It is the recovery path, so a restricted user was being sent
from one refusal to another, with nothing on screen explaining why.

Latent on this account — `iam_model_rules` is empty, so everything is permitted
and the dialog is correct by accident. It is live for any deployment that uses
the feature, which is the same shape as D2 on the dashboard: right today, wrong
by construction.

#### J2 · S1 · My own first fix had the inversion it was fixing

The empty-state guard I wrote read `(modelRules?.length ?? 0) > 0`. But
`collapseModelPolicy` encodes **null as "no restriction"** and an **empty array
as "deny by default, nothing granted"** — opposite meanings that a length check
collapses into one. So the explanation would have been suppressed in the single
most restricted state there is: the user sees an empty dialog and is told
nothing.

Corrected to `modelRules !== null`. Caught by reading the matcher's contract
before trusting the shape, which is the only reason it did not ship. A test now
pins both directions, including a live demonstration of what the length check
would have returned.

**Tests:** 12 in `tests/unit/fallbackModelPolicy.test.ts`, mutation-verified —
five reversions, all killed, including one that turns deny-all into allow-all.

### 2026-08-16 — Module 4, Knowledge Base (`/knowledge`)

The best-built module so far. Most of this pass was spent confirming that
things which looked like defects were not, which is worth recording as
carefully as the one that was.

#### H1 · S1 · A retrieval that found nothing told the model nothing

`buildGroundingPrompt` opened with:

```js
if (citations.length === 0) return userSystemPrompt || "";
```

An empty result therefore dropped the **entire** grounding block — including the
one sentence that matters most in exactly that case: _"If the sources do not
contain the answer, say so explicitly and do not fabricate citations."_ That
instruction was present only when sources **were** found, and absent in the
single situation where a model is most likely to answer from memory and sound
precisely as grounded doing it.

Both call sites confirmed it. `/api/chat` only built the prompt
`if (citations.length > 0)`; `/api/embed.chat` called it unconditionally and got
the bare prompt back. So a user attaches a knowledge base, asks something it
cannot answer, and receives a confident answer that never touched their
documents, with nothing on screen saying so.

Now takes a `searched` flag. When a knowledge base was consulted and returned
nothing, the model is told that and asked to say it could not find it rather
than fall back on general knowledge. **Deliberately not a forced refusal** — an
attached knowledge base does not make "hello" unanswerable — and deliberately
opt-in, because claiming a search happened when no KB is wired would be the same
lie pointing the other way.

#### Checked and found honest

- **Embedding state.** 16 of 17 knowledge bases hold documents with zero chunks.
  Every one of those documents renders an amber **"Pending embedding"** badge,
  and the page header states unembedded documents fall back to a keyword scan.
- **That fallback is real**, not a claim. `kb.server` computes which documents
  are chunked, pages `knowledge_documents` in 1,000-row batches to a declared
  5,000-doc cap, warns when the cap is hit, and keyword-scans the remainder.
  Both hybrid RPCs read `kb_chunks`, so without this the promise would be false.
- **ACL enforcement fails closed.** A candidate the ACL query did not return
  "cannot be judged — drop it". The one availability exception is narrow and
  documented (pre-migration schema, where no restrictive scope can exist).
- **Retrieved text is treated as data, not instructions**, with document names
  defanged as well as bodies — names are often an ingested page's `<title>` and
  just as attacker-controlled.

#### Not verified, and why

No live LLM turn was run. Month-to-date spend is $5.94 against a $5 cap, so a
chat call would either be refused by the budget guard or spend past the user's
own limit. The change is a pure string builder, mutation-verified, with both
call sites typechecked; the behaviour it produces in a real turn is untested and
is flagged as such rather than assumed.

**Tests:** 20 in `tests/unit/groundingPrompt.test.ts` (7 new), mutation-verified
— five reversions including a full restore of the original line, all killed.

### 2026-08-16 — Module 3, Agent Builder (`/agents`)

A config surface fails differently from a metrics surface. The question is not
"is this number right" but **"does this setting do anything, and does it still
do it somewhere else"**. So the pass began by listing every key the form
persists and finding each one's runtime consumer.

That part came back clean: all twelve keys the builder writes are read by
`api/chat.ts`. No dead settings. The defect was one layer out — what happens to
those settings when the agent is used somewhere other than chat.

#### G1 · S1 · Importing an agent into a swarm silently dropped everything that restricts it

`NodeInspector.importFromLibrary` copied label, prompt, provider, model,
temperature, primary KB and reranker. It did not copy **guardrails**,
**toolConfigs**, or **skills**, and it mapped **3 of 11** tool ids.

`SwarmNodeData` already declares `guardrails`, `toolConfigs` and `skillIds`, and
`swarmExecute.server` already reads them. Nothing architectural prevented the
copy — the shapes simply differ (`toolConfigs.sql_query.table_names` on the
agent, flat `sql_table_names` on the node), which is a good explanation for how
it survived review.

**The sharp edge is that one of the dropped settings does not fail safe.** Per
`SwarmToolConfigs`, `sql_table_names` empty or undefined means _every table the
owner can see_, while `metric_model_names` empty means _no models_. So dropping
the SQL allow-list **widened** what the node could read.

Measured on a real agent, "Demo · Friendly Assistant": `sql_query` limited to
`saas_sales`, `metric_query` limited to `saas_sales_model`, four tools on.
Imported, it produced a node with no table limit and only two of its four tools.

**CORRECTION (same day, on re-measurement).** The first version of this entry
said that agent carried "18 guardrail settings", and used it as evidence of
dropped protection. It has 18 guardrail _keys_, and they are almost all **off** —
`blockPII: false`, `piiMode: "off"`, `contentSafetyLevel: "off"`, both filter
toggles false, patterns and topics empty. Only the numeric defaults
(`maxInputLength`, `rateLimitPerMinute`, `maxTurnsPerConversation`) are set.

The code defect is unaffected: `importFromLibrary` copied **no** guardrails at
all, so any agent that does have them enabled loses them entirely, and the SQL
allow-list drop is unambiguous because empty means every table. But the number
was cited as if it measured lost protection, and it did not. Counting fields and
calling it evidence of enforcement is the same error this log exists to catch.

Fixed in `src/lib/agentToSwarmNode.ts` — pure, exported, and the only mapping.
Verified by driving the real picker in the canvas: the node now shows SQL Query
and Semantic Metrics enabled (previously unmapped), with `saas_sales` and
`saas_sales_model` both checked.

#### G2 · S2 · What genuinely cannot cross is now said

Some settings have no node equivalent — webhooks, the gateway preference, extra
knowledge bases, `send_notification`. The import now returns them and the
inspector lists them under "Not copied into this node", each with a reason.
A copy that arrives quietly smaller is worse than one that says what it left
behind.

#### G3 · S1 · A comment vouching for a guarantee that cannot happen

`swarmRuntime.ts` stated that per-node guardrails are "merged OVER the linked
agent's saved guardrails, so a swarm node can be stricter than its source
agent", and the inspector repeated it to the user. **There is no linked agent.**
`importFromLibrary` deliberately sets `agentId: null`, nothing else ever sets
it, and `swarmExecute.server` never reads it. A node with empty guardrails
therefore ran with none, while the UI implied it had inherited the agent's.
Both the comment and the help text now say what is true.

#### Verified and left alone

`swarmExecute.server` inlines each node's own config rather than passing
`agentId` to `/api/chat`, so the documented internal-channel gate
(`if (body.agentId && authToken)`, which makes `/api/chat` accept and ignore an
agentId) does not bite swarm runs. The snapshot-not-link design is deliberate
and correct — a reviewed, deployed swarm must not change because someone edited
the source agent afterwards. That was kept, and pinned by a test.

The `python-agent.ts` limitation comment is worth singling out as a model of the
kind of honesty this campaign is looking for: it documents a known 401, explains
why the obvious repair is wrong, and corrects an earlier version of itself.

#### Fixture hygiene

The live check ran on an already-empty swarm with Save never pressed. Verified
afterwards from the database: 0 nodes, `updated_at` still 2026-08-09. The first
attempt to verify that returned **HTTP 400** and my check reported "UNCHANGED"
anyway, because the node count defaulted to 0 on a failed query — the same
absence-of-evidence bug this campaign exists to find, committed by the
verification itself. Re-queried against the real column (`nodes`, not `graph`)
for an actual answer.

**Tests:** 22 in `tests/unit/agentToSwarmNode.test.ts`, mutation-verified —
eight reversions, each restoring one piece of the original behaviour, all
killed, restore confirmed.

### 2026-08-16 — Module 2, Documentation (`/docs`)

All 27 pages render, every page is reachable from the sidebar, no dangling nav
entries, no orphans. The defects are all one thing: **the handbook describing a
product that had moved on.**

Root cause worth naming — there are **two documentation sets**, `docs/*.md` in
the repo and `src/routes/docs.*.tsx` in the app, and nothing keeps them in step.
Three features shipped over the last two days; all three updated the repo docs
and none reached the in-app handbook. The in-app one is what a user reads.

#### F1 · S1 · The BI export row still described a world without PowerPoint

`docs.bi.tsx` listed exports as "PDF for the page, Excel/CSV for the data" —
phrased as the complete set — after deck export shipped with its own dialog.
`docs/BUSINESS_INTELLIGENCE.md` documented it the same day. Added the row plus a
section covering what the deck does and, more importantly, what it refuses to
do (the model may quote figures, never compute them).

#### F2 · S2 · Governed dashboard generation was undocumented, and the old advice was wrong for it

The page described the AI tab as writing "a whole dashboard… from a sentence.
Read the generated query before trusting the chart." On the governed path that
advice is specifically wrong: the planner never writes SQL, the compiler does,
and "read the query" misdescribes where the guarantee comes from. Added a
section covering the two sources, the declared-vocabulary confinement, and the
refusal-with-reason behaviour.

#### F3 · S1 · The price-resolution table was missing its top layer

`docs.budgets.tsx` documented four price layers with "Operator override"
winning. Provider-reported cost shipped yesterday and **outranks all four** — it
is what you were actually billed. A reader reconciling a figure against that
table would have concluded their override was in force when the provider's own
number was. Added the layer, plus callouts for two facts the app now
communicates and the docs did not: totals render as `$12.34+?` when a call
underneath had no known rate, and a provider-reported zero is a measurement
rather than a missing price.

#### F4 · S1 · Self-inflicted: I introduced an SSR crash while writing F2

`<Callout kind="note">` — there is no `note` kind; the valid set is
`info | warn | why`. `/docs/bi` threw during server rendering, returned **200**,
and silently fell back to client rendering with its body truncated from 100,813
bytes to 24,487.

Two process failures, both mine, both worth keeping:

- **I validated the value against a file I had just edited.** Grepping for
  `kind="..."` across `docs.*.tsx` returned `note` — because my own unsaved-yet
  change was the only source of it. A check whose evidence is your own change
  confirms nothing.
- **I did not run `tsc` between editing and moving on.** The prop is typed
  `keyof typeof CALLOUT_STYLES`; the compiler had the answer immediately.

#### Method note · an SSR crash returns 200

This is the reason F4 nearly escaped. A page whose server render throws still
answers **200 OK** and recovers on the client, so status codes and a rendered
screenshot both look fine. The reliable marker is the string
`Switched to client rendering because the server rendering errored` in the HTML.
Every future module sweep should check for it, and should re-run **after** edits,
not only before.

#### Weak assertion, caught by mutation

The first version of the deck-prose check was one alternation —
`/prohibition|enforcement/` — and **survived** a mutation deleting the
prohibition, because the other branch still matched. Split into two required
regexes; the mutation then killed it. Same class as the `indexOf` ordering test
found earlier: an assertion that passes when half its subject is gone is not
asserting the claim.

**Tests:** 12 in `tests/unit/docsCurrency.test.ts`, mutation-verified — six
reversions, all killed, restore confirmed. Each case ties a capability that
exists in code to the phrases the page documenting it must contain, and asserts
the code marker still exists so a case cannot vouch for a deleted feature. It
catches "shipped it, forgot the handbook" for the listed capabilities; it cannot
prove the handbook is complete, so new features still need a case added by hand.

### 2026-08-16 — Module 1, Dashboard (`/dashboard`)

Five findings, all of the "renders fine, says something false" kind. Nothing on
this page threw, logged, or looked broken.

#### D1 · S1 · "Activity — last 24h" reported 51 hours

The card fetched the newest 200 traces and filtered only the RUN COUNT to 24
hours. Success rate, average latency and spend were computed over the whole
page. On this account those 200 rows spanned **51.3 hours**, so the card read:

| Figure       | Card said | True for 24h | Error     |
| ------------ | --------- | ------------ | --------- |
| Success rate | 96%       | 98%          | −2pt      |
| Avg latency  | 19.4s     | 12.2s        | +59%      |
| Spend        | $1.31     | $0.56        | **+134%** |

Fixed in `src/lib/dashboardActivity.ts` — the window is applied first and every
figure derives from it. Verified live afterwards against the server-side
aggregate (`/dashboard` Spend panel set to "Last 24 hours"): both paths now
report 59 runs, 98%, $0.54 from independent code.

`src/lib/budgetSpendClient.ts` already documented this failure mode. The fix
landed on month-to-date spend and never reached this card — worth remembering
that naming a bug class in one file does not retire it elsewhere.

#### D2 · S1 (latent) · The run count silently capped at 200

`runs24h` filtered an already-capped fetch, so above 200 calls in a day it
reported a prefix as the total with no disclosure. Today's 61 runs made it
correct by luck. Now `activityWindow` PROVES coverage — the window is complete
only when the fetch ran past its far edge — and the card renders "≥N runs" plus
an explicit notice when it cannot see the whole window.

#### D3 · S2 · "Where your tokens went" plotted run counts

Not merely a wrong label: ranking by runs put `google/gemini-3-flash-preview`
4th with 6 runs, where by tokens 4th belongs to `~anthropic/claude-haiku-latest`
with 11,873 — a different model. The leader's margin changed too, 2.3x by runs
versus 1.09x by tokens. Now ranks by tokens, prints the token count, and says
how many models the top-4 cut left out.

#### D4 · S3 · The hourly bars read backwards across midnight

Bucketing by `getHours()` into a fixed 0..23 array puts today's 00:00 on the
left and yesterday's 23:00 on the right. Now bucketed by hours-ago, so the axis
is chronological, and each bar's tooltip names the hour it actually covers.

#### D5 · S3 · "BY MODEL" showed 6 of 22 without saying so

Ranked by cost, so the six shown covered 95% of spend but only **37% of runs** —
`openai/gpt-4o-mini`, the busiest model on the account at 1,256 of 2,576 runs,
was absent from a panel headed "BY MODEL". Now discloses:
"top 6 by cost · 16 more models not shown (1,631 runs, $0.3612)".

#### Verified correct, left alone

Hero tiles (7/15/17/3/17) match the database exactly. The Spend panel's totals
($7.65, 2,576 runs, 3,601,015 tokens, 94%) match a paged recount exactly — the
server-side aggregation holds. The budget badge's 119% is arithmetically right
($5.94 month-to-date against a $5 cap); the overage is real and follows today's
repricing of 116 previously-unpriced calls, not a counting error.

A `TeamSpend` null-`.slice` crash and two failed requests in the console turned
out to be a stale buffer from earlier navigation in a long-lived tab; that crash
was fixed earlier today and all five of this page's queries return 200.

**Tests:** 26 in `tests/unit/dashboardActivity.test.ts`, mutation-verified —
five reversions applied one at a time, each killed (5/2/2/4/2 failures), restore
confirmed on disk after every run.
