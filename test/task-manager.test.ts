// TaskManager lifecycle tests: strict validation, bounded global worker
// slots, FIFO queueing, state transitions, continuation evidence, cancellation
// confirmation, and crash recovery with worker_lost — all against a real
// TaskStore in a temp directory with fake workers. No model calls.
import assert from "node:assert/strict";
import { utimesSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeManagerFixture,
  FakeAdapter,
  type ManagerFixture,
} from "./manager-helpers.js";
import { TaskStore } from "../src/store/task-store.js";
import { TaskManagerError } from "../src/manager/errors.js";
import { withProcessLock } from "../src/store/process-lock.js";
import { runWorkerTask } from "../src/worker/run-task.js";
import { makeTask } from "./helpers.js";

const CREATED_AT = "2026-09-27T00:00:00.000Z";

async function freshFixture(): Promise<ManagerFixture> {
  return makeManagerFixture();
}

function errorCodeOf(error: unknown): string {
  assert.ok(error instanceof TaskManagerError, `expected TaskManagerError, got ${String(error)}`);
  return error.code;
}

test("invalid task packages are rejected with TASK_INVALID and leave no records", async () => {
  const fx = await freshFixture();
  try {
    const cases: Array<Record<string, unknown>> = [
      { task_id: "bad id!", objective: "x" },
      { task_id: "task_v", objective: "  " },
      { task_id: "task_v", objective: "obj", requirements: "not-an-array" },
      { task_id: "task_v", objective: "obj", allowed_paths: undefined },
      { task_id: "task_v", objective: "obj", test_commands: [1] },
      { task_id: "task_v", objective: "obj", workspace: "relative/path" },
      { ...fx.makeTask(), model: { provider_id: "", model_id: "model" } },
      { ...fx.makeTask(), model: { provider_id: "provider", model_id: "" } },
      { ...fx.makeTask(), model: { provider_id: "provider", model_id: "model", reasoning_level: " " } },
    ];
    for (const overrides of cases) {
      const task = { ...fx.makeTask(), ...overrides } as ReturnType<ManagerFixture["makeTask"]>;
      await assert.rejects(fx.manager.createTask(task), (error: unknown) => {
        assert.equal(errorCodeOf(error), "TASK_INVALID");
        return true;
      });
    }
    assert.deepEqual(fx.store.listTaskIds(), []);
  } finally {
    await fx.cleanup();
  }
});

test("same task_id and payload replays the original receipt; changed payload conflicts", async () => {
  const fx = await freshFixture();
  try {
    const task = fx.makeTask();
    const first = await fx.manager.createTask(task);
    const spawned = fx.spawned.length;
    assert.deepEqual(await fx.manager.createTask(task), first);
    assert.equal(fx.spawned.length, spawned);
    await assert.rejects(
      fx.manager.createTask({ ...task, objective: "different request" }),
      (error: unknown) => errorCodeOf(error) === "TASK_ID_CONFLICT",
    );
  } finally {
    await fx.cleanup();
  }
});

test("with a free slot the task starts immediately as running with a persisted pid", async () => {
  const fx = await freshFixture();
  try {
    const receipt = await fx.manager.createTask(fx.makeTask());
    assert.equal(receipt.status, "running");
    assert.equal(fx.spawned.length, 1);
    assert.equal(fx.spawned[0]!.taskId, "task_1");
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "running");
    assert.equal(status.worker_pid, fx.spawned[0]!.pid);
    assert.equal(status.attempt, 1);
  } finally {
    await fx.cleanup();
  }
});

