import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../loader.js";
import { DEFAULTS } from "../defaults.js";

describe("resolveConfig", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "a2a-claude-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("returns secure defaults when no inputs given", () => {
    delete process.env.WORKSPACE_DIR;
    delete process.env.CLAUDE_MODEL;
    const cfg = resolveConfig();
    expect(cfg.server.port).toBe(3030);
    expect(cfg.claude.permissionMode).toBe("acceptEdits");
    expect(cfg.claude.settingSources).toEqual([]);
    expect(cfg.features.streamArtifactChunks).toBe(false);
    expect(cfg.features.emitTodoEvents).toBe(true);
  });

  it("merges file config over defaults", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "Test", description: "d" },
      claude: { permissionMode: "plan", maxTurns: 5 },
    }));
    const cfg = resolveConfig(p);
    expect(cfg.agentCard.name).toBe("Test");
    expect(cfg.claude.permissionMode).toBe("plan");
    expect(cfg.claude.maxTurns).toBe(5);
    expect(cfg.server.port).toBe(3030); // default preserved
  });

  it("applies env overrides over file config, and CLI over env", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "Test", description: "d" },
      claude: { model: "claude-from-file" },
    }));
    process.env.CLAUDE_MODEL = "claude-from-env";
    let cfg = resolveConfig(p);
    expect(cfg.claude.model).toBe("claude-from-env");
    cfg = resolveConfig(p, { claude: { model: "claude-from-cli" } });
    expect(cfg.claude.model).toBe("claude-from-cli");
  });

  it("substitutes ${ENV_VAR} tokens in workingDirectory", () => {
    process.env.MY_WS = "/tmp/my-workspace";
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { workingDirectory: "${MY_WS}" },
    }));
    const cfg = resolveConfig(p);
    expect(cfg.claude.workingDirectory).toBe("/tmp/my-workspace");
  });

  it("clears model when its env token is unresolved", () => {
    delete process.env.NOPE_MODEL;
    delete process.env.CLAUDE_MODEL;
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { model: "${NOPE_MODEL}" },
    }));
    const cfg = resolveConfig(p);
    expect(cfg.claude.model).toBeUndefined();
  });

  it("substitutes env tokens in MCP stdio args/env and http headers", () => {
    process.env.MY_TOKEN = "sekret";
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      mcp: {
        a: { type: "stdio", command: "x", args: ["${MY_TOKEN}"], env: { T: "${MY_TOKEN}" } },
        b: { type: "http", url: "https://x", headers: { Authorization: "Bearer ${MY_TOKEN}" } },
      },
    }));
    const cfg = resolveConfig(p);
    expect((cfg.mcp.a as { args: string[] }).args[0]).toBe("sekret");
    expect((cfg.mcp.b as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer sekret");
  });

  it("applies CLAUDE_EFFORT as an env override", () => {
    delete process.env.WORKSPACE_DIR;
    process.env.CLAUDE_EFFORT = "xhigh";
    expect(resolveConfig().claude.effort).toBe("xhigh");
  });

  it("leaves effort undefined when CLAUDE_EFFORT is unset", () => {
    delete process.env.CLAUDE_EFFORT;
    expect(resolveConfig().claude.effort).toBeUndefined();
  });

  it("throws a descriptive error for a missing config file", () => {
    expect(() => resolveConfig(join(dir, "missing.json"))).toThrow(/Failed to load config file/);
  });

  // ── Marketplace plugins ───────────────────────────────────────────────────

  function writeMarketplaceConfig(dirPath: string, claude: Record<string, unknown>): string {
    const p = join(dirPath, "config.json");
    writeFileSync(p, JSON.stringify({ agentCard: { name: "T", description: "d" }, claude }));
    return p;
  }

  const SUPERPOWERS = {
    "superpowers-marketplace": {
      source: { source: "github", repo: "obra/superpowers-marketplace", ref: "v6.1.1" },
    },
  };

  it("accepts marketplaces with enabled plugins", () => {
    const p = writeMarketplaceConfig(dir, {
      marketplaces: SUPERPOWERS,
      enabledPlugins: { "superpowers@superpowers-marketplace": true },
    });
    const cfg = resolveConfig(p);
    expect(cfg.claude.marketplaces?.["superpowers-marketplace"].source.repo).toBe(
      "obra/superpowers-marketplace",
    );
    expect(cfg.claude.enabledPlugins?.["superpowers@superpowers-marketplace"]).toBe(true);
  });

  it("rejects a marketplace without a source kind", () => {
    const p = writeMarketplaceConfig(dir, { marketplaces: { mk: { source: { repo: "o/r" } } } });
    expect(() => resolveConfig(p)).toThrow(/claude\.marketplaces\.mk\.source/);
  });

  it("rejects an enabledPlugins key that is not plugin@marketplace", () => {
    const p = writeMarketplaceConfig(dir, {
      marketplaces: SUPERPOWERS,
      enabledPlugins: { superpowers: true },
    });
    expect(() => resolveConfig(p)).toThrow(/"<plugin-id>@<marketplace-id>"/);
  });

  it("rejects an enabledPlugins key naming an undeclared marketplace", () => {
    const p = writeMarketplaceConfig(dir, {
      marketplaces: SUPERPOWERS,
      enabledPlugins: { "superpowers@typo-marketplace": true },
    });
    expect(() => resolveConfig(p)).toThrow(/"typo-marketplace", which is not declared/);
  });

  it("substitutes env tokens throughout a marketplace source", () => {
    process.env.MK_REF = "v9.9.9";
    process.env.MK_TOKEN = "ghp_secret";
    const p = writeMarketplaceConfig(dir, {
      marketplaces: {
        mk: { source: { source: "git", url: "https://x@git/r.git", ref: "${MK_REF}", token: "${MK_TOKEN}" } },
      },
      enabledPlugins: { "p@mk": true },
    });
    const cfg = resolveConfig(p);
    const source = cfg.claude.marketplaces!.mk.source;
    expect(source.ref).toBe("v9.9.9");
    expect(source.token).toBe("ghp_secret");
  });
});

describe("session defaults", () => {
  it("disables session expiry by default", () => {
    expect(DEFAULTS.session.ttl).toBe(0);
  });
});
