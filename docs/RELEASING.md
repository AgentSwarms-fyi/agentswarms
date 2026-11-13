# Releasing AgentSwarms

A release is a version tag. Pushing `v1.7.0` runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which
builds, tests, scans, publishes and signs every image, then writes the GitHub
Release from the CHANGELOG. This page is for maintainers. Operators upgrading
an install want [Upgrades](./DEPLOYMENT.md#upgrades).

## What a release publishes

Seven images, listed in [`deploy/release/images.json`](../deploy/release/images.json),
each for `linux/amd64` and `linux/arm64`:

| Image | What it is |
| --- | --- |
| `ghcr.io/agentswarms-fyi/agentswarms` | The app |
| `ghcr.io/agentswarms-fyi/db-migrate` | The migrations as a one-off task (also bootstraps a plain PostgreSQL) |
| `ghcr.io/agentswarms-fyi/notebook-runtime` | The Developer workspace sandbox |
| `ghcr.io/agentswarms-fyi/notebook-gateway` | The notebook gateway |
| `ghcr.io/agentswarms-fyi/docker-socket-proxy` | The least-privilege Docker API proxy |
| `ghcr.io/agentswarms-fyi/docgen` | The Office document renderer |
| `ghcr.io/agentswarms-fyi/js-sandbox` | The JavaScript sandbox |

Tags: `1.7.0`, `1.7` and `latest` for a release. `latest` moves only to the
newest release, and `1.7` to the newest of its line. A prerelease
(`v1.7.0-rc.1`) gets only its own tag and is marked as a prerelease on
GitHub.

Every image carries no install's settings. The app reads its browser
settings at runtime (`PUBLIC_*`, [Browser settings at runtime](./DEPLOYMENT.md#browser-settings-at-runtime)),
so the published image is the one every install runs.

## Cadence

- **A minor release every month** (`1.7.0`, `1.8.0`).
- **A patch release** (`1.7.1`) whenever a security or bug fix cannot wait. A
  patch carries no migration that changes an existing table.
- The release before the current one gets security patches too.

## Cutting a release

1. **`main` is green.** CI, Migrations (including the `upgrade` job) and Image
   scan all passed on the commit you will tag.
2. **Prepare it:**

   ```bash
   npm run release:prepare -- 1.7.0
   ```

   This sets the version in `package.json` and `package-lock.json`, and moves
   the CHANGELOG's `## Unreleased` entries under `## 1.7.0 — <today>`.

3. **Write the summary.** The new section starts with a marker line. Replace
   it with one paragraph on what the release is for. The workflow refuses to
   publish while the marker is there. Check the section's `### Upgrading`
   entries too. Anything that cannot be undone except by restoring a backup is
   called out there; see the list below.
4. **Commit, tag and push:**

   ```bash
   git commit -am "Release 1.7.0"
   ```

   ```bash
   git tag -a v1.7.0 -m "AgentSwarms 1.7.0"
   ```

   ```bash
   git push origin main v1.7.0
   ```

5. **Watch the Release workflow.** About 30–60 minutes; the notebook sandbox
   image is the slowest. When it finishes, the release is on the Releases page
   with every image's digest.
6. **The first release only:** GitHub creates each package as private. Open
   each package under the organisation's Packages, then Package settings, and
   set its visibility to public. The image's `org.opencontainers.image.source`
   label links the package to the repository.

### Rehearsing

Actions → Release → Run workflow. It builds, smoke-tests and scans every
image on both architectures and publishes nothing. Do this after changing a
Dockerfile, `images.json` or the workflow.

### A patch on an older line

Branch from the tag, fix, prepare the patch version there, tag it from the
branch:

```bash
git switch -c release/1.7 v1.7.0
```

The workflow publishes `1.7.1` and moves `1.7` to it. It leaves `latest`
where it is: `latest` only ever moves to the newest release, and `1.7` to
the newest of its line, decided from the existing tags.

## What the workflow checks before it publishes

- **The tag.** It must be `v` plus `package.json`'s version, and the CHANGELOG
  must have that version's section with its summary written.
- **Each image, on each architecture,** before anything is pushed:
  - its smoke test ([`deploy/release/smoke/`](../deploy/release/smoke/));
  - the same vulnerability gate as the image scan (a critical with a fixed
    version fails, except the baseline's known findings);
  - for `db-migrate`, the whole schema installed from the image on an
    RDS-shaped PostgreSQL ([`deploy/ci/rds-like/run.sh`](../deploy/ci/rds-like/run.sh)
    with `MIGRATOR_IMAGE`).
- **The signature.** Each multi-arch image is signed with Sigstore
  (keyless: the certificate names this repository's release workflow at this
  tag) and verified against exactly that identity before the notes are
  written.

The app's smoke test checks the image starts with nothing but runtime
environment, renders a page carrying the Supabase URL it was given at
runtime, runs as `node`, and carries no npm, no dev dependency and no source
tree. Its build also proves that pruning the dev dependencies removed
nothing the server imports (`scripts/check-runtime-imports.mjs`).

## Checking an image

```bash
cosign verify ghcr.io/agentswarms-fyi/agentswarms:1.7.0 \
  --certificate-identity-regexp '^https://github\.com/AgentSwarms-fyi/agentswarms/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The SBOM and the build provenance are attached to each image:

```bash
docker buildx imagetools inspect ghcr.io/agentswarms-fyi/agentswarms:1.7.0 --format '{{ json .SBOM }}'
```

```bash
docker buildx imagetools inspect ghcr.io/agentswarms-fyi/agentswarms:1.7.0 --format '{{ json .Provenance }}'
```

## Amazon ECR Public (optional)

The workflow also copies every image to ECR Public, with the same digests,
signed again there, when two repository variables are set:

- `ECR_PUBLIC_REGISTRY`: `public.ecr.aws/<your alias>`.
- `AWS_RELEASE_ROLE_ARN`: an IAM role whose trust policy lets GitHub's OIDC
  provider assume it for this repository's tags only
  (`token.actions.githubusercontent.com:sub` like
  `repo:AgentSwarms-fyi/agentswarms:ref:refs/tags/v*`). It needs
  `ecr-public:GetAuthorizationToken`, `sts:GetServiceBearerToken` and the
  push actions on the seven repositories.

Create the seven ECR Public repositories (named as the images) once, in
us-east-1. Without the variables the step is skipped.

## When a release goes wrong

- **A job failed before publishing.** Nothing was tagged. Fix it on `main`,
  then either rerun the failed jobs or delete the tag and push it again. A
  digest pushed by a failed run is not tagged, and nobody pulls it.
- **Published, then found broken.** Never move or delete a published tag:
  someone may already run it. Cut a patch release. Operators roll back with
  the previous version's tag; the schema allows that for one release
  ([Rolling back one release](./DEPLOYMENT.md#rolling-back-one-release)).

## What cannot be undone except by a restore

Say so in the release's `### Upgrading` section, and keep them out of patch
releases:

- the lakehouse catalog's format, when DuckDB moves to a new version;
- Qdrant's storage, which opens only the previous minor release's;
- the auth and storage services' own schemas (GoTrue, storage-api);
- a PostgreSQL major version;
- a migration with a `-- contract:` line (it removes something on purpose).