test("each scheduling operation validates historical records once and observes later changes", async () => {
  const fx = await freshFixture();
  try {
    const historical = fx.makeTask({ task_id: "historical" });
    fx.store.createTask(historical, CREATED_AT);
    fx.store.writeWorkspaceRef(historical.task_id, { requestedPath: fx.workspaceDir, canonicalPath: fx.workspaceDir, mode: "direct" });
    fx.store.writeStatus(historical.task_id, { status: "completed", worker_pid: null });
    const originalRead = fx.store.readTask.bind(fx.store);
    let historicalReads = 0;
    fx.store.readTask = (taskId) => {
      if (taskId === historical.task_id) historicalReads += 1;
      return originalRead(taskId);
    };
    await fx.manager.createTask(fx.makeTask());
    assert.equal(historicalReads, 1, "one health-validation pass, even with free slots");
    await fx.runWorker("task_1", new FakeAdapter());
    // A new operation must see cleanup occupancy added after the first scan.
    fx.store.writeStatus(historical.task_id, { cleanup_unverified: true });
    historicalReads = 0;
    const next = await fx.manager.createTask(fx.makeTask({ task_id: "task_2" }));
    assert.equal(historicalReads, 1, "no cached terminal status across operations");
    assert.equal(next.status, "queued");
    assert.equal(fx.spawned.length, 1, "unverified historical cleanup still occupies the workspace");
  } finally {
    await fx.cleanup();
  }
});

test("getFeedback aggregates allowlisted current-attempt events across event pages", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const status = await fx.manager.getStatus("task_1");
    const observedAt = new Date().toISOString();
    for (let index = 0; index < 205; index += 1) {
      fx.store.appendEvent("task_1", "model_output", "visible output must not enter snapshot", undefined, observedAt);
    }
    fx.store.appendEvent("task_1", "model_selected", "model selected", {
      requested_model: "requested/model",
      provider_id: "runtime-provider",
      model_id: "runtime-model",
      reasoning_level: "high",
      reasoning_level_source: "runtime",
    }, observedAt);
    fx.store.appendEvent("task_1", "tool_status", "Write: running", {
      tool_name: "Write",
      state: "running",
      arguments: { content: "private" },
    }, observedAt);

    const feedback = await fx.manager.getFeedback("task_1");
    assert.equal(feedback.status, "running");
    assert.equal(feedback.model?.model_id, "runtime-model");
    assert.equal(feedback.activity?.kind, "tool_update");
    assert.equal(feedback.activity?.summary, "Tool update · Write");
    assert.equal(feedback.activity?.currentness, "last_observed");
    assert.equal(feedback.result, null);
    assert.doesNotMatch(JSON.stringify(feedback), /requested\/model|visible output|private/u);
    assert.doesNotMatch(feedback.activity?.summary ?? "", /running/iu);
  } finally {
    await fx.cleanup();
  }
});

test("status snapshot reads bypass the manager scheduling lock", async () => {
  const fx = await freshFixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    await fx.manager.createTask(fx.makeTask());
    const lock = withProcessLock(path.join(fx.store.tasksRoot, ".manager.lock"), () => blocked);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "running");
    release();
    await lock;
  } finally {
    release();
    await fx.cleanup();
  }
});

test("a second task queues FIFO and starts only after the slot frees", async () => {
  const fx = await freshFixture();
  try {
    const first = await fx.manager.createTask(fx.makeTask({ task_id: "task_a" }));
    assert.equal(first.status, "running");
    const second = await fx.manager.createTask(fx.makeTask({ task_id: "task_b" }));
    assert.equal(second.status, "queued");
    assert.equal(fx.spawned.length, 1, "no second worker while the slot is busy");

    // The first worker completes; the reconcile tick pumps the queue.
    await fx.runWorker("task_a", new FakeAdapter());
    await fx.manager.recoverTasks();
    assert.equal(fx.spawned.length, 2);
    assert.equal(fx.spawned[1]!.taskId, "task_b");
    const status = await fx.manager.getStatus("task_b");
    assert.equal(status.status, "running");
  } finally {
    await fx.cleanup();
  }
});

