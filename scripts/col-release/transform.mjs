// @col fork release transform.
//
// Pure, dependency-free manifest rewrites plus an `applyTransform` driver that
// mutates the two workspace package.json files in place. Owner-parameterized:
// nothing about `col` or GitHub Packages is hardcoded here — it all comes from
// the caller / env, so this file is safe to keep on the release/col branch.
//
// See docs/superpowers/specs/2026-10-01-col-release-pipeline-design.md

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INTERNAL_DEP = "@a2a-wrapper/core";

/**
 * Map an upstream package name onto the fork's owner scope.
 * `@a2a-wrapper/core` -> `@col/a2a-wrapper-core`, `a2a-claude` -> `@col/a2a-claude`.
 * A name already under the owner scope is returned unchanged.
 */
export function scopedName(name, owner) {
  const prefix = `@${owner}/`;
  if (name.startsWith(prefix)) return name;
  const flat = name.replace(/^@/, "").replace(/\//g, "-");
  return `@${owner}/${flat}`;
}

/** Append the fork snapshot suffix to a pristine base version. */
export function computeVersion(baseVersion, stamp, shortsha) {
  if (baseVersion.includes("-col.")) {
    throw new Error(`base version is not pristine (already contains "-col."): ${baseVersion}`);
  }
  return `${baseVersion}-col.${stamp}.${shortsha}`;
}

/** Transform packages/core's manifest. Returns a new object; does not mutate input. */
export function transformCore(pkg, { owner, registry, version }) {
  return {
    ...pkg,
    name: scopedName(pkg.name, owner),
    version,
    publishConfig: { ...(pkg.publishConfig ?? {}), registry },
  };
}

/** Transform a2a-claude's manifest, aliasing the internal dep. Throws if the dep is absent. */
export function transformClaude(pkg, { owner, registry, version, coreName, coreVersion }) {
  if (!pkg.dependencies || !(INTERNAL_DEP in pkg.dependencies)) {
    throw new Error(`a2a-claude is missing its internal dependency "${INTERNAL_DEP}"`);
  }
  return {
    ...pkg,
    name: scopedName(pkg.name, owner),
    version,
    publishConfig: { ...(pkg.publishConfig ?? {}), registry },
    dependencies: {
      ...pkg.dependencies,
      [INTERNAL_DEP]: `npm:${coreName}@${coreVersion}`,
    },
  };
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeManifest(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * Read, transform, and write back the two workspace manifests in place.
 * Returns { core: {name, version}, claude: {name, version}, suffix }.
 */
export function applyTransform(repoRoot, { owner, registry, stamp, shortsha }) {
  const corePath = join(repoRoot, "packages/core/package.json");
  const claudePath = join(repoRoot, "a2a-claude/package.json");

  const corePkg = readManifest(corePath);
  const claudePkg = readManifest(claudePath);

  const coreVersion = computeVersion(corePkg.version, stamp, shortsha);
  const claudeVersion = computeVersion(claudePkg.version, stamp, shortsha);

  const core = transformCore(corePkg, { owner, registry, version: coreVersion });
  const claude = transformClaude(claudePkg, {
    owner,
    registry,
    version: claudeVersion,
    coreName: core.name,
    coreVersion: core.version,
  });

  writeManifest(corePath, core);
  writeManifest(claudePath, claude);

  return {
    core: { name: core.name, version: core.version },
    claude: { name: claude.name, version: claude.version },
    suffix: `${stamp}.${shortsha}`,
  };
}

// CLI entry: node transform.mjs  (driven by env, prints the summary as JSON)
if (import.meta.url === `file://${process.argv[1]}`) {
  const owner = process.env.OWNER || "col";
  const registry = process.env.REGISTRY || "https://npm.pkg.github.com";
  const stamp = process.env.STAMP;
  const shortsha = process.env.SHORTSHA;
  const repoRoot = process.env.REPO_ROOT || process.cwd();
  if (!stamp || !shortsha) {
    console.error("transform.mjs: STAMP and SHORTSHA env vars are required");
    process.exit(1);
  }
  const summary = applyTransform(repoRoot, { owner, registry, stamp, shortsha });
  console.log(JSON.stringify(summary));
}
