---
"a2a-claude": minor
---

Add marketplace plugin support: `claude.marketplaces` and `claude.enabledPlugins` map to the SDK's flag-tier `settings` (`extraKnownMarketplaces` / `enabledPlugins`), so the SDK fetches and installs plugins itself — no pre-baked plugin directories, and no dependence on `settingSources` (marketplace plugins load even under full isolation).

Because the SDK installs marketplace plugins asynchronously by default — installing nothing, reporting no error, and loading zero plugins on every subsequent run — the wrapper sets `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` for those sessions and runs a startup preflight that verifies every enabled plugin actually loaded, failing `initialize()` with the missing plugin names if not. The preflight diffs the session init message's plugin list rather than the `plugin_install` events, which report per-marketplace status and so read as successful even when the named plugin does not exist. The probe costs no tokens (init precedes any model call) and warms the plugin cache.