test("different project roots run concurrently while the same mutable directory is serialized", async () => {
  const fx = await makeManagerFixture({ maxConcurrentWorkers: 2 });
  const otherProject = await mkdtemp(path.join(tmpdir(), "zcode-bridge-project-"));
  try {
    const first = await fx.manager.createTask(fx.makeTask({ task_id: "project_a_1" }));
    const sameDirectory = await fx.manager.createTask(fx.makeTask({ task_id: "project_a_2" }));
    const secondProject = await fx.manager.createTask(fx.makeTask({ task_id: "project_b_1", workspace: otherProject }));

    assert.equal(first.status, "running");
    assert.equal(sameDirectory.status, "queued", "two sessions must not write the same directory concurrently");
    assert.equal(secondProject.status, "running", "a different project can use the second worker slot");
    assert.deepEqual(fx.spawned.map(({ taskId }) => taskId), ["project_a_1", "project_b_1"]);

    await fx.runWorker("project_a_1", new FakeAdapter());
    await fx.manager.recoverTasks();
    assert.deepEqual(fx.spawned.map(({ taskId }) => taskId), ["project_a_1", "project_b_1", "project_a_2"]);
  } finally {
    await rm(otherProject, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("multiple sessions of one project may run in distinct supplied worktrees", async () => {
  const fx = await makeManagerFixture({ maxConcurrentWorkers: 2 });
  const worktreeA = await mkdtemp(path.join(tmpdir(), "zcode-bridge-worktree-a-"));
  const worktreeB = await mkdtemp(path.join(tmpdir(), "zcode-bridge-worktree-b-"));
  try {
    const first = await fx.manager.createTask(fx.makeTask({ task_id: "worktree_a", worktree_path: worktreeA }));
    const second = await fx.manager.createTask(fx.makeTask({ task_id: "worktree_b", worktree_path: worktreeB }));
    assert.equal(first.status, "running");
    assert.equal(second.status, "running");
    assert.deepEqual(fx.spawned.map(({ taskId }) => taskId), ["worktree_a", "worktree_b"]);
    assert.equal(fx.store.readWorkspaceRef("worktree_a")?.sourcePath, fx.workspaceDir);
    assert.equal(fx.store.readWorkspaceRef("worktree_b")?.sourcePath, fx.workspaceDir);
  } finally {
    await rm(worktreeA, { recursive: true, force: true });
    await rm(worktreeB, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("parallel recovery keeps live workers in their slots and starts queued work after a worker is lost", async () => {
  const fx = await makeManagerFixture({ maxConcurrentWorkers: 2 });
  const projectB = await mkdtemp(path.join(tmpdir(), "zcode-bridge-project-b-"));
  const projectC = await mkdtemp(path.join(tmpdir(), "zcode-bridge-project-c-"));
  try {
    await fx.manager.createTask(fx.makeTask({ task_id: "recover_a" }));
    await fx.manager.createTask(fx.makeTask({ task_id: "recover_b", workspace: projectB }));
    const queued = await fx.manager.createTask(fx.makeTask({ task_id: "recover_c", workspace: projectC }));
    assert.equal(queued.status, "queued");
    assert.equal(fx.spawned.length, 2);

    await fx.manager.recoverTasks();
    assert.equal(fx.spawned.length, 2, "recovery must not duplicate live worker processes");
    // recover_a's worker had already started; its loss is final and frees the slot.
    fx.store.writeAttemptMeta("recover_a", 1, "started.json", {
      worker_pid: fx.spawned[0]!.pid,
      started_at: "2026-09-27T00:00:05.000Z",
    });
    fx.pidsAlive.delete(fx.spawned[0]!.pid);
    await fx.manager.recoverTasks();

    assert.equal((await fx.manager.getStatus("recover_a")).error_code, "worker_lost");
    assert.equal((await fx.manager.getStatus("recover_b")).status, "running");
    assert.equal((await fx.manager.getStatus("recover_c")).status, "running");
    assert.deepEqual(fx.spawned.map(({ taskId }) => taskId), ["recover_a", "recover_b", "recover_c"]);
  } finally {
    await rm(projectB, { recursive: true, force: true });
    await rm(projectC, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("FIFO order is honored for multiple queued tasks (created_at ordering)", async () => {
  const fx = await freshFixture();
  try {
    const store = fx.store;
    store.createTask(fx.makeTask({ task_id: "task_late" }), "2026-09-27T00:00:30.000Z");
    store.createTask(fx.makeTask({ task_id: "task_early" }), "2026-09-27T00:00:10.000Z");
    await fx.manager.recoverTasks();
    assert.equal(fx.spawned.length, 1);
    assert.equal(fx.spawned[0]!.taskId, "task_early", "the earliest queued task starts first");
  } finally {
    await fx.cleanup();
  }
});

test("getResult enforces TASK_NOT_FOUND and TASK_NOT_FINISHED and returns the normalized result", async () => {
  const fx = await freshFixture();
  try {
    await assert.rejects(
      fx.manager.getResult("nope"),
      (error: unknown) => errorCodeOf(error) === "TASK_NOT_FOUND",
    );
    await fx.manager.createTask(fx.makeTask());
    await assert.rejects(
      fx.manager.getResult("task_1"),
      (error: unknown) => errorCodeOf(error) === "TASK_NOT_FINISHED",
    );
    await fx.runWorker("task_1", new FakeAdapter());
    await fx.manager.recoverTasks();
    const result = await fx.manager.getResult("task_1");
    assert.equal(result.status, "completed");
    assert.equal(result.attempt, 1);
    assert.deepEqual(result.files_changed, ["bridge-smoke.txt"]);
    assert.equal(result.needs_master_decision, false);
    assert.ok(result.session_id?.startsWith("sess_"));
  } finally {
    await fx.cleanup();
  }
});

test("getResult returns a waiting_for_master result for the finished attempt", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const adapter = new FakeAdapter();
    adapter.behavior = "master";
    await fx.runWorker("task_1", adapter);
    await fx.manager.recoverTasks();

    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "waiting_for_master");
    const result = await fx.manager.getResult("task_1");
    assert.equal(result.status, "waiting_for_master");
    assert.equal(result.needs_master_decision, true);
  } finally {
    await fx.cleanup();
  }
});

test("interaction replies enforce request state and map permission/input answers", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    fx.store.writeInteractionRequest("task_1", {
      request_id: "permission-1",
      method: "interaction/requestPermission",
      params: { options: [{ kind: "allow_once" }, { kind: "deny" }] },
    });
    await assert.rejects(
      fx.manager.replyToInteraction({ task_id: "task_1", request_id: "permission-1", decision: "accept" }),
      (error: unknown) => error instanceof TaskManagerError && error.code === "TASK_INVALID",
    );
    assert.deepEqual(
      await fx.manager.replyToInteraction({ task_id: "task_1", request_id: "permission-1", decision: "allow" }),
      { task_id: "task_1", request_id: "permission-1", state: "answered" },
    );
    assert.deepEqual(fx.store.readInteractionRequest("task_1", "permission-1")?.answer, { decision: "allow" });
    await assert.rejects(
      fx.manager.replyToInteraction({ task_id: "task_1", request_id: "permission-1", decision: "deny" }),
      (error: unknown) => error instanceof TaskManagerError && error.code === "TASK_STATE",
    );
    await assert.rejects(
      fx.manager.replyToInteraction({ task_id: "task_1", request_id: "missing", decision: "deny" }),
      (error: unknown) => error instanceof TaskManagerError && error.code === "TASK_NOT_FOUND",
    );

    fx.store.writeInteractionRequest("task_1", {
      request_id: "question-1",
      method: "interaction/requestUserInput",
      params: { questions: [{ question: "Which test command should run?" }] },
    });
    await fx.manager.replyToInteraction({
      task_id: "task_1",
      request_id: "question-1",
      decision: "accept",
      answers: { "Which test command should run?": "npm test" },
    });
    assert.deepEqual(fx.store.readInteractionRequest("task_1", "question-1")?.answer, {
      action: "accept",
      content: { answers: { "Which test command should run?": "npm test" } },
    });

    fx.store.writeInteractionRequest("task_1", {
      request_id: "plan-1",
      method: "interaction/requestUserInput",
      params: { schema: { interaction: "plan_approval" }, input: { plan: "do work" } },
    });
    await fx.manager.replyToInteraction({ task_id: "task_1", request_id: "plan-1", decision: "accept" });
    assert.deepEqual(fx.store.readInteractionRequest("task_1", "plan-1")?.answer, {
      action: "accept",
      content: { answer_0: "approve" },
    });
  } finally {
    await fx.cleanup();
  }
});

test("an adapter failure produces failed with error_code and a master-review flag", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const adapter = new FakeAdapter();
    adapter.behavior = "adapterFailed";
    await fx.runWorker("task_1", adapter);
    await fx.manager.recoverTasks();
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "failed");
    assert.equal(status.error_code, "zcode_nonzero_exit");
    const result = await fx.manager.getResult("task_1");
    assert.equal(result.needs_master_decision, true, "a failed run without a report must reach the master");
  } finally {
    await fx.cleanup();
  }
});

test("a dead worker without a terminal result reconciles to failed/worker_lost and frees the slot", async () => {
  const fx = await freshFixture();
  try {
    const receipt = await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    // The worker had started (started.json written), so its death is final:
    // a never-started worker would be respawned instead.
    fx.store.writeAttemptMeta("task_1", 1, "started.json", {
      worker_pid: pid,
      started_at: "2026-09-27T00:00:05.000Z",
    });
    fx.pidsAlive.delete(pid); // the worker process died
    await fx.manager.recoverTasks();
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "failed");
    assert.equal(status.error_code, "worker_lost");
    assert.match(status.error!, /worker pid/);
    const result = await fx.manager.getResult("task_1");
    assert.equal(result.error_code, "worker_lost");
    assert.equal(result.needs_master_decision, true);
    assert.ok(result.finished_at);
    void receipt;

    // The slot is free again: a new task starts immediately.
    const next = await fx.manager.createTask(fx.makeTask({ task_id: "task_2" }));
    assert.equal(next.status, "running");
  } finally {
    await fx.cleanup();
  }
});

test("a mid-spawn running status with no pid is left alone during the grace and respawned after it", async () => {
  // Reproduces the shared-dataRoot race: another Bridge process observed the
  // status between the "running" write and the pid write. The grace window
  // must keep it running, and because the worker never wrote started.json the
  // post-grace outcome is a respawn, not a finalized loss.
  const fx = await makeManagerFixture({ workerStartGraceMs: 30_000 });
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    fx.store.writeStatus("task_1", { worker_pid: null });
    fx.pidsAlive.delete(pid);
    await fx.manager.recoverTasks();
    assert.equal((await fx.manager.getStatus("task_1")).status, "running");
    assert.equal(fx.spawned.length, 1, "the spawn window must not trigger a respawn");

    fx.advanceMs(31_000);
    await fx.manager.recoverTasks();
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "running", "a never-started worker is replaced, not failed");
    assert.equal(fx.spawned.length, 2);
    assert.equal(fx.spawned[1]!.taskId, "task_1");
    assert.equal(fx.spawned[1]!.pid, status.worker_pid);
    const events = fx.store.readEvents("task_1", 0, 50).events;
    assert.ok(events.some((event) => event.type === "worker_respawned"), "respawn must be observable");
  } finally {
    await fx.cleanup();
  }
});

test("a worker that dies before starting is respawned immediately on the same attempt", async () => {
  const fx = await makeManagerFixture({ workerStartGraceMs: 30_000 });
  try {
    await fx.manager.createTask(fx.makeTask());
    fx.pidsAlive.delete(fx.spawned[0]!.pid); // worker died right after spawn, nothing written
    await fx.manager.recoverTasks();
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "running");
    assert.equal(fx.spawned.length, 2);
    assert.equal(fx.spawned[1]!.pid, status.worker_pid);
  } finally {
    await fx.cleanup();
  }
});

