// Smoke test: two-stage background task chain.
// Proves that the hold loop spans multiple rounds: at each result, the executor
// decides HOLD if background tasks are still live, COMPLETE only when the set is empty.
// Also validates that bg_changed for a newly started task lands before its result.
// COSTS REAL QUOTA: ~2 minutes of model time.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

const PROMPT = `You will run a two-stage pipeline using background tasks.

STAGE 1: Run exactly this as a background Bash task (run_in_background: true):
  sleep 20 && echo STAGE_ONE_DONE
Do NOT wait for it or poll it. Immediately end your turn saying stage 1 is running.

STAGE 2: When you are notified that stage 1 finished, immediately start exactly this
as a background Bash task (run_in_background: true):
  sleep 20 && echo STAGE_TWO_DONE
Again do NOT wait or poll. Immediately end your turn saying stage 2 is running.

FINALLY: When you are notified that stage 2 finished, report both stages and stop.`;

let closeInput;
const closed = new Promise((r) => { closeInput = r; });

async function* input() {
  yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: PROMPT } };
  await closed;
}

const stopTimer = setTimeout(() => { log("### hard stop — closing input"); closeInput(); }, 180_000);

// Mirror the proposed executor logic exactly: track the level set, and at each
// result decide hold-vs-complete from it.
// Expected: one decision per result, at least one `HOLD (waiting on <ids>)`
// followed by a final `COMPLETE`.
const live = new Set();
let results = 0;
const decisions = [];

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

    if (key === "system/background_tasks_changed") {
      live.clear();
      for (const t of m.tasks ?? []) live.add(t.task_id);
      log(`>>> bg_changed`, JSON.stringify([...live]));
    } else if (key === "system/session_state_changed") {
      log(`>>> session_state_changed`, m.state);
    } else if (key === "system/init") {
      log(`    init (session ${m.session_id})`);
    } else if (key === "system/task_notification") {
      log(`    task_notification`, m.task_id, m.status);
    } else if (key === "system/permission_denied") {
      // The run needs Bash and nothing else. If this fires, the pre-approved
      // tool list above is too narrow — widen it rather than reaching for
      // bypassPermissions. This branch matters: everything unmatched below is
      // dropped silently, so without it a denial would look like a stalled run.
      log(`!!! permission_denied`, m.tool_name, clip(m.message, 80));
    } else if (m.type === "result") {
      results += 1;
      const decision = live.size > 0 ? `HOLD (waiting on ${[...live].join(",")})` : "COMPLETE";
      decisions.push(decision);
      log(`### RESULT #${results} (${m.subtype}) -> ${decision}`);
      log(`      text: ${JSON.stringify(clip(m.result, 110))}`);
      if (live.size === 0) { log("### set empty at result — closing input"); closeInput(); }
    } else if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_use") log(`    tool_use`, b.name, JSON.stringify(clip(JSON.stringify(b.input), 80)));
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

log(`### results=${results} decisions=${JSON.stringify(decisions)}`);
process.exit(0);
