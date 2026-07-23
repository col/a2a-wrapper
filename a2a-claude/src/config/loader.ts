/**
 * Configuration Loader
 *
 * Loads agent configuration from:
 *  1. JSON file (--config path)
 *  2. Environment variable overrides
 *  3. CLI argument overrides
 *
 * Merges in order: defaults ← JSON file ← env vars ← CLI args
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { substituteEnvTokensInString, substituteEnvTokensInRecord } from "@a2a-wrapper/core";
import { DEFAULTS } from "./defaults.js";
import type { AgentConfig, McpServerConfig } from "./types.js";

// ─── Deep Merge ─────────────────────────────────────────────────────────────

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    const tgtVal = result[key];
    if (
      tgtVal !== null &&
      srcVal !== null &&
      typeof tgtVal === "object" &&
      typeof srcVal === "object" &&
      !Array.isArray(tgtVal) &&
      !Array.isArray(srcVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

// ─── JSON File Loader ────────────────────────────────────────────────────────

export function loadConfigFile(filePath: string): AgentConfig {
  const absPath = resolve(filePath);
  try {
    const raw = readFileSync(absPath, "utf-8");
    return JSON.parse(raw) as AgentConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config file "${absPath}": ${msg}`);
  }
}

// ─── Environment Variable Overrides ─────────────────────────────────────────

export function loadEnvOverrides(): Partial<AgentConfig> {
  const cfg: Partial<AgentConfig> = {};

  // Server
  const port = process.env["PORT"];
  const hostname = process.env["HOSTNAME"];
  const advertiseHost = process.env["ADVERTISE_HOST"];
  if (port || hostname || advertiseHost) {
    cfg.server = {};
    if (port) cfg.server.port = parseInt(port, 10);
    if (hostname) cfg.server.hostname = hostname;
    if (advertiseHost) cfg.server.advertiseHost = advertiseHost;
  }

  // Claude
  const workspaceDir = process.env["WORKSPACE_DIR"];
  const claudeModel = process.env["CLAUDE_MODEL"];
  if (workspaceDir || claudeModel) {
    cfg.claude = {};
    if (workspaceDir) cfg.claude.workingDirectory = workspaceDir;
    if (claudeModel) cfg.claude.model = { name: claudeModel };
  }
  // ANTHROPIC_API_KEY is read directly by the SDK — never forwarded via config.

  // Features
  const streamArtifacts = process.env["STREAM_ARTIFACTS"];
  if (streamArtifacts) {
    cfg.features = { streamArtifactChunks: streamArtifacts === "true" };
  }

  // Logging
  const logLevel = process.env["LOG_LEVEL"];
  if (logLevel) {
    cfg.logging = { level: logLevel };
  }

  // Agent card
  const agentName = process.env["AGENT_NAME"];
  const agentDesc = process.env["AGENT_DESCRIPTION"];
  if (agentName || agentDesc) {
    cfg.agentCard = { name: agentName ?? "", description: agentDesc ?? "" };
  }

  return cfg;
}

// ─── Merge Pipeline ─────────────────────────────────────────────────────────

export function resolveConfig(
  configFilePath?: string,
  cliOverrides?: Partial<AgentConfig>,
): Required<AgentConfig> {
  let merged = deepMerge({}, DEFAULTS as unknown as Record<string, unknown>);

  if (configFilePath) {
    const fileConfig = loadConfigFile(configFilePath);
    assertMigratedModelShape(fileConfig.claude as Record<string, unknown> | undefined);
    merged = deepMerge(merged, fileConfig as unknown as Record<string, unknown>);
  }

  const envConfig = loadEnvOverrides();
  merged = deepMerge(merged, envConfig as unknown as Record<string, unknown>);

  if (cliOverrides) {
    merged = deepMerge(merged, cliOverrides as unknown as Record<string, unknown>);
  }

  // Substitute env-var tokens in claude paths, MCP args/env/headers, and sub-agent auth
  substituteEnvTokensInClaude(merged);
  substituteEnvTokensInMcp(merged);
  validateClaudeShape(merged);

  return merged as unknown as Required<AgentConfig>;
}

// ─── Env Token Substitution ─────────────────────────────────────────────────

function substituteEnvTokensInClaude(config: Record<string, unknown>): void {
  const claude = config.claude as Record<string, unknown> | undefined;
  if (!claude) return;

  if (typeof claude.workingDirectory === "string") {
    claude.workingDirectory = substituteEnvTokensInString(claude.workingDirectory);
  }
  const model = claude.model as Record<string, unknown> | undefined;
  if (model && typeof model.name === "string") {
    const resolved = substituteEnvTokensInString(model.name);
    model.name = resolved.includes("${") ? undefined : resolved || undefined;
  }
  if (Array.isArray(claude.plugins)) {
    for (const plugin of claude.plugins as Array<Record<string, unknown>>) {
      if (typeof plugin.path === "string") {
        plugin.path = substituteEnvTokensInString(plugin.path);
      }
    }
  }
  // Marketplace sources carry refs, URLs and (for private repos) credentials —
  // substitute every string field rather than an allowlist, since the SDK's
  // source shapes vary by kind and gain new fields over time.
  const marketplaces = claude.marketplaces as Record<string, Record<string, unknown>> | undefined;
  if (marketplaces) {
    for (const entry of Object.values(marketplaces)) {
      const source = entry?.source as Record<string, unknown> | undefined;
      if (source && typeof source === "object") {
        for (const [key, value] of Object.entries(source)) {
          if (typeof value === "string") source[key] = substituteEnvTokensInString(value);
        }
      }
      if (typeof entry?.installLocation === "string") {
        entry.installLocation = substituteEnvTokensInString(entry.installLocation);
      }
    }
  }
  if (Array.isArray(claude.additionalDirectories)) {
    claude.additionalDirectories = (claude.additionalDirectories as string[]).map((d) =>
      typeof d === "string" ? substituteEnvTokensInString(d) : d,
    );
  }
  if (typeof claude.executablePathOverride === "string") {
    claude.executablePathOverride = substituteEnvTokensInString(claude.executablePathOverride);
  }
}

function substituteEnvTokensInMcp(config: Record<string, unknown>): void {
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (!mcp) return;

  for (const serverCfg of Object.values(mcp)) {
    const srv = serverCfg as Record<string, unknown>;

    if (srv.type === "stdio") {
      if (Array.isArray(srv.args)) {
        srv.args = (srv.args as string[]).map((arg) =>
          typeof arg === "string" ? substituteEnvTokensInString(arg) : arg,
        );
      }
      if (srv.env && typeof srv.env === "object") {
        srv.env = substituteEnvTokensInRecord(srv.env as Record<string, string>);
      }
    } else if (srv.type === "http") {
      if (srv.headers && typeof srv.headers === "object") {
        srv.headers = substituteEnvTokensInRecord(srv.headers as Record<string, string>);
      }
    }
  }
}

// ─── Phase-2 Shape Validation ────────────────────────────────────────────────

const VALID_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);

// Guards against the removed string form of claude.model and the removed
// claude.fallbackModel field. Run once against the raw file config (before
// env/CLI merging can paper over a legacy shape) and again post-merge as a
// backstop.
function assertMigratedModelShape(claude: Record<string, unknown> | undefined): void {
  if (!claude) return;
  if (typeof claude.model === "string") {
    throw new Error(
      'claude.model is now an object — use claude.model.name.',
    );
  }
  if ("fallbackModel" in claude && claude.fallbackModel !== undefined) {
    throw new Error(
      "claude.fallbackModel has moved to claude.model.fallback.",
    );
  }
}

function validateClaudeShape(config: Record<string, unknown>): void {
  const claude = config.claude as Record<string, unknown> | undefined;
  if (!claude) return;

  assertMigratedModelShape(claude);

  const model = claude.model as Record<string, unknown> | undefined;
  if (model?.effort !== undefined && !VALID_EFFORT.has(model.effort as string)) {
    throw new Error(
      `claude.model.effort "${String(model.effort)}" is invalid. Allowed: low, medium, high, xhigh, max.`,
    );
  }

  const agents = claude.agents as Record<string, Record<string, unknown>> | undefined;
  if (agents) {
    for (const [name, def] of Object.entries(agents)) {
      if (typeof def?.description !== "string" || def.description.length === 0 ||
          typeof def?.prompt !== "string" || def.prompt.length === 0) {
        throw new Error(
          `claude.agents.${name} requires non-empty "description" and "prompt" fields.`,
        );
      }
    }
  }

  const plugins = claude.plugins as Array<Record<string, unknown>> | undefined;
  if (plugins) {
    plugins.forEach((plugin, i) => {
      if (plugin?.type !== "local" || typeof plugin?.path !== "string" || plugin.path.length === 0) {
        throw new Error(
          `claude.plugins[${i}] must be { "type": "local", "path": "<non-empty>" }.`,
        );
      }
    });
  }

  validateMarketplaceShape(claude);
}

// Catches a mistyped marketplace id or plugin key at config load, where the
// error names the offending field — rather than at startup, where the only
// symptom is a plugin that silently failed to install.
function validateMarketplaceShape(claude: Record<string, unknown>): void {
  const marketplaces = claude.marketplaces as Record<string, Record<string, unknown>> | undefined;
  if (marketplaces !== undefined) {
    if (typeof marketplaces !== "object" || Array.isArray(marketplaces)) {
      throw new Error('claude.marketplaces must be an object keyed by marketplace id.');
    }
    for (const [id, entry] of Object.entries(marketplaces)) {
      const source = entry?.source as Record<string, unknown> | undefined;
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new Error(`claude.marketplaces.${id} requires a "source" object.`);
      }
      if (typeof source.source !== "string" || source.source.length === 0) {
        throw new Error(
          `claude.marketplaces.${id}.source requires a non-empty "source" kind (e.g. "github", "git", "url", "npm").`,
        );
      }
    }
  }

  const enabled = claude.enabledPlugins as Record<string, unknown> | undefined;
  if (enabled === undefined) return;
  if (typeof enabled !== "object" || Array.isArray(enabled)) {
    throw new Error('claude.enabledPlugins must be an object keyed by "<plugin-id>@<marketplace-id>".');
  }
  for (const [key, value] of Object.entries(enabled)) {
    if (typeof value !== "boolean") {
      throw new Error(`claude.enabledPlugins["${key}"] must be a boolean.`);
    }
    const at = key.lastIndexOf("@");
    if (at <= 0 || at === key.length - 1) {
      throw new Error(
        `claude.enabledPlugins key "${key}" must be of the form "<plugin-id>@<marketplace-id>".`,
      );
    }
    const marketplaceId = key.slice(at + 1);
    if (!marketplaces || !(marketplaceId in marketplaces)) {
      throw new Error(
        `claude.enabledPlugins["${key}"] references marketplace "${marketplaceId}", which is not declared in claude.marketplaces.`,
      );
    }
  }
}

// Re-export McpServerConfig for use in loader consumers
export type { McpServerConfig };