test("a replacement that also dies before starting is finalized once its claim goes stale", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    fx.pidsAlive.delete(fx.spawned[0]!.pid);
    await fx.manager.recoverTasks(); // first respawn
    assert.equal(fx.spawned.length, 2);
    const replacement = fx.spawned[1]!.pid;
    const claimFile = path.join(fx.store.attemptDir("task_1", 1), "respawn.claim");
    fx.pidsAlive.delete(replacement);
    await fx.manager.recoverTasks();
    assert.equal((await fx.manager.getStatus("task_1")).status, "running", "a fresh claim means a respawn may be in flight");
    assert.equal(fx.spawned.length, 2, "the claimed slot must not be double-spawned");

    utimesSync(claimFile, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await fx.manager.recoverTasks();
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "failed");
    assert.equal(status.error_code, "worker_lost");
    assert.equal(fx.spawned.length, 2, "at most one replacement per attempt");
  } finally {
    await fx.cleanup();
  }
});

test("a worker that started but died is never respawned; a persisted result still wins during the grace", async () => {
  const fx = await makeManagerFixture({ workerStartGraceMs: 30_000 });
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    fx.store.writeAttemptMeta("task_1", 1, "started.json", { worker_pid: pid, started_at: "2026-09-27T00:00:05.000Z" });

    fx.pidsAlive.delete(pid);
    await fx.manager.recoverTasks();
    assert.equal((await fx.manager.getStatus("task_1")).status, "running", "a started worker's fresh death waits out the grace");
    assert.equal(fx.spawned.length, 1, "a started worker is never auto-respawned");

    fx.advanceMs(31_000);
    await fx.manager.recoverTasks();
    assert.equal((await fx.manager.getStatus("task_1")).status, "failed");

    // The second scenario: the worker finishes normally within the grace.
    const fx2 = await makeManagerFixture({ workerStartGraceMs: 30_000 });
    try {
      await fx2.manager.createTask(fx2.makeTask());
      await fx2.runWorker("task_1", new FakeAdapter()); // writes the terminal result
      await fx2.manager.recoverTasks();
      const status = await fx2.manager.getStatus("task_1");
      assert.equal(status.status, "completed");
      assert.ok(!status.error_code, "a completed run must not carry an error code");
    } finally {
      await fx2.cleanup();
    }
  } finally {
    await fx.cleanup();
  }
});

