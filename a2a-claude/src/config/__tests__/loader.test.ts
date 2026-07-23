import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../loader.js";

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

  it("applies env overrides over file config, and CLI over env (model group)", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "Test", description: "d" },
      claude: { model: { name: "claude-from-file" } },
    }));
    process.env.CLAUDE_MODEL = "claude-from-env";
    let cfg = resolveConfig(p);
    expect(cfg.claude.model.name).toBe("claude-from-env");
    cfg = resolveConfig(p, { claude: { model: { name: "claude-from-cli" } } });
    expect(cfg.claude.model.name).toBe("claude-from-cli");
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

  it("clears model.name when its env token is unresolved", () => {
    delete process.env.NOPE_MODEL;
    delete process.env.CLAUDE_MODEL;
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { model: { name: "${NOPE_MODEL}" } },
    }));
    const cfg = resolveConfig(p);
    expect(cfg.claude.model.name).toBeUndefined();
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

  it("throws a descriptive error for a missing config file", () => {
    expect(() => resolveConfig(join(dir, "missing.json"))).toThrow(/Failed to load config file/);
  });

  it("rejects the removed string form of claude.model with a migration hint", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { model: "claude-sonnet-5" },
    }));
    expect(() => resolveConfig(p)).toThrow(/claude\.model\.name/);
  });

  it("rejects a string claude.model even when CLAUDE_MODEL is set in the environment", () => {
    process.env.CLAUDE_MODEL = "claude-from-env";
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { model: "claude-sonnet-5" },
    }));
    expect(() => resolveConfig(p)).toThrow(/claude\.model\.name/);
  });

  it("rejects the removed claude.fallbackModel field with a migration hint", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { fallbackModel: "claude-sonnet-5" },
    }));
    expect(() => resolveConfig(p)).toThrow(/claude\.model\.fallback/);
  });

  it("rejects an invalid model.effort value", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { model: { effort: "turbo" } },
    }));
    expect(() => resolveConfig(p)).toThrow(/effort/);
  });

  it("rejects an agents entry missing description or prompt", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { agents: { helper: { description: "", prompt: "x" } } },
    }));
    expect(() => resolveConfig(p)).toThrow(/agents\.helper/);
  });

  it("rejects a plugin entry with a non-local type or empty path", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { plugins: [{ type: "remote", path: "x" }] },
    }));
    expect(() => resolveConfig(p)).toThrow(/plugins\[0\]/);
  });

  it("substitutes env tokens in plugin paths", () => {
    process.env.PLUG_DIR = "/tmp/plugdir";
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { plugins: [{ type: "local", path: "${PLUG_DIR}" }] },
    }));
    const cfg = resolveConfig(p);
    expect(cfg.claude.plugins?.[0].path).toBe("/tmp/plugdir");
  });

  it("accepts a full valid phase-2 claude block", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: {
        model: { name: "claude-sonnet-5", fallback: "claude-haiku-4-5", thinking: { type: "adaptive" }, effort: "high" },
        agents: { reviewer: { description: "reviews", prompt: "You review." } },
        skills: ["pdf"],
        plugins: [{ type: "local", path: "/abs/plug" }],
        outputFormat: { type: "json_schema", schema: { type: "object" } },
      },
    }));
    const cfg = resolveConfig(p);
    expect(cfg.claude.model.effort).toBe("high");
    expect(cfg.claude.agents?.reviewer.prompt).toBe("You review.");
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
