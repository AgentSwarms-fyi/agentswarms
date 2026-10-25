# Security assessments

This directory is where a vulnerability assessment of AgentSwarms is **recorded**
so the next one can be run the same way and compared against the last. It holds:

- `README.md` — this file: the repeatable process, the tools, and what each
  scan covers.
- `scripts/scan.sh` — one script that runs the automated half (dependency and
  image scanning) and writes timestamped output under `reports/` (git-ignored).
- `assessments/<YYYY-MM-DD>.md` — one dated report per assessment: what was
  scanned, what was found, each finding's severity and status, and the commit
  that fixed it.

The point of keeping this in the repo is that "we scanned it once" is not a
security posture. An assessment is a snapshot; threats and dependencies move, so
the assessment is repeated on a cadence and every run leaves a dated record next
to the last one. SECURITY.md describes the controls the application _has_; this
directory is the evidence they were _checked_, and when.

- [When to run one](#when-to-run-one)
- [Scope](#scope)
- [The tools](#the-tools)
- [Running the automated scans](#running-the-automated-scans)
- [The manual review](#the-manual-review)
- [Writing the report](#writing-the-report)
- [Fixing findings](#fixing-findings)

---

## When to run one

- On a schedule — quarterly is the floor for a project that ships weekly.
- Before a tagged release.
- When a dependency with a large attack surface is added or a major is taken.
- After any change to an authentication, authorization, SSRF, SQL-safety, or
  credential-handling path — the code that, if wrong, is wrong in a way that
  matters.

`npm audit` and Dependabot already run continuously (see SECURITY.md →
Dependencies); this assessment is the wider, periodic sweep that also covers the
container images, the configuration, and the code paths a package advisory
cannot see.

## Scope

Every assessment covers these five areas. The dated report has a section for
each so a gap in coverage is visible rather than silent.

1. **Dependencies** — `package-lock.json` (production and dev), the Python
   service requirements, and the GitHub Actions. Known-vulnerable versions.
2. **Container images** — the images `docker-compose.yml` builds and pulls, and
   their base images. OS and language-package CVEs.
3. **Secrets** — the working tree and, where feasible, history, for committed
   credentials. `.env` is git-ignored by design; the check is that it stays
   that way and that no key, token, or password is hard-coded in source.
4. **Code and configuration** — the classes a scanner misses: authentication
   and authorization on every server entry point, Row-Level-Security and
   `SECURITY DEFINER` RPC exposure, SSRF, SQL-injection and the read-only
   guard, command/path injection, XSS, CSRF, and the HTTP security headers.
5. **Container hardening** — image pinning, dropped capabilities, read-only
   root filesystems, non-root users, and network isolation in
   `docker-compose.yml`.

## The tools

All are standard, open-source, and run as pinned container images so nothing new
is installed on the host and the version is recorded. Pull them by the digest a
previous run recorded, or by the tag below and record the digest you got.

| Tool                   | Image                            | Covers                                                  |
| ---------------------- | -------------------------------- | ------------------------------------------------------- |
| **npm audit**          | (the toolchain already present)  | npm dependencies                                        |
| **osv-scanner**        | `ghcr.io/google/osv-scanner`     | lockfiles across ecosystems (npm, PyPI, GitHub Actions) |
| **Trivy** or **Grype** | `aquasec/trivy`, `anchore/grype` | image OS + language CVEs                                |
| **gitleaks**           | `zricethezav/gitleaks`           | committed secrets                                       |
| **hadolint**           | `hadolint/hadolint`              | Dockerfile hardening lint                               |
| **Semgrep**            | `semgrep/semgrep`                | code-pattern SAST (optional, high-signal rulesets)      |

The code and RLS review is done by reading the code, not only by a scanner — the
findings that have mattered here (a read-only SQL guard bypassed by a comment
inside a string literal; a `SECURITY DEFINER` RPC that trusted a caller-supplied
user id) are not ones a generic ruleset flags.

## Running the automated scans

```bash
bash docs/security/scripts/scan.sh
```

It writes to `docs/security/reports/<YYYY-MM-DD-HHMMSS>/` (git-ignored): the npm
audit JSON, the osv-scanner results, a Grype report per built image, a gitleaks
report, and a hadolint report per Dockerfile. The script pulls each scanner
image by a pinned tag and prints the digest it resolved, so the dated report can
record exactly which scanner version produced the numbers.

The script never fails the shell on findings — it is a report generator, not a
gate. Read the output, then write it up.

## The manual review

For each of the five scope areas, the code review looks for:

- **Auth** — every `src/routes/api/*.ts` handler and every `createServerFn`:
  how is the caller authenticated, and does any admin action skip
  `requireSuperadmin`? Does any handler trust an owner/user id from the request
  body instead of the session?
- **RLS / RPC** — is RLS enabled on every table in `public`? Is every
  `SECURITY DEFINER` function either keyed on `auth.uid()` or revoked from
  `anon`/`authenticated`? (A new function signature re-grants EXECUTE to PUBLIC
  by default, so a superseding migration must re-`REVOKE`.)
- **SSRF** — does every outbound fetch of a user- or model-supplied URL go
  through `safeFetch`/`assertPublicUrl` (`src/utils/ssrfGuard.server.ts`), which
  resolves the name and re-checks every redirect hop — not a bare
  literal-hostname check?
- **SQL** — does untrusted SQL reach an engine only through the shared
  read-only guard (`src/lib/sqlSafety.ts`), and is that guard literal-aware?
- **Headers** — does the production server set a Content-Security-Policy,
  `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`,
  `Referrer-Policy`, and HSTS?

## Writing the report

Copy the previous `assessments/<date>.md`, update the date, and fill in:

- the scanner versions (digests) and the raw counts from this run;
- every finding, with a stable id (`VA-<date>-NN`), severity
  (critical/high/medium/low), confidence, the file and line, a one-line impact,
  and the fix;
- a status column that moves from `open` to `fixed (<commit>)` or
  `accepted (<reason>)` as the fixes land.

An **accepted** finding is one left unfixed on purpose — the reason goes in the
report and, if a reader would hit it, in SECURITY.md's "What this project does
not claim" section. Nothing is closed silently.

## Fixing findings

Fixes follow the project's normal change routine, one finding (or one coherent
group) per commit: reproduce it, fix it, add the test that would have caught it,
run the full gate (`npm run check`), and reference the finding id in the commit
message. The report's status column is updated in the same commit. A finding
that cannot be fixed without a breaking change is written down as accepted with
the reason, not quietly dropped.
