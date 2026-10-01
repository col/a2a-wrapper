# Fork release pipeline (`@col` beta builds to GitHub Packages)

**Date:** 2026-10-01
**Status:** Approved design — ready for implementation planning
**Repo:** `col/a2a-wrapper` (fork of `shashikanth-gs/a2a-wrapper`)

## Problem & intent

The fork maintainer drives most `a2a-claude` / `@a2a-wrapper/core` development and needs
to publish **beta builds to GitHub Packages** so a **separate real project** can
`npm install` and run them *before* the changes are opened as upstream PRs.

The current process achieves this by committing a fork-scoping transform directly onto
feature and `publish/*` branches: renaming packages to the `@col` scope, adding
`publishConfig.registry`, rewriting the inter-package dependency to an npm alias, and
bumping a manual `0.2.1-beta.N` version. Because these un-upstreamable edits live *on the
branches alongside feature commits*, every branch permanently diverges from upstream and
each publish becomes a bespoke tangle. Version drift has crept in (upstream core is now
`2.1.1`; the last fork build pinned `@col/a2a-wrapper-core@1.7.1-beta.1`).

**Goal:** a clean, repeatable way to publish `@col` beta builds to GitHub Packages that
keeps feature branches byte-for-byte upstream-pure and confines all un-upstreamable
machinery to a single quarantined location.

### Success criteria

- Feature branches contain **zero** fork-specific edits; they PR to upstream unchanged.
- The `@col` rename / alias / version / registry edits exist **only inside a CI run** —
  never committed to git.
- One repeatable, button-driven way to assemble 1..N refs into a published beta.
- Every published build has an authoritative, human-readable record of exactly what went
  into it.
- No new paid services; GitHub Packages + the built-in `GITHUB_TOKEN` only.

### Non-goals

- Changing upstream's own release pipeline (changesets, `publish.yml`, canary channel).
- Automating `main` sync (left manual for now; may add a scheduled job later).
- Publishing stable (non-beta) releases from the fork — upstream owns stable.
- Any source-code changes to make packages fork-aware (the npm-alias avoids this).

## Decisions (resolved during brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Consumer of the builds | A separate real project installs from a registry (registry publish is required). |
| 2 | Registry | **GitHub Packages** (already in use, free with `GITHUB_TOKEN`). Forces the `@col` scope rename. |
| 3 | Where fork machinery lives | **A dedicated `release/col` branch.** `main` stays a pure upstream mirror. |
| 4 | Build assembly | **A list of 1..N refs merged onto a base (default `upstream/main`) ephemerally in the runner.** |
| 5 | Keep npm-alias for the internal dep | **Yes** — avoids all source edits. |
| 6 | Cosmetic repository/homepage/bugs URL rewrites | **Dropped** — noise, no functional value. |
| 7 | Versioning | Snapshot suffix `<base>-col.<UTCstamp>.<shortsha>`; no manual `beta.N`. |
| 8 | Human-readable `label` in the version | **Dropped** — the GitHub Release is the record. |
| 9 | Traceability | **A GitHub Release per build** whose body is the build manifest. |
| 10 | dist-tag | Default `beta`; any string allowed (named channels e.g. `sdk-next`). |

## Architecture

### Branch model

- **`main`** — permanent, pure mirror of `upstream/main`. Never carries fork files.
  Feature branches are cut from here and PR'd upstream clean. Refreshed manually via
  `git push origin upstream/main:main` (fast-forward).
- **`release/col`** — the **only** fork-divergent branch; branched from `upstream/main`.
  Contains *just* the release machinery (below). Never merged upstream, never a base for
  feature work, never accumulates feature commits. Periodically `upstream/main` is merged
  into it to keep the machinery current.

### Files on `release/col` (the entire irreducible fork residue)

```
.github/workflows/col-release.yml   # manual-dispatch publish workflow
scripts/col-release/transform.mjs   # the @col mutation, applied in-runner only
scripts/col-release/README.md       # how to cut a build / consumer setup notes
```

### Build flow (all ephemeral — nothing committed, nothing pushed back to git)

```
workflow_dispatch(refs=[…], base=upstream/main, dist_tag=beta, dry_run=false)
  └─ runner checks out release/col              (for the workflow + script)
     ├─ add 'upstream' remote; fetch base + each feature ref from origin/upstream
     ├─ git checkout <base>
     ├─ merge each ref in order                 (HARD FAIL on conflict, clear message)
     ├─ npm ci  &&  npm run build               (core built before a2a-claude)
     ├─ node scripts/col-release/transform.mjs  (rename → @col, alias dep, set version)
     ├─ npm publish @col/a2a-wrapper-core  then  @col/a2a-claude  → GitHub Packages
     │     (or `npm publish --dry-run` when dry_run=true)
     ├─ create a GitHub Release tagged with the version; body = build manifest
     └─ job summary: published name@version lines + the consumer install command
```

## Component detail

### 1. Transform (`scripts/col-release/transform.mjs`)

A pure transform over the assembled working tree. Driven by env
(`OWNER`, `REGISTRY`, `VERSION`, `DIST_TAG`) so it is owner-parameterized, not hardcoded.

For each publishable package it edits only `package.json`:

