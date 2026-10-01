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