test("recovery of persisted queued tasks starts them FIFO; a live worker keeps its slot", async () => {
  const fx = await freshFixture();
  try {
    const store = fx.store;
    store.createTask(fx.makeTask({ task_id: "task_q1" }), "2026-09-27T00:00:01.000Z");
    store.createTask(fx.makeTask({ task_id: "task_q2" }), "2026-09-27T00:00:02.000Z");
    await fx.manager.recoverTasks();
    assert.equal(fx.spawned.length, 1);
    assert.equal(fx.spawned[0]!.taskId, "task_q1");
    const second = await fx.manager.getStatus("task_q2");
    assert.equal(second.status, "queued");

    // A running task whose worker is still alive is left alone.
    store.writeStatus("task_q1", { status: "running", worker_pid: 999_999 });
    fx.pidsAlive.add(999_999);
    await fx.manager.recoverTasks();
    assert.equal(fx.spawned.length, 1, "no new worker while a live worker holds the slot");
    assert.equal((await fx.manager.getStatus("task_q1")).status, "running");
  } finally {
    await fx.cleanup();
  }
});

test("continueTask archives prior evidence, passes feedback through, and increments attempt", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    await fx.runWorker("task_1", new FakeAdapter());
    await fx.manager.recoverTasks();

    const receipt = await fx.manager.continueTask({
      task_id: "task_1",
      feedback: "Fix the failing test",
      additional_requirements: ["Keep the API stable"],
      operation_id: "continue-1",
    });
    assert.equal(receipt.status, "running", "the slot is free so the continuation starts immediately");
    assert.equal(fx.spawned.length, 2);
    assert.deepEqual(await fx.manager.continueTask({
      task_id: "task_1",
      feedback: "Fix the failing test",
      additional_requirements: ["Keep the API stable"],
      operation_id: "continue-1",
    }), receipt);
    assert.equal(fx.spawned.length, 2, "retrying one continuation must not start another attempt");
    await assert.rejects(fx.manager.continueTask({
      task_id: "task_1",
      feedback: "different feedback",
      operation_id: "continue-1",
    }), (error: unknown) => errorCodeOf(error) === "CONTINUE_OPERATION_CONFLICT");

    const adapter = new FakeAdapter();
    await fx.runWorker("task_1", adapter);
    await fx.manager.recoverTasks();

    const call = adapter.calls[0]!;
    assert.equal(call.kind, "continue");
    assert.equal(call.attempt, 2);
    assert.equal(call.feedback, "Fix the failing test");
    assert.deepEqual(call.additionalRequirements, ["Keep the API stable"]);
    assert.ok(call.previousSessionId?.startsWith("sess_"));
    assert.ok(call.previousResult, "previous result must be handed to the adapter");

    const result = await fx.manager.getResult("task_1");
    assert.equal(result.attempt, 2);
    assert.ok(
      fx.store.readArchivedResult("task_1", 1),
      "attempt 1 result must remain as evidence",
    );
    const continueSpec = fx.store.readAttemptMeta<Record<string, unknown>>("task_1", 2, "continue.json");
    assert.equal(continueSpec?.["feedback"], "Fix the failing test");
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.zcode_session_id, result.session_id);
  } finally {
    await fx.cleanup();
  }
});