| Field | `packages/core` | `a2a-claude` |
|---|---|---|
| `name` | `@a2a-wrapper/core` → `@col/a2a-wrapper-core` | `a2a-claude` → `@col/a2a-claude` |
| `version` | `<coreBase>` → `<coreBase>-col.<suffix>` | `<claudeBase>` → `<claudeBase>-col.<suffix>` |
| `publishConfig.registry` | add `https://npm.pkg.github.com` | add `https://npm.pkg.github.com` |
| internal dependency | — | `@a2a-wrapper/core` → `npm:@col/a2a-wrapper-core@<coreBase>-col.<suffix>` |

- The name mapping is an explicit table (only two packages) for clarity.
- The **npm-alias** on the internal dependency keeps the dependency *key* as
  `@a2a-wrapper/core`, so every `import … from '@a2a-wrapper/core'` resolves unchanged;
  only the installed contents come from the fork build. No source edits anywhere.
- Both packages share one `<suffix>` per run; the alias pins core's exact snapshot.
- Cosmetic URL fields (`repository`, `homepage`, `bugs`) are intentionally left untouched.

### 2. Versioning

- `<suffix>` = `<UTCstampYYYYMMDDHHmm>.<shortsha>` where `shortsha` is the assembled merge
  commit. Example: `0.2.0-col.202610011430.9749bd5`.
- Base versions are read from the assembled tree (so core `2.1.1-col.…`, a2a-claude
  `0.2.0-col.…`) — real base versions keep semver ordering sane for the consumer.
- Immutable and collision-proof; replaces manual `beta.N` bookkeeping.
- **Not** using `changeset version --snapshot` — more machinery than a throwaway test
  build warrants (YAGNI).

### 3. Workflow (`.github/workflows/col-release.yml`)

- **Trigger:** `workflow_dispatch` only. Inputs:
  - `refs` — newline/comma list of branches or PR refs to merge (default empty = base only)
  - `base` — default `upstream/main`
  - `dist_tag` — default `beta`
  - `dry_run` — boolean, default `false`
- **Permissions:** `contents: write` (to create the Release/tag), `packages: write`.
  Auth via the built-in `GITHUB_TOKEN` — no managed secrets, no cost.
- **Steps:** as in the build flow above. Conflicts during assembly fail the run loudly.
- **Outputs:** a GitHub Release (version-tagged) whose body is the build manifest —
  `base` ref, each feature ref **with its resolved SHA**, and the published
  `name@version` for both packages — plus a job summary with the consumer install line.

### 4. Consumer setup (in the separate real project — one-time)

```ini
# .npmrc
@col:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

- `npm install @col/a2a-claude@beta` (or a pinned version, or a named channel).
- Core is pulled automatically as `@col/a2a-wrapper-core` via the same `@col` registry
  rule — nothing else to configure.
- GitHub Packages requires a token even for reads: a PAT with `read:packages` in the
  consumer's env/CI. One-time, free.

## Traceability — version vs dist-tag

- **Version** (`0.2.0-col.202610011430.9749bd5`): immutable identity of one build (the
  "SHA"). Never moves. Pin it for reproducibility.
- **dist-tag** (`beta`): a movable pointer to one version (the "branch pointer"). Each
  publish moves it to the newest build. Track it for "latest test build." Named tags
  (`sdk-next`, `thinking`) give per-workstream stable install targets.
- **Authoritative record:** the **GitHub Release** for each version lists exactly which
  refs (and SHAs) were assembled. "What's in the current beta?" = open the Release for the
  version `beta` points at.

## Rollout & migration (ordered; non-destructive first)

1. Create `release/col` from `upstream/main`; add the three machinery files; commit.
2. **Dry-run** the workflow (`dry_run=true`) to validate assembly + build + transform with
   no publish.
3. Cut the **first real beta** from the new pipeline (e.g. `refs=` the SDK-upgrade branch),
   install it in the consumer, confirm it runs.
4. Point the consumer at the new version / `@beta`; retire the `0.2.1-beta.8` dependency.
5. **Then** clean up the now-obsolete:
   - delete `publish/col-beta`, `publish/col-next`, `publish/col-next-bg-tasks`;
   - prune stale GitHub Packages versions (`0.1.0`, `0.2.0`, `0.2.1-beta.1 … beta.8`) once
     nothing references them.

## Risks & mitigations

- **Merge conflict during ref assembly** → workflow hard-fails with a clear message; the
  maintainer rebases the offending feature branch on current `upstream/main` and retries.
- **`release/col` drifting stale** → merge `upstream/main` into it before cutting builds;
  the machinery is tiny so conflicts are unlikely.
- **Consumer auth friction** (GH Packages needs a token for reads) → documented one-time
  PAT setup in `scripts/col-release/README.md`.
- **Upstream renames packages / restructures the workspace** → the transform's explicit
  name table and build steps are the single place to update.
- **Accidental non-upstreamable content in a build** → acceptable for a throwaway beta,
  but the GitHub Release manifest makes it visible which ref introduced it.

## Rollback

The system is additive. A bad build is superseded by the next publish or by moving the
`beta` tag back; nothing in git is mutated. Abandoning the approach = delete `release/col`
and the GH Packages versions; no other trace remains.

## Out of scope / deferred (tracked separately from this pipeline)

- Opening the focused upstream PRs for the five pending-code branches.
- Closing superseded fork PR #3.
- Decomposing `feat/a2a-claude-phase-2`.
- Automating `main` ← `upstream/main` sync.
