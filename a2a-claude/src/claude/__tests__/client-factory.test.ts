import { describe, it, expect } from "vitest";
import { buildQueryOptions } from "../client-factory.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";

function cfg(claude: Partial<Required<AgentConfig>["claude"]> = {}, extra: Partial<AgentConfig> = {}): Required<AgentConfig> {
  return {
    ...DEFAULTS,
    ...extra,
    claude: { ...DEFAULTS.claude, workingDirectory: "/ws", ...claude },
  } as Required<AgentConfig>;
}

describe("buildQueryOptions", () => {
  it("maps core fields and enforces hardening flags", () => {
    const opts = buildQueryOptions(cfg({ model: { name: "claude-sonnet-5" }, maxTurns: 8, maxBudgetUsd: 2 }), {});
    expect(opts.cwd).toBe("/ws");
    expect(opts.model).toBe("claude-sonnet-5");
    expect(opts.permissionMode).toBe("acceptEdits");
    expect(opts.maxTurns).toBe(8);
    expect(opts.maxBudgetUsd).toBe(2);
    expect(opts.strictMcpConfig).toBe(true);   // always
    expect(opts.persistSession).toBe(true);    // always (resume requires it)
    expect(opts.settingSources).toEqual([]);   // isolation default
    expect(opts.includePartialMessages).toBe(false);
  });

  it("omits empty optional fields", () => {
    const opts = buildQueryOptions(cfg(), {});
    expect(opts.model).toBeUndefined();
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.disallowedTools).toBeUndefined();
    expect(opts.systemPrompt).toBeUndefined();
    expect(opts.resume).toBeUndefined();
    expect(opts.sandbox).toBeUndefined();
    // No marketplaces configured → no settings tier, no env override, so
    // existing consumers see byte-identical options.
    expect(opts.settings).toBeUndefined();
    expect(opts.env).toBeUndefined();
  });

  it("emits marketplaces as flag-tier settings alongside settingSources", () => {
    const marketplaces = {
      "superpowers-marketplace": {
        source: { source: "github", repo: "obra/superpowers-marketplace", ref: "v6.1.1" },
      },
    };
    const opts = buildQueryOptions(
      cfg({
        marketplaces,
        enabledPlugins: { "superpowers@superpowers-marketplace": true },
        settingSources: ["project"],
      }),
      {},
    );
    expect(opts.settings).toEqual({
      extraKnownMarketplaces: marketplaces,
      enabledPlugins: { "superpowers@superpowers-marketplace": true },
    });
    // settings is the flag tier, so it composes with settingSources rather
    // than replacing it — CLAUDE.md loading survives.
    expect(opts.settingSources).toEqual(["project"]);
  });

  it("forces synchronous plugin install without dropping the ambient env", () => {
    process.env.A2A_CLIENT_FACTORY_PROBE = "kept";
    try {
      const opts = buildQueryOptions(
        cfg({ marketplaces: { mk: { source: { source: "github", repo: "o/r" } } } }),
        {},
      );
      expect(opts.env?.["CLAUDE_CODE_SYNC_PLUGIN_INSTALL"]).toBe("1");
      expect(opts.env?.["A2A_CLIENT_FACTORY_PROBE"]).toBe("kept");
    } finally {
      delete process.env.A2A_CLIENT_FACTORY_PROBE;
    }
  });

  it("threads resume and abortController from the turn", () => {
    const ac = new AbortController();
    const opts = buildQueryOptions(cfg(), { resume: "sess-1", abortController: ac });
    expect(opts.resume).toBe("sess-1");
    expect(opts.abortController).toBe(ac);
  });

  it("maps systemPromptAppend to the claude_code preset with append", () => {
    const opts = buildQueryOptions(cfg({ systemPromptAppend: "Be careful." }), {});
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Be careful." });
  });

  it("maps customSystemPrompt to a plain string", () => {
    const opts = buildQueryOptions(cfg({ customSystemPrompt: "You are X." }), {});
    expect(opts.systemPrompt).toBe("You are X.");
  });

  it("enables includePartialMessages when streamArtifactChunks is on", () => {
    const c = cfg();
    c.features = { ...c.features, streamArtifactChunks: true };
    expect(buildQueryOptions(c, {}).includePartialMessages).toBe(true);
  });

  it("passes bypass flag and mcp servers through", () => {
    const c = cfg({ permissionMode: "bypassPermissions", dangerouslyAllowBypassPermissions: true });
    c.mcp = { srv: { type: "stdio", command: "x" } };
    const opts = buildQueryOptions(c, {});
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.mcpServers).toEqual({ srv: { type: "stdio", command: "x" } });
  });

  it("maps the model group (name, fallback, thinking, effort)", () => {
    const opts = buildQueryOptions(cfg({
      model: { name: "claude-sonnet-5", fallback: "claude-haiku-4-5", thinking: { type: "adaptive" }, effort: "xhigh" },
    }), {});
    expect(opts.model).toBe("claude-sonnet-5");
    expect(opts.fallbackModel).toBe("claude-haiku-4-5");
    expect(opts.thinking).toEqual({ type: "adaptive" });
    expect(opts.effort).toBe("xhigh");
  });

  it("passes agents, skills, plugins, and outputFormat through", () => {
    const opts = buildQueryOptions(cfg({
      agents: { reviewer: { description: "d", prompt: "p", tools: ["Read"] } },
      skills: ["pdf"],
      plugins: [{ type: "local", path: "/abs/plug" }],
      outputFormat: { type: "json_schema", schema: { type: "object" } },
    }), {});
    expect(opts.agents).toEqual({ reviewer: { description: "d", prompt: "p", tools: ["Read"] } });
    expect(opts.skills).toEqual(["pdf"]);
    expect(opts.plugins).toEqual([{ type: "local", path: "/abs/plug" }]);
    expect(opts.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });
  });

  it("omits phase-2 fields when unset and derives forwardSubagentText from features", () => {
    const base = buildQueryOptions(cfg(), {});
    expect(base.thinking).toBeUndefined();
    expect(base.effort).toBeUndefined();
    expect(base.agents).toBeUndefined();
    expect(base.skills).toBeUndefined();
    expect(base.plugins).toBeUndefined();
    expect(base.outputFormat).toBeUndefined();
    expect(base.forwardSubagentText).toBeUndefined();

    const c = cfg();
    c.features = { ...c.features, forwardSubagentText: true };
    expect(buildQueryOptions(c, {}).forwardSubagentText).toBe(true);
  });
});
