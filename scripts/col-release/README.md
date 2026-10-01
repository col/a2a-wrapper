# col-release — fork beta publishing to GitHub Packages

Tooling that publishes `@col`-scoped beta builds of `a2a-claude` and
`@a2a-wrapper/core` to GitHub Packages, **without** ever committing the fork
scope rename to a feature branch.

Design: [`docs/superpowers/specs/2026-10-01-col-release-pipeline-design.md`](../../docs/superpowers/specs/2026-10-01-col-release-pipeline-design.md)

## How it fits together

- **`main`** is a pure mirror of `upstream/main`; feature branches are cut from it
  and PR'd upstream unchanged.
- **`release/col`** (this branch) holds the only fork-specific files: this directory
  and `.github/workflows/col-release.yml`. It is never merged upstream.
- The `@col` rename, dependency aliasing, `publishConfig.registry`, and snapshot
  version are applied **in the CI runner only** by `transform.mjs`, then discarded.

## Cutting a build

Run the **col-release** workflow from the repository's **Actions** tab
(`workflow_dispatch`). Inputs:

| Input | Default | Meaning |
|-------|---------|---------|
| `refs` | `""` | Feature branches on `origin` to merge onto `base`, comma/newline separated. Empty = base only. |
| `base` | `upstream/main` | Ref the build is assembled on top of. |
| `dist_tag` | `beta` | npm dist-tag to publish under. Use a named channel (e.g. `sdk-next`) to give a workstream a stable install target. |
| `dry_run` | `false` | Build and `npm pack` only — no publish, no Release. |

Examples:
- One feature on top of upstream: `refs=chore/update-claude-agent-sdk-0.3.226`
- A stack: `refs=fix/thinking-events, throng/TX-123-graceful-cancel`

**Always dry-run first** (`dry_run=true`) when validating a new combination — it
runs assembly + build + transform + `npm publish --dry-run` with no side effects.

A merge conflict during assembly fails the run; rebase the offending feature
branch on current `upstream/main` and retry.

## Versions, dist-tags, and Releases

- **Version** — `<base>-col.<UTCstamp>.<shortsha>`, e.g.
  `0.4.1-col.202610011430.9749bd5`. Immutable; pin it for reproducibility.
- **dist-tag** — a movable pointer (`beta`, or a named channel). `@col/a2a-claude@beta`
  always resolves to the newest build published under `beta`.
- **GitHub Release** — created per non-dry build, tagged `col-release/<version>`.
  Its notes are the authoritative manifest: base, each merged ref with its SHA, and
  both published `name@version`. "What's in the current beta?" → open the Release for
  the version `beta` points at.

## Consuming the packages (in the separate project)

GitHub Packages requires auth even for reads. One-time setup in the consuming
project:

```ini
# .npmrc
@col:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

`GITHUB_PACKAGES_TOKEN` is a Personal Access Token with the `read:packages` scope,
provided via the environment (locally and in CI). Then:

```bash
npm install @col/a2a-claude@beta       # or a pinned @0.4.1-col.<suffix>
```

`@col/a2a-wrapper-core` is pulled automatically via the npm alias and the same
`@col` registry rule — no other configuration needed, and no source imports change.

## Local check of the transform

```bash
node --test scripts/col-release/        # unit tests
```