test("continueTask resumes a cancelled task as a new attempt and keeps the cancelled result as evidence", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    assert.equal((await fx.manager.cancelTask("task_1")).status, "cancelled");

    const receipt = await fx.manager.continueTask({ task_id: "task_1", feedback: "Resume without asking" });
    assert.equal(receipt.status, "running", "the cancelled attempt freed the slot");
    assert.equal(fx.spawned.length, 2);
    const status = fx.store.readStatus("task_1");
    assert.equal(status.attempt, 2);
    assert.equal(status.cancel_requested, null, "the cancel intent must not carry into the new attempt");
    assert.equal(fx.store.readArchivedResult("task_1", 1)?.status, "cancelled");

    const adapter = new FakeAdapter();
    await fx.runWorker("task_1", adapter);
    await fx.manager.recoverTasks();
    const call = adapter.calls[0]!;
    assert.equal(call.kind, "continue");
    assert.equal(call.attempt, 2);
    assert.equal((call.previousResult as { status?: string } | null)?.status, "cancelled");
    assert.equal((await fx.manager.getResult("task_1")).status, "completed");
  } finally {
    await fx.cleanup();
  }
});

test("continueTask is rejected from non-terminal states and for empty feedback", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask()); // running
    await assert.rejects(
      fx.manager.continueTask({ task_id: "task_1", feedback: "go on" }),
      (error: unknown) => errorCodeOf(error) === "TASK_STATE",
    );
    await fx.runWorker("task_1", new FakeAdapter());
    await fx.manager.recoverTasks();
    await assert.rejects(
      fx.manager.continueTask({ task_id: "task_1", feedback: "   " }),
      (error: unknown) => errorCodeOf(error) === "TASK_INVALID",
    );
    await assert.rejects(
      fx.manager.continueTask({ task_id: "nope", feedback: "x" }),
      (error: unknown) => errorCodeOf(error) === "TASK_NOT_FOUND",
    );
  } finally {
    await fx.cleanup();
  }
});

