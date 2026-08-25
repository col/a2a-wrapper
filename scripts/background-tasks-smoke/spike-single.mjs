// Smoke test: one background task lifecycle.
// Proves that background_tasks_changed fires when a task finishes,
// and that a second result arrives on the same query (no second user message).
// COSTS REAL QUOTA: ~1 minute of model time.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

const PROMPT = `Run exactly this command as a background task (Bash with run_in_background: true):

sleep 40 && echo BUILD_FINISHED

Do NOT wait for it and do NOT poll it. Immediately end your turn with a single short
sentence saying you started it and are waiting for it to finish.`;

let closeInput;
const closed = new Promise((r) => { closeInput = r; });

async function* input() {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: PROMPT },
  };
  await closed;
}

const HARD_STOP_MS = 150_000;
const stopTimer = setTimeout(() => {
  log("### hard stop reached — closing input stream");
  closeInput();
}, HARD_STOP_MS);

let resultCount = 0;

const q = query({
  prompt: input(),
  options: {
    // An empty temp dir, not the repo: this runs unattended, and nothing it
    // does needs a working tree.
    cwd: mkdtempSync(join(tmpdir(), "bg-smoke-")),
    // `dontAsk` denies anything not pre-approved, so the shell family below is
    // the whole of what this can do — no file writes, no network tools. Note
    // this is deliberately not `bypassPermissions`, and not `auto` either: a
    // model classifier would make an unattended quota-spending run
    // non-deterministic.
    permissionMode: "dontAsk",
    allowedTools: ["Bash", "BashOutput", "KillShell"],
    settingSources: [],
    strictMcpConfig: true,
  },
});

const clip = (s, n = 90) => (typeof s === "string" ? s.replace(/\s+/g, " ").slice(0, n) : "");

try {
  for await (const m of q) {
    const key = m.type + (m.subtype ? `/${m.subtype}` : "");

    switch (key) {
      case "system/background_tasks_changed":
        log(`>>> ${key}`, JSON.stringify((m.tasks ?? []).map((t) => t.task_id)));
        break;
      case "system/session_state_changed":
        log(`>>> ${key}`, m.state);
        break;
      case "system/task_started":
        log(`    ${key}`, m.task_id, clip(m.description, 50));
        break;
      case "system/task_notification":
        log(`>>> ${key}`, m.task_id, m.status, clip(m.summary, 60));
        break;
      case "system/init":
        log(`    ${key}`, "session", m.session_id);
        break;
      // The run needs Bash and nothing else. If this fires, the pre-approved
      // tool list above is too narrow — widen it rather than reaching for
      // bypassPermissions.
      case "system/permission_denied":
        log(`!!! ${key}`, m.tool_name, clip(m.message, 80));
        break;
      case "stream_event":
        break;
      default: {
        if (m.type === "result") {
          resultCount += 1;
          log(`### RESULT #${resultCount} (${m.subtype})`, JSON.stringify(clip(m.result, 120)));
          // Decide nothing here — just observe whether more arrive.
        } else if (m.type === "assistant") {
          const blocks = m.message?.content ?? [];
          for (const b of blocks) {
            if (b.type === "text" && b.text?.trim()) log(`    assistant.text`, JSON.stringify(clip(b.text)));
            if (b.type === "tool_use") log(`    assistant.tool_use`, b.name, JSON.stringify(clip(JSON.stringify(b.input), 100)));
          }
        } else if (m.type === "user") {
          log(`    user`, `origin=${m.origin?.kind ?? "-"}`, m.isSynthetic ? "(synthetic)" : "");
        } else {
          log(`    ${key}`);
        }
      }
    }
  }
  log("### iterator completed normally");
} catch (err) {
  log("### iterator threw:", err?.name, clip(err?.message, 150));
} finally {
  clearTimeout(stopTimer);
  closeInput();
}

log(`### done — total results seen: ${resultCount}`);
process.exit(0);
