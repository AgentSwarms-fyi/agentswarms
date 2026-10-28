# Enterprise Ontology

> Part of the [AgentSwarms docs](../README.md#documentation).

The business described once — the things it deals in, how they connect, what is measured, what
must hold true and what may be changed — on top of lakehouse tables. Find it under **Data & BI →
Enterprise Ontology**; the in-app guide is at `/docs/ontology`.

## Why it exists

Tables are named for how data was loaded. Every dashboard, sheet and agent re-derives what "a
customer", "revenue" or "an order's customer" means from columns and joins, and the answers drift.
Text-to-SQL over raw tables makes it worse: it picks a plausible join and returns a confident
wrong number. Leading platforms answer this in pieces — semantic layers (metrics, no objects or
actions), operational ontologies (objects and actions, proprietary, cloud-bound), knowledge graphs
(meaning, not wired to BI or agents). This feature puts the pieces in one self-hosted model over
open tables:

- **objects and links** you explore and walk ("search around"), not tables and joins;
- **certified metrics** that hang on the type they measure and cannot double count through a
  fan-out link;
- **rules in words and as checks** that run against the data, with the violations as objects;
- **typed actions** as the only way data changes: criteria, approval, an edit log;
- **grounded AI**: questions planned over the ontology, never free SQL, each answer with a trust
  envelope, and verified questions as an evaluation suite;
- **IAM, audit and query history** like every other governed resource;
- **Apache Ossie** in and out (semantic model + ontology + mapping), plus OWL and JSON.

## The model

One JSON document per ontology (`src/lib/ontology/spec.ts`, zod-validated), so it versions,
diffs, exports and is reviewed as a unit:

| Part        | Shape                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object type | PascalCase name, `source: { table, filter? }` (a filter makes a subtype of the same table), key, title, properties, metrics, `extends`, interfaces, status, domain, icon, colour, synonyms, AI instructions, canvas position |
| Property    | snake_case name, base type or value type, `column` or a derived `expression`, required, sensitivity (`restricted` = owner only), synonyms                                                                                    |
| Value type  | base type plus allowed values, pattern, min/max, unit                                                                                                                                                                        |
| Interface   | shared properties; implementers are checked                                                                                                                                                                                  |
| Link type   | `from`, `to`, name read from each side, cardinality, verbalization, join through a key or a join table                                                                                                                       |
| Metric      | aggregate over the type's property names; `certified`                                                                                                                                                                        |
| Rule        | statement in words + kind (required, unique, pattern, range, allowed values, referential, predicate), severity                                                                                                               |
| Action type | modify / create / delete, parameters → properties, criteria, `requiresApproval`, `agentMode` (none / propose / execute)                                                                                                      |

`validate.ts` checks meaning (names resolve, keys are properties, no inheritance cycles,
interfaces honoured, joins line up, many-to-many needs a join table, a key cannot be restricted,
a property cannot be a SQL keyword, every expression parses and names only what it may) and
scores completeness. `diff.ts` classifies changes as breaking (removed type / property / metric /
link, changed key, binding, join or cardinality) and lists what still refers to each.
`edit.ts` renames and removes with every reference carried along.

## From the model to SQL

`compile.ts` is pure: object sets (filters with literals checked against the property's type,
search over string properties, up to four link steps), one object and its links, metrics grouped
through **to-one** links only (a fan-out grouping is refused with the reason), time grains, rule
checks with samples, implied rules (keys, required properties, value types, link targets) and
action writes. Every fragment an ontology holds — derived properties, source filters, metrics,
rule predicates, action criteria — goes through `expr.ts`, which tokenises and re-emits it:
keywords and functions from allow-lists, every other word a quoted, qualified name, strings with
quotes doubled; `;`, comments, `$`, dotted names and unknown functions do not tokenise. A
smuggled `(SELECT secret FROM t)` becomes quoted names the engine cannot parse.

Compiled SQL runs through `runLakehouseStatement` **as the caller** (`src/utils/ontology/run.server.ts`):
their schema grants, the tables' tag policies and row filters apply, and the statement lands in
their Lakehouse history and the audit log marked `ontology:<what>` (`explore`, `object`, `graph`,
`metric`, `rule`, `profile`, `ask`, `action`, `draft`, `sample`).

## Access, sharing and policy

`src/utils/ontology/access.server.ts` decides for every server function:

- the **owner** works on the draft and may save, publish, restore, delete, run rules, preview
  tables, approve actions and verify questions;
- a **grantee** (IAM resource type `ontology`, user or group) reads the **published** version only,
  explores, asks, proposes and requests actions; before the first publish there is nothing to see;
- anyone else gets "does not exist", as for a deleted ontology.

A share can carry a row filter (`Type.property` or a bare property, values or `{{user.<key>}}`
attribute tokens) and a column mask (`Customer.email` or `email`). They are merged by the same
functions BI and semantic-model shares use (`semanticPolicy.policyFromGrants`) and read in
ontology terms by `policy.ts`; the compiler applies them wherever a type appears (start, every
step of a walk, a metric's grouping) and fails closed when a filter names a property the type
lacks. A masked or restricted property reads as NULL, cannot be filtered, sorted, grouped or
aggregated (a filter is a way to read a value one comparison at a time), and is left out of the
catalog AI sees. `tests/unit/enterpriseOntologyAccess.test.ts` pins all of this on the source.

## AI

- **Draft from tables** (`ontologyDraftFromTables`): `infer.ts` guesses types, keys and links from
  names; the server measures each (key uniqueness, link match rate ≥ 60%) and drops what fails;
  an optional model pass adds descriptions, labels, synonyms and link sentences, never structure.
- **Ask** (`src/utils/ontology/ask.server.ts`): a verified question that matches closely answers
  without a model call; otherwise the model reads `catalog.ts`'s catalog and returns a plan
  (`askPlanSchema`: objects / metric / refuse); a plan that does not compile goes back once with
  the error. The answer's trust envelope lists the metric and whether it is certified, types,
  links, tables, the asker's restrictions, open rule violations on those types and the
  verification. Verified questions store the plan and a digest of the answer; **Evaluate**
  re-runs them (same / changed / broken).
- **Agents**: the `ontology_query` tool (`src/utils/tools/ontology.server.ts`), deny-by-default by
  ontology name, catalog in the description, runs as `scopeUserId ?? userId`, may request actions
  only where `agentMode` allows (propose by default).

Every model call goes through `llmJsonServer`: the caller's provider credentials, IAM model rules,
the budget gate, and a trace with its cost (`Ontology: Ask`, `Ontology: Draft`).

## Actions

`src/utils/ontology/actions.server.ts`: a request checks the object is visible to the requester
(their row filter), that no parameter sets a property hidden from them, and the criteria on the
object as it is now; then it applies as the requester, or is recorded as proposed when the type
needs approval (or an agent may only propose). Approval re-checks the criteria and applies as the
owner. `ontology_actions` keeps before and after of every change; requests, approvals, rejections
and failures are audited. A filtered subtype's action cannot reach rows outside its filter.

## Storage

Migration `supabase/migrations/20261030000000_enterprise_ontology.sql`: `ontologies` (draft spec,
revision for compare-and-set saves, published version, health), `ontology_versions` (immutable),
`ontology_proposals`, `ontology_rule_runs`, `ontology_actions`, `ontology_questions`; RLS owner +
`has_resource_access('ontology', …)` for reads; the IAM type list gains `ontology`; limits
`ontology_max_rows` / `ontology_max_spec_kb` (env `ONTOLOGY_MAX_ROWS`, `ONTOLOGY_MAX_SPEC_KB`).

## Apache Ossie

`src/lib/ontology/ossie.ts` and `ossieSchema.ts` (strict zod mirrors of the 0.2.0.dev0 schemas,
tested against the vendored official schemas and examples in `tests/fixtures/ossie/`):

- **Export** writes the semantic model (bound types → datasets, properties → fields, keys,
  to-one links → relationships, metrics), the ontology (value types and entity types as concepts,
  properties and links as relationships with verbalizations, keys as `identify_by`, required
  properties as `requires`) and the mapping document. What Ossie cannot say (join-table links,
  source filters, sensitivity, rules, actions, value-type units, layout) travels in an
  `AGENTSWARMS` custom extension, so a round trip is lossless; other vendors' extensions survive.
- **Import** reads a semantic model alone or all three documents (JSON or YAML), including the
  pre-0.2 wrapper and embedded mappings with a warning, and reports what it could not carry.

`owl.ts` exports OWL 2 Turtle (classes, datatype and object properties, inverses, keys, value-type
restrictions) as a one-way bridge to knowledge-graph tools.

## The sample

`sample.ts` — Northwind Outfitters: six generated tables (deterministic, from `range()` and
`hash()`), seven object types (one a filtered subtype), an interface, value types, a join-table
link, metrics, rules and actions. Some rows are wrong on purpose so the first rule run finds them:
two e-mails that are not e-mails, one order whose customer does not exist, two negative
quantities and two orders in an unknown status.

## Tests

- `tests/unit/enterpriseOntology.test.ts` — expression fences, validation, compiler guards,
  policies, rename/remove, diff, inference, layout, OWL, the AI catalog and plans.
- `tests/unit/enterpriseOntologyEngine.test.ts` — the sample created in DuckDB; every kind of
  compiled query executed and compared with hand-written SQL; rules find exactly the planted rows;
  actions write; a grantee's filter and mask hold in executed queries.
- `tests/unit/enterpriseOntologyAccess.test.ts` — every server function resolves the caller and
  loads access, owner-only functions demand ownership, changes are audited, data is read as the
  caller, grantees get the published version, RLS and the IAM type, the agent tool's allow-list.
- `tests/unit/ontologyOssie.test.ts` — Ossie mirrors against the official schemas, official
  examples imported, lossless round trips.