test("cancelling a queued task cancels it immediately without any worker", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask({ task_id: "task_a" })); // running, occupies the slot
    const store = fx.store;
    store.createTask(fx.makeTask({ task_id: "task_b" }), "2026-09-27T00:00:09.000Z"); // queued
    const status = await fx.manager.cancelTask("task_b");
    assert.equal(status.status, "cancelled");
    assert.equal(fx.terminateCalls.length, 0, "no process tree to terminate for a queued task");
    const result = await fx.manager.getResult("task_b");
    assert.equal(result.status, "cancelled");
    assert.equal(result.needs_master_decision, false);
  } finally {
    await fx.cleanup();
  }
});

test("cancelling a running task terminates and verifies the process tree before recording cancelled", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const pid = fx.spawned[0]!.pid;
    const status = await fx.manager.cancelTask("task_1");
    assert.deepEqual(fx.terminateCalls, [pid], "termination must target the worker pid");
    assert.equal(status.status, "cancelled");
    assert.equal(status.worker_pid, null);
    const result = await fx.manager.getResult("task_1");
    assert.equal(result.status, "cancelled");
    assert.match(result.summary, /terminated and verified/);
  } finally {
    await fx.cleanup();
  }
});

test("when tree termination cannot be verified the task stays nonterminal and CANCEL_FAILED is raised", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    fx.setTerminateError(new Error("taskkill exited with code 128"));
    await assert.rejects(
      fx.manager.cancelTask("task_1"),
      (error: unknown) => errorCodeOf(error) === "CANCEL_FAILED",
    );
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "running", "the task must remain nonterminal");
    assert.match(status.error!, /cancellation could not be verified/);
  } finally {
    await fx.cleanup();
  }
});

