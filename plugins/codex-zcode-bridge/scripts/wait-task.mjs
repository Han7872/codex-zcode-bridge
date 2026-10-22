#!/usr/bin/env node
// Read-only task waiter for hosts that are notified when a background command
// exits (for example Claude Code `run_in_background`). It reads the Bridge task
// store and returns when the task needs the host: a pending interaction, a
// terminal status, or the deadline. It never writes Bridge state and is not a
// control path; act through the MCP tools (ADR-004, ADR-010).
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled", "waiting_for_master"]);
const SETTLED = new Set(["interaction_reply_submitted", "interaction_replied", "interaction_request_undeliverable", "interaction_request_oversized"]);
const INPUT_LIMIT = 4_000;
const OUTPUT_LIMIT = 1_500;
const SCHEMA = "zcode-bridge/wait-task-v1";

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { task: null, afterSeq: 0, timeoutS: 1_500, pollMs: 2_000, dataDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--help" || flag === "-h") throw new UsageError("");
    if (value === undefined) throw new UsageError(`missing value for ${flag}`);
    index += 1;
    if (flag === "--task") options.task = value;
    else if (flag === "--after-seq") options.afterSeq = integer(flag, value, 0, Number.MAX_SAFE_INTEGER);
    else if (flag === "--timeout-s") options.timeoutS = integer(flag, value, 1, 86_400);
    else if (flag === "--poll-ms") options.pollMs = integer(flag, value, 250, 60_000);
    else if (flag === "--data-dir") options.dataDir = value;
    else throw new UsageError(`unknown option ${flag}`);
  }
  if (!options.task || !TASK_ID.test(options.task)) throw new UsageError("--task must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
  return options;
}

