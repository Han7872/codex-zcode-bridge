import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WAITER = fileURLToPath(new URL("../../plugins/codex-zcode-bridge/scripts/wait-task.mjs", import.meta.url));
const TASK = "wait-fixture";

interface Fixture { root: string; dataDir: string; taskDir: string; home: string }

function fixture(status: string, events: object[]): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-wait-"));
  const dataDir = path.join(root, "data");
  const taskDir = path.join(dataDir, ".tasks", TASK);
  const home = path.join(root, "home");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(home);
  writeStatus(taskDir, status);
  writeFileSync(path.join(taskDir, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  writeFileSync(path.join(taskDir, "events.gen"), "gen-1");
  return { root, dataDir, taskDir, home };
}

function writeStatus(taskDir: string, status: string): void {
  writeFileSync(path.join(taskDir, "status.json"), JSON.stringify({ task_id: TASK, status, attempt: 2 }));
}

function childEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  for (const key of Object.keys(env)) if (key.startsWith("ZCODE_") && !(key in extra)) delete env[key];
  return env;
}

function run(args: string[], home: string, extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [WAITER, ...args], { env: childEnv(home, extra), encoding: "utf8", timeout: 20_000, windowsHide: true });
  return { status: result.status, stderr: result.stderr, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort().map((name) => {
    const stat = statSync(path.join(dir, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  });
}

const requested = (seq: number, id: string, extra: object = {}) => ({ seq, at: "t", type: "interaction_requested", summary: "s", details: { request_id: `1:${id}`, method: "interaction/requestPermission", toolName: "Bash", reason: "High risk", input: { command: `cmd-${seq}` }, ...extra } });
const replied = (seq: number, id: string) => ({ seq, at: "t", type: "interaction_replied", summary: "s", details: { request_id: id } });
const output = (seq: number, text: string) => ({ seq, at: "t", type: "model_output", summary: text });

test("terminal status returns at once with the cursor and without writing", () => {
  const f = fixture("waiting_for_master", [output(1, "hello "), output(2, "world")]);
  try {
    const before = snapshot(f.root);
    const result = run(["--task", TASK, "--data-dir", f.dataDir, "--timeout-s", "5"], f.home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.reason, "terminal");
    assert.equal(result.json.status, "waiting_for_master");
    assert.equal(result.json.attempt, 2);
    assert.equal(result.json.next_after_seq, 2);
    assert.equal(result.json.recent_output, "hello world");
    assert.deepEqual(snapshot(f.root), before, "the waiter must not create or modify files");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("reports the earliest unanswered request after the cursor; answered and older ones are ignored", () => {
  const f = fixture("running", [requested(3, "perm_old"), requested(5, "perm_answered"), replied(6, "perm_answered"), requested(7, "perm_a"), requested(9, "perm_b")]);
  try {
    const result = run(["--task", TASK, "--data-dir", f.dataDir, "--after-seq", "4", "--timeout-s", "5"], f.home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.reason, "interaction");
    assert.equal(result.json.pending.seq, 7);
    assert.equal(result.json.pending.request_id, "1:perm_a");
    assert.equal(result.json.pending.tool, "Bash");
    assert.equal(result.json.pending.input, JSON.stringify({ command: "cmd-7" }));
    assert.equal(result.json.pending_count, 2);
    assert.equal(result.json.next_after_seq, 9);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a preview request carries the preview text and the full_request reference, never a synthesized full input", () => {
  const reference = { file: "interactions/x.json", bytes: 90_000, sha256: "ab" };
  const f = fixture("running", [requested(2, "perm_big", { preview: true, input: undefined, input_preview: "{\"content\":\"abc", full_request: reference })]);
  try {
    const result = run(["--task", TASK, "--data-dir", f.dataDir, "--timeout-s", "5"], f.home);
    assert.equal(result.json.pending.preview, true);
    assert.equal(result.json.pending.input, "{\"content\":\"abc");
    assert.deepEqual(result.json.pending.full_request, reference);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("times out with exit 3 and keeps the given cursor when nothing new arrives", () => {
  const f = fixture("running", [output(1, "x")]);
  try {
    const result = run(["--task", TASK, "--data-dir", f.dataDir, "--after-seq", "1", "--timeout-s", "1", "--poll-ms", "250"], f.home);
    assert.equal(result.status, 3, result.stderr);
    assert.equal(result.json.reason, "timeout");
    assert.equal(result.json.next_after_seq, 1);
    assert.equal(result.json.pending, null);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("notices events appended while waiting, including a split final line", async () => {
  const f = fixture("running", [output(1, "start")]);
  try {
    const child = spawn(process.execPath, [WAITER, "--task", TASK, "--data-dir", f.dataDir, "--after-seq", "1", "--timeout-s", "15", "--poll-ms", "250"], { env: childEnv(f.home), windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const line = `${JSON.stringify(requested(2, "perm_late"))}\n`;
    await new Promise((resolve) => setTimeout(resolve, 600));
    appendFileSync(path.join(f.taskDir, "events.jsonl"), line.slice(0, 40));
    await new Promise((resolve) => setTimeout(resolve, 600));
    appendFileSync(path.join(f.taskDir, "events.jsonl"), line.slice(40));
    assert.equal(await exited, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.reason, "interaction");
    assert.equal(result.pending.request_id, "1:perm_late");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a replaced log generation restarts the scan instead of trusting the old cursor", async () => {
  const f = fixture("running", [output(1, "a"), requested(2, "perm_x"), replied(3, "perm_x")]);
  try {
    const child = spawn(process.execPath, [WAITER, "--task", TASK, "--data-dir", f.dataDir, "--timeout-s", "15", "--poll-ms", "250"], { env: childEnv(f.home), windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Longer than the old log, so only the generation marker reveals the rewrite.
    const filler = Array.from({ length: 20 }, (_, index) => `${JSON.stringify(output(index + 1, "replacement filler"))}\n`).join("");
    writeFileSync(path.join(f.taskDir, "events.gen"), "gen-2");
    writeFileSync(path.join(f.taskDir, "events.jsonl"), `${filler}${JSON.stringify(requested(30, "perm_y"))}\n`);
    assert.equal(await exited, 0);
    assert.equal(JSON.parse(stdout).pending.request_id, "1:perm_y");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("data root follows runtime-config over the environment, and --data-dir over both", () => {
  const f = fixture("completed", []);
  const settings = path.join(f.home, ".codex", "codex-zcode-bridge");
  try {
    mkdirSync(settings, { recursive: true });
    const wrong = path.join(f.root, "elsewhere");
    writeFileSync(path.join(settings, "runtime-config.json"), JSON.stringify({ ZCODE_BRIDGE_DATA_DIR: f.dataDir }));
    assert.equal(run(["--task", TASK, "--timeout-s", "2"], f.home, { ZCODE_BRIDGE_DATA_DIR: wrong }).json.reason, "terminal");

    writeFileSync(path.join(settings, "runtime-config.json"), JSON.stringify({ ZCODE_BRIDGE_DATA_DIR: null }));
    const cleared = run(["--task", TASK, "--timeout-s", "2"], f.home, { ZCODE_BRIDGE_DATA_DIR: f.dataDir });
    assert.equal(cleared.status, 2, "a null config value clears the environment and falls back to the settings directory");
    assert.match(cleared.stderr, /task not found/);

    assert.equal(run(["--task", TASK, "--data-dir", f.dataDir, "--timeout-s", "2"], f.home, { ZCODE_BRIDGE_DATA_DIR: wrong }).json.reason, "terminal");
    const relative = run(["--task", TASK, "--data-dir", "relative/dir"], f.home);
    assert.equal(relative.status, 2);
    assert.match(relative.stderr, /absolute path/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects invalid task ids and unknown options before reading anything", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bridge-wait-home-"));
  try {
    for (const args of [["--task", "../escape"], ["--task", TASK, "--bogus", "1"], ["--task", TASK, "--timeout-s", "0"]]) {
      const result = run(args, home);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, /usage: node wait-task\.mjs/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