test("a worker that completes during cancellation wins: the persisted terminal result is kept", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    // Simulate the worker finishing between the cancel intent and the tree
    // termination: a terminal result.json appears while status is running.
    await fx.runWorker("task_1", new FakeAdapter());
    const statusBefore = await fx.manager.getStatus("task_1");
    void statusBefore;
    // Re-open the task as "running" while keeping the result file.
    const result = fx.store.readResult("task_1")!;
    fx.store.writeStatus("task_1", { status: "running", finished_at: null });
    fx.pidsAlive.add(fx.spawned[0]!.pid);
    const status = await fx.manager.cancelTask("task_1");
    assert.equal(status.status, "completed", "the natural completion must not be overwritten");
    const after = await fx.manager.getResult("task_1");
    assert.equal(after.session_id, result.session_id);
  } finally {
    await fx.cleanup();
  }
});

test("cancelling a terminal task is rejected", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask({ task_id: "task_a" }));
    await fx.manager.cancelTask("task_a"); // hmm: running
    await assert.rejects(
      fx.manager.cancelTask("task_a"),
      (error: unknown) => errorCodeOf(error) === "TASK_STATE",
    );
  } finally {
    await fx.cleanup();
  }
});

test("workspace canonicalization: the persisted task stores the canonical path", async () => {
  const fx = await freshFixture();
  try {
    const weirdPath = fx.workspaceDir + path.sep + "." + path.sep;
    await fx.manager.createTask(fx.makeTask({ workspace: weirdPath }));
    const task = fx.store.readTask("task_1");
    assert.equal(task.workspace, fx.workspaceDir, "the canonical path must be stored");
  } finally {
    await fx.cleanup();
  }
});

test("spawn failure of the worker process records failed/spawn_failed and frees the slot", async () => {
  const fx = await freshFixture();
  try {
    // Replace the manager with one whose spawnWorker always throws.
    const store = fx.store;
    const { BridgeTaskManager } = await import("../src/manager/task-manager.js");
    let clock = 0;
    const failing = new BridgeTaskManager({
      store,
      workspaceProvider: {
        resolve: async (p) => ({ requestedPath: p, canonicalPath: p, mode: "direct" }),
        release: async () => {},
      },
      spawnWorker: () => {
        throw new Error("no such worker entry");
      },
      pollIntervalMs: 0,
      now: () => new Date(Date.UTC(2026, 8, 27, 0, 0, 0) + ++clock * 1_000),
    });
    try {
      const receipt = await failing.createTask(makeTask({ workspace: fx.workspaceDir }));
      assert.equal(receipt.status, "queued", "spawn failure must fall back to a terminal failed state, not running");
      void receipt;
      const status = await failing.getStatus("task_1");
      assert.equal(status.status, "failed");
      assert.equal(status.error_code, "spawn_failed");
      const result = await failing.getResult("task_1");
      assert.equal(result.error_code, "spawn_failed");
    } finally {
      failing.dispose();
    }
  } finally {
    await fx.cleanup();
  }
});

test("runWorkerTask through the harness end-to-end reaches a terminal TaskStatusRecord", async () => {
  const fx = await freshFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const adapter = new FakeAdapter();
    await fx.runWorker("task_1", adapter);
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "completed");
    assert.ok(status.started_at);
    assert.ok(status.finished_at);
    assert.equal(status.attempt, 1);
    assert.ok(status.created_at);
    assert.ok(status.updated_at);
  } finally {
    await fx.cleanup();
  }
});