function integer(flag, value, min, max) {
  if (!/^\d+$/u.test(value)) throw new UsageError(`${flag} must be an integer`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new UsageError(`${flag} must be within ${min}..${max}`);
  return parsed;
}

// Mirrors the plugin-mode data root: runtime-config.json overrides the
// environment (empty or null clears it), and an unset value falls back to
// the host settings directory. --data-dir overrides everything.
export function resolveDataDir(flag, env = process.env, home = homedir()) {
  if (flag) return requireAbsolute(flag, "--data-dir");
  const settingsDirectory = path.join(home, ".codex", "codex-zcode-bridge");
  let value = env["ZCODE_BRIDGE_DATA_DIR"]?.trim() ?? "";
  try {
    const parsed = JSON.parse(readFileSync(path.join(settingsDirectory, "runtime-config.json"), "utf8"));
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "ZCODE_BRIDGE_DATA_DIR")) {
      const configured = parsed["ZCODE_BRIDGE_DATA_DIR"];
      value = typeof configured === "string" ? configured.trim() : "";
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`cannot read Bridge runtime-config.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return requireAbsolute(value || settingsDirectory, "ZCODE_BRIDGE_DATA_DIR");
}

function requireAbsolute(value, label) {
  if (!path.isAbsolute(value)) throw new UsageError(`${label} must be an absolute path: ${value}`);
  return value;
}

function readStatus(taskDir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(taskDir, "status.json"), "utf8"));
    return parsed && typeof parsed.status === "string" ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`task not found: ${path.basename(taskDir)}`);
    return null; // A concurrent atomic replace can be retried on the next poll.
  }
}

function requestKey(requestId) {
  return typeof requestId === "string" ? requestId.replace(/^\d+:/u, "") : null;
}

// Tails events.jsonl from a byte cursor. A shorter file or a new generation
// marker means the log was replaced; the scan restarts from the beginning.
class EventTail {
  constructor(taskDir) {
    this.file = path.join(taskDir, "events.jsonl");
    this.genFile = path.join(taskDir, "events.gen");
    this.offset = 0;
    this.partial = "";
    this.generation = null;
  }

  read() {
    let generation = null;
    try { generation = readFileSync(this.genFile, "utf8").trim(); } catch { /* not created yet */ }
    let size = 0;
    try { size = statSync(this.file).size; } catch (error) { if (error?.code === "ENOENT") return { events: [], reset: false }; throw error; }
    let reset = false;
    if ((this.generation !== null && generation !== this.generation) || size < this.offset) {
      this.offset = 0;
      this.partial = "";
      reset = true;
    }
    this.generation = generation;
    if (size === this.offset) return { events: [], reset };
    const length = size - this.offset;
    const buffer = Buffer.alloc(length);
    const fd = openSync(this.file, "r");
    try {
      let done = 0;
      while (done < length) {
        const count = readSync(fd, buffer, done, length - done, this.offset + done);
        if (count === 0) break;
        done += count;
      }
      this.offset += done;
      const text = this.partial + buffer.subarray(0, done).toString("utf8");
      const lines = text.split("\n");
      this.partial = lines.pop() ?? "";
      const events = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* skip a damaged line */ }
      }
      return { events, reset };
    } finally {
      closeSync(fd);
    }
  }
}

function truncate(text, limit) {
  return text.length <= limit ? { text, truncated: false } : { text: `${text.slice(0, limit)}…`, truncated: true };
}

function describePending(event) {
  const details = event.details ?? {};
  const rawInput = details.preview ? details.input_preview : details.input;
  const input = truncate(typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? null), INPUT_LIMIT);
  return {
    seq: event.seq,
    request_id: details.request_id ?? null,
    method: details.method ?? null,
    tool: details.toolName ?? details.tool_name ?? null,
    reason: details.reason ?? null,
    preview: details.preview === true,
    input: input.text,
    input_truncated: input.truncated,
    full_request: details.full_request ?? null,
    questions: Array.isArray(details.questions) ? details.questions : undefined,
  };
}

export async function waitForTask(options, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const dataDir = resolveDataDir(options.dataDir);
  const taskDir = path.join(dataDir, ".tasks", options.task);
  const tail = new EventTail(taskDir);
  const started = now();
  const deadline = started + options.timeoutS * 1_000;
  const pending = new Map();
  let lastSeq = options.afterSeq;
  let recent = "";
  let seen = 0;
  for (;;) {
    const status = readStatus(taskDir);
    const { events, reset } = tail.read();
    if (reset) { pending.clear(); recent = ""; seen = 0; lastSeq = options.afterSeq; }
    for (const event of events) {
      if (typeof event.seq !== "number" || event.seq <= options.afterSeq) continue;
      seen += 1;
      lastSeq = Math.max(lastSeq, event.seq);
      const key = requestKey(event.details?.request_id);
      if (event.type === "interaction_requested" && key) pending.set(key, event);
      else if (SETTLED.has(event.type) && key) pending.delete(key);
      else if (event.type === "model_output" && typeof event.summary === "string") recent = (recent + event.summary).slice(-OUTPUT_LIMIT * 2);
    }
    const first = [...pending.values()].sort((a, b) => a.seq - b.seq)[0];
    const terminal = status && TERMINAL.has(status.status);
    const reason = first ? "interaction" : terminal ? "terminal" : now() >= deadline ? "timeout" : null;
    if (reason) {
      return {
        schema: SCHEMA,
        task_id: options.task,
        reason,
        status: status?.status ?? null,
        attempt: status?.attempt ?? null,
        elapsed_ms: now() - started,
        next_after_seq: lastSeq,
        events_seen: seen,
        pending: first ? describePending(first) : null,
        pending_count: pending.size,
        recent_output: recent.slice(-OUTPUT_LIMIT),
        note: "Observation only. Decide and act through zcode_events/zcode_interaction_reply; a preview is not the full request, and completed is not acceptance.",
      };
    }
    await sleep(Math.min(options.pollMs, Math.max(0, deadline - now())));
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (error.message) console.error(`wait-task: ${error.message}`);
    console.error("usage: node wait-task.mjs --task <task_id> [--after-seq N] [--timeout-s S] [--poll-ms MS] [--data-dir ABS_PATH]");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await waitForTask(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.reason === "timeout" ? 3 : 0;
  } catch (error) {
    console.error(`wait-task: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

// Run only as the process entry point so tests can import the functions.
function isEntry() {
  if (process.argv[1] === undefined) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = realpathSync(path.resolve(process.argv[1]));
    return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

if (isEntry()) await main();
