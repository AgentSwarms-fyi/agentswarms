# 07 · Conventions

> Part of [The engineering behind AgentSwarms](./README.md).

How this codebase is written, and the machinery that stops it drifting. None of
this is enforced by a linter; most of it is enforced by tests that fail when you
get it wrong, which is the same thing with better error messages.

---

## Naming carries meaning

The suffix on a filename is a claim about where the code may run, and the build
will not always catch a violation.

| Pattern                   | Means                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| `*.server.ts`             | Server only. Holds or reaches secrets. Never import from a component    |
| `*.functions.ts`          | Exports `createServerFn` RPC — grep this suffix to find the RPC surface |
| Plain `.ts` in `src/lib/` | Isomorphic, or explicitly client-only with a header saying so           |
| `src/routes/api/*.ts`     | HTTP endpoint; dots in the filename become path separators              |

`src/lib/swarmRuntime.ts` is the case worth internalising: it is client-only, it
says so in capitals at the top, and the reason is that it uses the browser
Supabase client so the user's own session scopes everything. Importing something
server-side into it breaks the build in a way the error message does not explain.

---

## Comments explain the failure, not the mechanism

The code says what it does. A comment that repeats that is noise. The convention
here is that a comment explains **why the code is shaped this way**, and where a
shape was forced by something going wrong, it names that thing.

This is why `src/lib/sandbox/jsSandbox.ts` contains the literal escape string
that defeated the previous design, and why
`src/utils/rateLimit.server.ts` records that published ceilings "silently became
4x their configured value on a four-instance deployment". Someone reading either
file six months from now can tell a load-bearing decision from an arbitrary one.

The same convention covers what is _not_ implemented.
`src/utils/guardrails.ts` lists, under `INERT`, the settings it saves and does
not enforce. That list is uncomfortable and it is the honest thing to publish: an
operator who believes they have a control they do not have is worse off than one
who knows the gap.

---

## Testing

229 test files, 4216 tests, run with:

```bash
npm test
```

The philosophy is in [TESTING.md](../TESTING.md); three parts of it shape how you
should add tests here.

**Mutation-check anything that guards a boundary.** A test that passes is
evidence of nothing until you have seen it fail for the right reason. The
discipline is: apply the mutation the test claims to catch, watch it go red,
restore, watch it go green. TESTING.md records this for real cases —
"reintroducing the quoting bug fails 4 of them". A guard test that survives its
own mutation is not a guard.

**Test the claim, not the formatting.** A cautionary example lives in the tree:
the service-catalogue check asserted that `docker-compose.yml` contained the
literal string `profiles: [docgen]`. Adding a second profile to that list broke
the test without its claim becoming untrue. It now parses the YAML. If your
assertion would break on a reformat, it is testing the wrong thing.

**Pin the defaults that other things depend on.** `SKILLS_INLINE_MAX_CHARS`
defaults to 8000 so the bundled sample skills stay inline; a test pins that, so
the default cannot drift out from under them silently.

---

## Keeping documentation honest

Prose drifts from code because nothing fails when it does. Three mechanisms push
back, and it is worth knowing exactly what each does and does not catch.

```bash
npm run check:docs      # 28 in-app documentation pages
npm run check:md-docs   # every markdown file in docs/, README, the SDK README
```

**`check:docs`** covers the in-app pages: nav paths against the real sidebar, tab
orders against the real components, tool and connector counts against the source
lists.

**`check:md-docs`** covers the markdown corpus — including these engineering
chapters, which were added to its file list when this section was written, since
`readdirSync("docs")` returns only the top level and they would otherwise have
been the one part of the corpus nothing checked. It verifies that relative links
and anchors resolve, backticked repository paths exist, `npm run` scripts are
real, API endpoints map to routes, and environment variables are ones the runtime
reads.

**`tests/unit/docsFreshness.test.ts`** closes the loop in the other direction,
catching two classes of rot that were both found in real files here: an
environment variable the code reads that no document mentions, which is
undiscoverable; and one the docs promise that no code reads, which is worse,
because the operator sets it and then wonders why nothing changed. `.env.example`
asked for a variable nothing had ever read. It also pins counts — "ten
connectors" survived the connector count reaching 22.

**What none of them catch:** whether an explanation is still _true_. A paragraph
can name a file that exists and describe behaviour that changed two releases ago.
The mitigation is convention rather than tooling — where a chapter explains a
decision it names the file to check it against, and where a number appears it
says where it was measured, so changing either puts the paragraph in the diff.

After editing an in-app documentation page, rebuild the search index:

```bash
npm run docs:index
```

---

## The adversarial log

`docs/ADVERSARIAL_LOG.md` is a record of auditing this application against
itself: recomputing every headline figure independently from the database and
comparing it against what each page claimed.

Two things about it are conventions rather than history. It records the modules
that **passed** at the same length as the ones that failed, because a log of only
faults says nothing about where the ground is solid. And it records what was
**not** covered — a budget cap blocked live model turns during one module, and
those are marked uncovered rather than left looking as though they passed.

It is excluded from `check:md-docs`, deliberately: it quotes file names in their
on-disk dot form and deliberately hostile strings, so judging it against today's
tree produces only noise.

---

## Adding something: the short version

**A warehouse driver.** One driver in
`src/utils/warehouse/drivers.server.ts`, a `WarehouseProvider` union member, a
zod `ConfigSchema` entry. Everything downstream — catalog, direct query, semantic
executor, SQL agents — goes through `executeWarehouseQuery` /
`listWarehouseTables` / `testWarehouseConnection`, so nothing else needs to
change.

**A tool.** Definition plus handler in `src/utils/tools/registry.server.ts`, id
in `TOOLABLE_IDS`. Gate it on the underlying capability existing — a tool offered
without its prerequisite is a tool that always fails.

**A swarm node kind.** Both executors: `src/lib/swarmRuntime.ts` and
`src/utils/swarmExecute.server.ts`. Pure graph logic goes in the shared helpers;
only IO differs.

**A Compose service.** Give it a profile _and_ `all`, or
`tests/unit/composeProfiles.test.ts` fails — a service that misses `all` breaks
nothing and errors nowhere, it just quietly makes `--profile all` mean "all
except that one".

**Anything that reads a new environment variable.** Add it to `.env.example` and
document it, or `docsFreshness` fails. That test has caught its own authors more
than once.

---

That is the tour. The [security model](./05-security-model.md) is the chapter to
re-read before shipping anything that touches the app process.
