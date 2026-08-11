# Disable Session TTL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `session.ttl <= 0` disable Claude session expiry entirely, and make that the default, so a conversation never silently loses its `contextId → sessionId` mapping.

**Architecture:** `SessionManager` has two independent eviction paths — a lazy age check inside `getOrCreate` and an eager `setInterval` sweep. Both must short-circuit when `ttl <= 0`, because as written today `ttl: 0` makes *both* evict everything rather than nothing (`age < 0` is never true; `now - lastAccessedAt > 0` is always true). The default in `defaults.ts` then changes from one hour to `0`.

**Tech Stack:** TypeScript, Vitest (`vitest --run`), Turborepo, Changesets.

**Spec:** `docs/superpowers/specs/2026-08-11-session-ttl-disable-design.md`

**Before you start:** `node`/`npm` are at `~/.local/bin` and may not be on the default PATH. Run `export PATH="$HOME/.local/bin:$PATH"` first. All test commands below run from the `a2a-claude/` directory.

---

### Task 1: `getOrCreate` never expires when ttl <= 0

**Files:**
- Modify: `a2a-claude/src/claude/session-manager.ts:44-52`
- Test: `a2a-claude/src/claude/__tests__/session-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `session-manager.test.ts`, inside the existing `describe("SessionManager", ...)` block:

```ts
  it("never expires sessions when ttl is 0", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: 0 });
    const s1 = m.getOrCreate("ctx-1");
    s1.sessionId = "sess-abc";
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000); // one week
    const s2 = m.getOrCreate("ctx-1");
    expect(s2).toBe(s1);
    expect(s2.sessionId).toBe("sess-abc");
  });

  it("treats a negative ttl as disabled", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: -1 });
    const s1 = m.getOrCreate("ctx-1");
    vi.advanceTimersByTime(86_400_000);
    expect(m.getOrCreate("ctx-1")).toBe(s1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/session-manager.test.ts -t "ttl is 0"
```

Expected: FAIL — the returned session is a new object, so `expect(s2).toBe(s1)` reports two different objects. This is because `age < ttl` is `age < 0`, false for every age, so the record is deleted and recreated.

- [ ] **Step 3: Implement the guard**

In `session-manager.ts`, change the ttl default on line 45 and the reuse condition on line 52:

```ts
    const ttl = sessionCfg.ttl ?? 0;
```

```ts
        const age = Date.now() - existing.createdAt;
        if (ttl <= 0 || age < ttl) {
          existing.lastAccessedAt = Date.now();
          log.debug("Reusing Claude session", { contextId, sessionId: existing.sessionId });
          return existing;
        }
```

Leave everything else in `getOrCreate` alone — the active-execution guard, the expiry log, and the delete all stay as they are.

- [ ] **Step 4: Run the full session-manager suite**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/session-manager.test.ts
```

Expected: PASS, all tests. The two pre-existing TTL tests (`"expires sessions past TTL"`, `"cleanup removes stale sessions but skips those with active executions"`) pass `ttl: 1000` explicitly, so they must still pass unchanged — that is the regression check that configured TTL behaviour is untouched.

- [ ] **Step 5: Commit**

```bash
git add a2a-claude/src/claude/session-manager.ts a2a-claude/src/claude/__tests__/session-manager.test.ts
git commit -m "fix(a2a-claude): treat session.ttl <= 0 as 'never expire' in getOrCreate"
```

---

### Task 2: Cleanup sweep does not run when ttl <= 0

**Files:**
- Modify: `a2a-claude/src/claude/session-manager.ts:107-122`
- Test: `a2a-claude/src/claude/__tests__/session-manager.test.ts`

This is the more dangerous of the two paths. With `ttl = 0`, the sweep's condition `now - session.lastAccessedAt > ttl` is true for every record on the very first tick, so it would delete the entire session map.

- [ ] **Step 1: Write the failing tests**

Add to `session-manager.test.ts`:

```ts
  it("does not evict during cleanup when ttl is 0", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: 0 });
    const s1 = m.getOrCreate("ctx-1");
    m.startCleanup(500, 0);
    vi.advanceTimersByTime(60_000);
    m.stopCleanup();
    expect(m.getOrCreate("ctx-1")).toBe(s1);
  });

  it("installs no cleanup timer when ttl is 0", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: 0 });
    m.startCleanup(500, 0);
    expect(vi.getTimerCount()).toBe(0);
    m.stopCleanup();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/session-manager.test.ts -t "ttl is 0"
```

Expected: FAIL. `"does not evict during cleanup"` fails because the sweep deleted `ctx-1` and `getOrCreate` returned a fresh object. `"installs no cleanup timer"` fails with `expected 1 to be 0`.

- [ ] **Step 3: Implement the guard**

Replace the opening of `startCleanup`:

```ts
  startCleanup(interval: number, ttl: number): void {
    if (ttl <= 0) {
      log.info("Session expiry disabled (ttl <= 0); sessions are retained until shutdown");
      return;
    }
    if (interval <= 0) return;
```

The rest of the method body is unchanged.

- [ ] **Step 4: Run the full session-manager suite**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/session-manager.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add a2a-claude/src/claude/session-manager.ts a2a-claude/src/claude/__tests__/session-manager.test.ts
git commit -m "fix(a2a-claude): skip the session cleanup sweep when ttl <= 0"
```

---

### Task 3: Change the default to 0

**Files:**
- Modify: `a2a-claude/src/config/defaults.ts:41`
- Modify: `a2a-claude/src/config/types.ts:143-151`
- Modify: `a2a-claude/src/claude/executor.ts:125-128`
- Test: `a2a-claude/src/config/__tests__/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `a2a-claude/src/config/__tests__/loader.test.ts`. If the file has no `DEFAULTS` import, add `import { DEFAULTS } from "../defaults.js";` at the top alongside the existing imports.

```ts
describe("session defaults", () => {
  it("disables session expiry by default", () => {
    expect(DEFAULTS.session.ttl).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd a2a-claude && npx vitest --run src/config/__tests__/loader.test.ts -t "disables session expiry"
```

Expected: FAIL with `expected 3600000 to be 0`.

- [ ] **Step 3: Change the default, the fallback, and the doc comment**

In `defaults.ts`, line 41:

```ts
    ttl: 0,
```

In `types.ts`, replace the `ttl` and `cleanupInterval` doc comments in `SessionConfig`:

```ts
  /**
   * Session idle TTL in ms. 0 or less disables session expiry entirely, so a
   * contextId keeps resuming the same Claude session indefinitely.
   * @default 0
   */
  ttl?: number;
  /** Session cleanup interval in ms. Only runs when ttl > 0. @default 300_000 */
  cleanupInterval?: number;
```

In `executor.ts`, the `startCleanup` call site — change the ttl fallback so a partial config object cannot resurrect the old default behind the new one:

```ts
    this.sessionManager.startCleanup(
      this.config.session.cleanupInterval ?? 300_000,
      this.config.session.ttl ?? 0,
    );
```

- [ ] **Step 4: Run the whole package suite**

```bash
cd a2a-claude && npm test
```

Expected: PASS, every test in the package. If any executor test breaks, it is because it relied on the one-hour default — report it rather than weakening the assertion.

- [ ] **Step 5: Typecheck**

```bash
cd a2a-claude && npm run typecheck
```

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add a2a-claude/src/config/defaults.ts a2a-claude/src/config/types.ts a2a-claude/src/claude/executor.ts a2a-claude/src/config/__tests__/loader.test.ts
git commit -m "feat(a2a-claude)!: disable session expiry by default (session.ttl 0)"
```

---

### Task 4: Update the shipped schema, example configs, and docs

**Files:**
- Modify: `a2a-claude/schemas/agent-config.schema.json:609-612`
- Modify: `a2a-claude/agents/example/config.json:46`
- Modify: `a2a-claude/agents/read-only-reviewer/config.json:44`
- Modify: `a2a-claude/README.md:185`
- Create: `.changeset/session-ttl-disabled-by-default.md`

This task matters more than it looks: both shipped example configs set `"ttl": 3600000` explicitly, so without this change anyone starting from an example still gets the old one-hour expiry regardless of the new default.

- [ ] **Step 1: Update the JSON schema**

In `a2a-claude/schemas/agent-config.schema.json`, replace the `ttl` and `cleanupInterval` descriptions inside the `SessionConfig` definition:

```json
        "cleanupInterval": {
          "description": "Session cleanup interval in ms (default: 300_000 = 5 min). Only runs when ttl > 0.",
          "type": "number"
        },
```

```json
        "ttl": {
          "description": "Session idle TTL in ms. 0 or less disables expiry entirely (default: 0 — sessions never expire).",
          "type": "number"
        }
```

- [ ] **Step 2: Update both example configs**

In `a2a-claude/agents/example/config.json` and `a2a-claude/agents/read-only-reviewer/config.json`, change the `ttl` line in the `session` block:

```json
    "ttl": 0,
```

Leave `cleanupInterval` as-is in both — it is inert when `ttl` is 0 and still documents the knob.

- [ ] **Step 3: Update the README**

In `a2a-claude/README.md`, change the `ttl` line in the session config example to `"ttl": 0,` and add a sentence immediately after that code block:

```markdown
`session.ttl` is the idle expiry for the `contextId` → Claude session mapping.
It defaults to `0`, which disables expiry: a conversation resumes the same
Claude session indefinitely. Set a positive value only if you want conversations
force-reset after a period of inactivity — note that when a session is evicted,
the next turn on that `contextId` starts a brand-new Claude session with no
memory of the conversation so far.
```

- [ ] **Step 4: Add the changeset**

Create `.changeset/session-ttl-disabled-by-default.md`:

```markdown
---
"a2a-claude": minor
---

Session expiry is now disabled by default (`session.ttl` defaults to `0`).

Previously sessions expired one hour after their **first** message regardless of
activity, which silently dropped the `contextId` → Claude session mapping and
made a conversation lose all of its context with no error and only an
`info`-level log line. Evicting the record reclaimed no disk either — the wrapper
never deletes SDK session files, so eviction orphaned the transcript rather than
removing it.

`session.ttl <= 0` now disables expiry in both eviction paths. A positive `ttl`
behaves as before. Both shipped example configs have been updated from
`3600000` to `0`.
```

- [ ] **Step 5: Verify the schema is still valid JSON and the suite still passes**

```bash
cd a2a-claude && node -e "JSON.parse(require('fs').readFileSync('schemas/agent-config.schema.json','utf8')); JSON.parse(require('fs').readFileSync('agents/example/config.json','utf8')); JSON.parse(require('fs').readFileSync('agents/read-only-reviewer/config.json','utf8')); console.log('json ok')" && npm test
```

Expected: `json ok` followed by a passing test run.

- [ ] **Step 6: Commit**

```bash
git add a2a-claude/schemas/agent-config.schema.json a2a-claude/agents/example/config.json a2a-claude/agents/read-only-reviewer/config.json a2a-claude/README.md .changeset/session-ttl-disabled-by-default.md
git commit -m "docs(a2a-claude): document ttl 0 default in schema, examples, and README"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run the whole monorepo suite**

```bash
export PATH="$HOME/.local/bin:$PATH" && npm test
```

Expected: all packages pass. `a2a-claude` is the only package changed, but the sweep confirms nothing in `packages/core` or the sibling wrappers depended on the old default.

- [ ] **Step 2: Typecheck and build the monorepo**

```bash
npm run typecheck && npm run build
```

Expected: both exit 0.

- [ ] **Step 3: Confirm no stray 3600000 remains in a2a-claude**

```bash
grep -rn "3600000\|3_600_000" a2a-claude/src a2a-claude/agents a2a-claude/schemas a2a-claude/README.md
```

Expected: no output. Any hit is a spot the default change missed.
