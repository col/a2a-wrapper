# @col Fork Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manual-dispatch CI pipeline that assembles 1..N refs, rewrites the two packages to the `@col` scope entirely in-runner, and publishes beta builds to GitHub Packages — so feature branches stay upstream-pure.

**Architecture:** All machinery lives on the `release/col` branch as two artifacts: a dependency-free Node transform (`scripts/col-release/transform.mjs`) that mutates `package.json` files in place, and a `workflow_dispatch` GitHub Actions workflow (`.github/workflows/col-release.yml`) that does ephemeral ref assembly → build → transform → publish → GitHub Release. Nothing transformed is ever committed.

**Tech Stack:** Node ≥20 (ESM), npm 10.9.2 workspaces, turbo build, GitHub Actions, GitHub Packages npm registry, `node:test` for the transform's unit tests.

**Spec:** `docs/superpowers/specs/2026-10-01-col-release-pipeline-design.md`

**Work branch:** Implement on `throng/AW-8` (already open as draft PR #6 targeting `release/col`). All new files are added to that PR. Do **not** add any of these files to `main`.

## Global Constraints

- Node `>=20`, package manager `npm@10.9.2`; all script files are ESM (`.mjs`).
- The transform script adds **no runtime/dev dependencies** — only `node:` built-ins; tests use `node:test` + `node:assert/strict`, run via `node --test`.
- Owner-parameterized, never hardcoded: scope derives from env `OWNER` (default `col`); registry from env `REGISTRY` (default `https://npm.pkg.github.com`).
- Scoped-name rule (verbatim): `scopedName(name, owner) = "@" + owner + "/" + name.replace(/^@/, "").replace(/\//g, "-")`. So `@a2a-wrapper/core` → `@col/a2a-wrapper-core`, `a2a-claude` → `@col/a2a-claude`.
- Version suffix (verbatim): `<baseVersion>-col.<stamp>.<shortsha>` where `stamp` = UTC `YYYYMMDDHHmm`, `shortsha` = 7-char assembled-commit SHA. Both packages share one suffix per run.
- Internal dependency stays keyed `@a2a-wrapper/core`; its value becomes `npm:@col/a2a-wrapper-core@<coreVersion>` (npm alias — no source edits anywhere).
- `publishConfig.registry` is set to `REGISTRY` on both packages. Cosmetic `repository`/`homepage`/`bugs` fields are left untouched.
- Workflow auth uses the built-in `GITHUB_TOKEN` only (no managed secrets).

## Review Focus

- **Merge conflict during ref assembly** — if any ref fails to merge onto the base, the run must stop with a non-zero exit and a clear message, never publish a partial tree. (Owned by Task 2; verified by the `set -e` + explicit conflict check and the dry-run checklist.)
- **`dry_run=true` must not mutate anything external** — no `npm publish`, no git tag, no GitHub Release. (Owned by Task 2; verified by dry-run checklist.)
- **Upstream renamed/removed the internal dep key** — if `a2a-claude`'s `dependencies["@a2a-wrapper/core"]` is absent, the transform must throw, not silently produce a build that resolves core from the public registry. (Owned by Task 1; test below.)
- **Re-running the transform / non-pristine base version** — if a base version already contains a `-col.` suffix, the transform must throw rather than emit `x-col.…-col.…`. (Owned by Task 1; test below.)
- **Unknown package handed to the transform** — `scopedName` must correctly handle both scoped (`@scope/x`) and unscoped (`x`) inputs; a name that is already `@col/*` is passed through unchanged. (Owned by Task 1; test below.)

---

### Task 1: Transform module + unit tests

**Files:**
- Create: `scripts/col-release/transform.mjs`
- Test: `scripts/col-release/transform.test.mjs`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (named ESM exports, all pure except `applyTransform`):
  - `scopedName(name: string, owner: string) -> string`
  - `computeVersion(baseVersion: string, stamp: string, shortsha: string) -> string` — throws `Error` if `baseVersion` contains `-col.`.
  - `transformCore(pkg: object, ctx: {owner, registry, version}) -> object` — returns a new manifest object (does not mutate input).
  - `transformClaude(pkg: object, ctx: {owner, registry, version, coreName, coreVersion}) -> object` — throws `Error` if `pkg.dependencies["@a2a-wrapper/core"]` is missing.
  - `applyTransform(repoRoot: string, ctx: {owner, registry, stamp, shortsha}) -> {core: {name, version}, claude: {name, version}, suffix: string}` — the CLI core: reads `packages/core/package.json` and `a2a-claude/package.json`, writes transformed versions back in place, returns the summary. The module is also runnable as a CLI (`node transform.mjs`) reading `OWNER`, `REGISTRY`, `STAMP`, `SHORTSHA`, `REPO_ROOT` from env, writing the summary object to stdout as JSON.

- [ ] **Step 1: Write the failing tests**

```js
// transform.test.mjs — node:test + node:assert/strict
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedName, computeVersion, transformCore, transformClaude } from "./transform.mjs";

test("scopedName flattens scoped and unscoped names", () => {
  assert.equal(scopedName("@a2a-wrapper/core", "col"), "@col/a2a-wrapper-core");
  assert.equal(scopedName("a2a-claude", "col"), "@col/a2a-claude");
});
test("scopedName passes through already-owner-scoped names", () => {
  assert.equal(scopedName("@col/a2a-claude", "col"), "@col/a2a-claude");
});
test("computeVersion appends the suffix", () => {
  assert.equal(computeVersion("0.2.0", "202610011430", "9749bd5"), "0.2.0-col.202610011430.9749bd5");
});
test("computeVersion rejects a non-pristine base version", () => {
  assert.throws(() => computeVersion("0.2.0-col.x.y", "s", "h"), /-col\./);
});
test("transformCore sets name, version, registry", () => {
  const out = transformCore({ name: "@a2a-wrapper/core", version: "2.1.1" },
    { owner: "col", registry: "https://npm.pkg.github.com", version: "2.1.1-col.s.h" });
  assert.equal(out.name, "@col/a2a-wrapper-core");
  assert.equal(out.version, "2.1.1-col.s.h");
  assert.equal(out.publishConfig.registry, "https://npm.pkg.github.com");
});
test("transformClaude rewrites the internal dep to an npm alias", () => {
  const out = transformClaude(
    { name: "a2a-claude", version: "0.2.0", dependencies: { "@a2a-wrapper/core": "2.1.1", express: "^4" } },
    { owner: "col", registry: "https://npm.pkg.github.com", version: "0.2.0-col.s.h",
      coreName: "@col/a2a-wrapper-core", coreVersion: "2.1.1-col.s.h" });
  assert.equal(out.name, "@col/a2a-claude");
  assert.equal(out.dependencies["@a2a-wrapper/core"], "npm:@col/a2a-wrapper-core@2.1.1-col.s.h");
  assert.equal(out.dependencies.express, "^4");
});
test("transformClaude throws when the internal dep key is missing", () => {
  assert.throws(() => transformClaude(
    { name: "a2a-claude", version: "0.2.0", dependencies: { express: "^4" } },
    { owner: "col", registry: "r", version: "v", coreName: "c", coreVersion: "cv" }), /a2a-wrapper\/core/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/col-release/`
Expected: FAIL (cannot find module `./transform.mjs` / exports undefined).

- [ ] **Step 3: Implement `transform.mjs`**

Implement the exports per the Interfaces block and Global Constraints. `transformCore`/`transformClaude` return shallow-cloned objects with fields set (preserve all other fields and key order via `{...pkg}`). `applyTransform` uses `node:fs` to read/write the two manifests with a trailing newline, computes each base version from the file's own `version`, derives `coreName`/`coreVersion` from the core result before transforming claude, and returns `{core, claude, suffix}`. Add a CLI guard (`if (import.meta.url === ...) { … }`) that reads env, calls `applyTransform`, and `console.log(JSON.stringify(summary))`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/col-release/`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/col-release/transform.mjs scripts/col-release/transform.test.mjs
git commit -m "feat(release): @col package transform with in-place manifest rewrite"
```

---

### Task 2: Publish workflow + README

**Files:**
- Create: `.github/workflows/col-release.yml`
- Create: `scripts/col-release/README.md`

**Interfaces:**
- Consumes: `scripts/col-release/transform.mjs` CLI (env in: `OWNER`, `REGISTRY`, `STAMP`, `SHORTSHA`, `REPO_ROOT`; stdout: `{core,claude,suffix}` JSON).
- Produces: a GitHub Release per build and published `@col/*` packages (no git-consumable interface).

- [ ] **Step 1: Write `col-release.yml`**

A `workflow_dispatch` workflow. Pin these decided values; write idiomatic YAML for the rest.
- **inputs:** `refs` (string, default `""`), `base` (string, default `upstream/main`), `dist_tag` (string, default `beta`), `dry_run` (boolean, default `false`).
- **permissions:** `contents: write`, `packages: write`.
- **job** on `ubuntu-latest`, steps (each shell step uses `set -euo pipefail`):
  1. `actions/checkout@v4` with `ref: release/col`, `fetch-depth: 0`.
  2. `actions/setup-node@v4` with `node-version: 20`, `registry-url: https://npm.pkg.github.com`, `scope: '@${{ github.repository_owner }}'`.
  3. Add remote `upstream` = `https://github.com/shashikanth-gs/a2a-wrapper.git`; `git fetch upstream` and `git fetch origin`.
  4. Assemble: `git checkout` the resolved `base` (map `upstream/main` → the fetched `upstream/main`); for each non-empty, comma/newline-split ref in `refs`, `git merge --no-edit <origin ref>`; **on merge failure, print the ref and `exit 1`.** Capture `SHORTSHA=$(git rev-parse --short=7 HEAD)` and `STAMP=$(date -u +%Y%m%d%H%M)`.
  5. `npm ci` then `npm run build` (turbo builds core before a2a-claude via its dep graph).
  6. Run the transform: `OWNER=${{ github.repository_owner }} REGISTRY=https://npm.pkg.github.com STAMP=$STAMP SHORTSHA=$SHORTSHA REPO_ROOT=$PWD node scripts/col-release/transform.mjs > summary.json`. Export `core`/`claude` `name@version` to `$GITHUB_ENV`.
  7. Publish: for `packages/core` then `a2a-claude`, run `npm publish --tag "${{ inputs.dist_tag }}"` (append `--dry-run` when `inputs.dry_run`), with `env: NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
  8. If **not** `dry_run`: create the Release — `gh release create "<claudeName>@<claudeVersion>" --title … --notes "<manifest>"` with `env: GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. Manifest body lists `base`, each ref with its `git rev-parse` SHA, and both published `name@version`.
  9. Always append to `$GITHUB_STEP_SUMMARY`: the published `name@version` lines and the consumer `npm install @<owner>/a2a-claude@<dist_tag>` command.

- [ ] **Step 2: Validate workflow YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/col-release.yml'))" && echo OK`
Expected: `OK` (and, if `actionlint` is available, `actionlint .github/workflows/col-release.yml` reports no errors).

- [ ] **Step 3: Write `scripts/col-release/README.md`**

Document: how to run a build (dispatch inputs, with examples for one ref and a stack), the dry-run first step, how versions/dist-tags/Releases relate, and the **consumer `.npmrc` + `read:packages` PAT** setup from the spec's §4.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/col-release.yml scripts/col-release/README.md
git commit -m "feat(release): manual @col publish workflow to GitHub Packages"
```

---

### Task 3: Move machinery onto `release/col` and dry-run validate

This task has no unit test; its deliverable is a validated, merged pipeline.

- [ ] **Step 1:** Ensure PR #6 (`throng/AW-8` → `release/col`) contains the spec + both new files; request review / merge it into `release/col`.
- [ ] **Step 2:** In the GitHub Actions tab, run **col-release** with `dry_run=true`, `refs` empty (base only). Confirm: assembly + `npm ci` + build + transform succeed, `npm publish --dry-run` lists both `@col/*` tarballs, and **no** Release/tag is created.
- [ ] **Step 3:** Run once more with `dry_run=true`, `refs=chore/update-claude-agent-sdk-0.3.226` to confirm single-ref assembly merges cleanly.
- [ ] **Step 4:** Report results back to the maintainer; do **not** cut a real (non-dry) beta until they confirm (that, plus consumer migration and `publish/*` + package pruning, is tracked separately in the spec's rollout §).

---

## Notes

The spec's rollout §5 (delete `publish/*`, prune stale GitHub Packages versions) and the out-of-scope items (upstream PRs, closing fork PR #3, decomposing `phase-2`, `main` auto-sync) are **not** part of this plan — they are separate follow-ups to schedule after the first real beta is cut and the consumer is migrated.
