---
"a2a-claude": minor
---

Phase 2: native Claude subagents, skills/plugins, per-agent structured outputs (DataPart artifact), usage/cost telemetry (OTel-aligned trace artifact), and model controls (thinking/effort). Config-breaking: `claude.model` is now an object (`model.name`, `model.fallback`) and `claude.fallbackModel` is removed.
