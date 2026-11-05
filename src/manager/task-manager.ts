// TaskManager: validates requests, owns the configured global worker slots, persists
// state via the TaskStore, launches and
// reconciles detached workers, and enforces state transitions.
//
// Concurrency model: all state mutations run through a single promise-chain
// mutex, and an interval tick (recoverTasks) reconciles non-terminal tasks:
// a persisted worker PID that is gone without a terminal result becomes
// failed/worker_lost; a terminal result.json whose status lags aligns the
// status record; queued tasks start FIFO while the slot is free.
import type {
  ContinueTaskInput,
  GetEventsInput,
  ProgressTaskManager,
  TaskObservation,
  TaskPackage,
  TaskProgressPage,
  TaskProgressEvent,
  TaskFeedbackSnapshotV01,
  TaskReceipt,
  TaskResult,
  TaskStatusRecord,
  WorkspaceProvider,
  ZCodeInteractionReplyInput,
} from "../interfaces.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isTerminalStatus, TaskStore, toPublicStatus } from "../store/task-store.js";
import type { EventsScanCursor, InternalTaskStatus } from "../store/task-store.js";
import { buildTaskResult, type TaskFailure } from "./normalize.js";
import type { ZCodeRunOutcome } from "../adapters/zcode-adapter.js";
import { TaskManagerError } from "./errors.js";
import { defaultSpawnWorker, type SpawnWorker } from "./spawn-worker.js";
import { isProcessRunning, terminateProcessTree, verifyProcessTreeClaimantsClean, type TerminateProcessTree, type TreeClaimantTarget } from "../adapters/process-spawn.js";
import { WindowsTreeCleanupError } from "../adapters/windows-process-cleanup.js";
import { validateTaskTimeout } from "../runtime/task-timeout.js";
import { tryAcquireProcessLock, withProcessLock, publishSelfIdentity } from "../store/process-lock.js";
import { buildTaskPrompt, buildContinuePrompt } from "../prompts/task-prompt.js";
import { createPlatformProbe, livenessVerdict, type ProbeRequest, type ProbeVerdict, type ProcessIdentity, type ProcessProbe } from "../runtime/process-probe.js";
import type { ProcessIdentityLike } from "../store/task-store.js";
import { buildTaskObservation } from "../observation/build.js";
import { DiagnosticCounters, sanitizeDiagnostics, boundedErrorMessage } from "../observation/diagnostics.js";
import type { ExecutorState } from "../observation/types.js";
import { buildTaskFeedbackSnapshotV01 } from "../feedback/task-feedback.js";

export interface TaskManagerOptions {
  store: TaskStore;
  workspaceProvider: WorkspaceProvider;
  /** Defaults to spawning the detached worker-main.js process. */
  spawnWorker?: SpawnWorker;
  /** Defaults to a real PID liveness check. Legacy evidence only (no identity). */
  isProcessRunning?: (pid: number) => boolean;
  /** Defaults to real process-tree termination with verification. */
  terminateProcessTree?: TerminateProcessTree;
  /** Defaults to the read-only recorded-tree claimant scan (ADR-009). */
  verifyTreeClean?: (targets: readonly TreeClaimantTarget[]) => Promise<{ clean: boolean; livePids: readonly number[]; observedPids?: readonly number[] }>;
  /** Defaults to the platform ProcessProbe (Windows PowerShell batch / Linux
   * /proc / macOS ps). Recovery and cleanup identity checks use it. */
  probe?: ProcessProbe;
  /** Reconcile/pump interval; 0 disables the timer (tests drive manually). */
  pollIntervalMs?: number;
  now?: () => Date;
  /**
   * Grace window after an attempt starts during which a missing or dead
   * worker pid must not finalize worker_lost. Defaults to 10,000 ms; 0
   * restores immediate finalization.
   */
  workerStartGraceMs?: number;
  /** Advisory stall-hint threshold for business-event silence. Default 120,000 ms. */
  stallHintMs?: number;
  /** Maximum simultaneous detached workers in this Bridge process. Defaults to 8. */
  maxConcurrentWorkers?: number;
}

export class BridgeTaskManager implements ProgressTaskManager {
  /** How long a respawn claim counts as in-flight across Bridge processes. */
  static readonly RESPAWN_IN_FLIGHT_MS = 10_000;
  readonly #store: TaskStore;
  readonly #workspaceProvider: WorkspaceProvider;
  readonly #spawnWorker: SpawnWorker;
  readonly #isProcessRunning: (pid: number) => boolean;
  readonly #terminateProcessTree: TerminateProcessTree;
  readonly #verifyTreeClean: (targets: readonly TreeClaimantTarget[]) => Promise<{ clean: boolean; livePids: readonly number[]; observedPids?: readonly number[] }>;
  readonly #probe: ProcessProbe | null;
  readonly #now: () => Date;
  readonly #dataRoot: string;
  readonly #maxConcurrentWorkers: number;
  readonly #workerStartGraceMs: number;
  readonly #stallHintMs: number;
  readonly #recoveryCooldownMs: number;
  readonly #counters = new DiagnosticCounters();
  #timer: NodeJS.Timeout | null = null;
  #mutex: Promise<unknown> = Promise.resolve();
  #queuedOperations = 0;
  #recoveryPromise: Promise<void> | null = null;

  constructor(options: TaskManagerOptions) {
    this.#store = options.store;
    this.#workspaceProvider = options.workspaceProvider;
    this.#spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
    this.#isProcessRunning = options.isProcessRunning ?? isProcessRunning;
    this.#terminateProcessTree = options.terminateProcessTree ?? terminateProcessTree;
    this.#verifyTreeClean = options.verifyTreeClean ?? verifyProcessTreeClaimantsClean;
    this.#probe = options.probe ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#dataRoot = options.store.dataRoot;
    this.#maxConcurrentWorkers = options.maxConcurrentWorkers ?? 8;
    if (!Number.isInteger(this.#maxConcurrentWorkers) || this.#maxConcurrentWorkers < 1 || this.#maxConcurrentWorkers > 8) {
      throw new RangeError("maxConcurrentWorkers must be an integer from 1 to 8");
    }
    this.#workerStartGraceMs = options.workerStartGraceMs ?? 10_000;
    if (!Number.isInteger(this.#workerStartGraceMs) || this.#workerStartGraceMs < 0) {
      throw new RangeError("workerStartGraceMs must be a non-negative integer");
    }
    this.#stallHintMs = options.stallHintMs ?? 120_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#recoveryCooldownMs = pollIntervalMs;
    if (pollIntervalMs > 0) {
      this.#timer = setInterval(() => {
        void this.recoverTasks().catch((error) => {
          const reason = boundedErrorMessage(error);
          const occurrence = this.#counters.record("recovery_loop_error", reason);
          if (this.#counters.shouldEmit("recovery_loop_error", reason, 60)) {
            console.error(`Bridge recovery failed: ${reason} (occurrence ${occurrence.count})`);
          }
        });
      }, pollIntervalMs);
      this.#timer.unref();
    }
    // Publish our own process identity for lock owner records (best effort,
    // async: the synchronous lock path never starts an OS query itself).
    const probe = this.#probe;
    if (probe) {
      void probe.selfIdentity().then(
        (identity) => publishSelfIdentity(identity),
        () => undefined,
      );
    }
  }

  /** Bounded live diagnostics (counters + lock latency), for doctor/ops tooling. */
  diagnostics(): { counters: Record<string, { count: number; last_seen_at: string; reason: string }>; lock_wait: { samples: number; p50_ms: number | null; p95_ms: number | null; max_ms: number | null } } {
    return { counters: this.#counters.snapshot(), lock_wait: this.#counters.latencySummary() };
  }

  /** Stops the reconcile timer; safe to call repeatedly. */
  dispose(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Scans all non-terminal tasks and reconciles them, then pumps the queue.
   * Per the A2 three-phase design, OS probes run OUTSIDE the manager mutex:
   * snapshot → async probe → re-verify and commit. One task's failure never
   * blocks the others. */
  async recoverTasks(): Promise<void> {
    if (this.#recoveryPromise) return this.#recoveryPromise;
    const releaseRecovery = tryAcquireProcessLock(path.join(this.#store.tasksRoot, ".recovery.lock"));
    if (!releaseRecovery) return;
    const lastRunFile = path.join(this.#store.tasksRoot, ".recovery-last-run");
    if (this.#recoveryCooldownMs > 0 && existsSync(lastRunFile) && Date.now() - statSync(lastRunFile).mtimeMs < this.#recoveryCooldownMs) {
      releaseRecovery();
      return;
    }
    const run = (async () => {
      for (const taskId of this.#store.listTaskIds()) {
        try {
          const status = this.#safeStatus(taskId);
          if (!status) continue;
          if (status.status === "running") {
            await this.#reconcileRunningThreePhase(taskId, status);
          } else if (isTerminalStatus(status.status) && status.cleanup_unverified === true) {
            await this.#reconcileTerminalCleanup(taskId, status);
          }
        } catch (error) {
          const reason = this.#counters.record("reconcile_error", taskId);
          if (this.#counters.shouldEmit("reconcile_error", taskId)) {
            console.error(`Bridge could not reconcile task ${taskId}: ${boundedErrorMessage(error)} (occurrence ${reason.count})`);
          }
        }
      }
      await this.#exclusive(async () => { this.#pumpLocked(); });
    })();
    this.#recoveryPromise = run;
    try { await run; }
    finally {
      try {
        if (this.#recoveryCooldownMs > 0) {
          writeFileSync(lastRunFile, String(Date.now()), { mode: 0o600 });
        }
      } finally {
        try { releaseRecovery(); }
        finally { this.#recoveryPromise = null; }
      }
    }
  }

  /** Releases terminal-task occupancy only after the persisted executor exits
   * are independently confirmed. A probe never signals or retries the task. */
  async #reconcileTerminalCleanup(taskId: string, status: InternalTaskStatus): Promise<void> {
    const identity = this.#store.readExecutorIdentity(taskId, status.attempt);
    const started = this.#store.readAttemptMeta<{ worker_pid?: number }>(taskId, status.attempt, "started.json");
    const snapshot = {
      attempt: status.attempt,
      status_worker_pid: status.worker_pid,
      // A terminal status clears worker_pid before the worker process itself
      // has necessarily exited. Retain its attempt identity as exit evidence.
      worker_pid: status.worker_pid ?? identity?.worker?.pid ?? started?.worker_pid ?? null,
      zcode_pid: status.zcode_pid ?? null,
      identity,
    };
    if (snapshot.worker_pid === null && snapshot.zcode_pid === null) {
      const occurrence = this.#counters.record("terminal_cleanup_unverifiable", "missing_pid");
      if (this.#counters.shouldEmit("terminal_cleanup_unverifiable", "missing_pid")) {
        this.#store.appendEvent(taskId, "cleanup_probe_unknown", "Terminal task has no recorded executor PID; cleanup remains occupied", {
          reason_code: "missing_executor_pid", count: occurrence.count,
        }, this.#now().toISOString());
      }
      return;
    }

    const verdicts = await this.#probeExecutors(snapshot);
    const workerExited = snapshot.worker_pid === null || verdicts.worker.state === "exited";
    const runtimeExited = snapshot.zcode_pid === null || verdicts.runtime.state === "exited";
    if (!workerExited || !runtimeExited) {
      const reason = !runtimeExited ? verdicts.runtime.reason_code : verdicts.worker.reason_code;
      const occurrence = this.#counters.record("terminal_cleanup_unverifiable", reason);
      if (this.#counters.shouldEmit("terminal_cleanup_unverifiable", reason)) {
        this.#store.appendEvent(taskId, "cleanup_probe_unknown", "Terminal task cleanup is not yet verified; its execution path remains occupied", {
          reason_code: reason, worker_state: verdicts.worker.state, runtime_state: verdicts.runtime.state,
          count: occurrence.count,
        }, this.#now().toISOString());
      }
      return;
    }

    // ADR-009 / review-round-1 R1: executor-exit evidence never clears a
    // latched descendant-cleanup failure. When the failure record carries
    // known member pids (or is corrupt), only a cancel's claimant-scan-gated
    // release may clear the latch; the probe path stays occupied.
    const failureRecordState = this.#cleanupFailureRecordState(taskId, status.attempt);
    if (failureRecordState !== "none") {
      const occurrence = this.#counters.record("terminal_cleanup_latched", failureRecordState);
      if (this.#counters.shouldEmit("terminal_cleanup_latched", failureRecordState)) {
        this.#store.appendEvent(taskId, "cleanup_unverified", "A recorded tree-cleanup failure with known members keeps the terminal task occupied; cancel runs the recorded-tree scan", {
          record_state: failureRecordState, count: occurrence.count,
        }, this.#now().toISOString());
      }
      return;
    }

    await this.#exclusive(async () => {
      const current = this.#safeStatus(taskId);
      if (!current || !isTerminalStatus(current.status) || current.cleanup_unverified !== true) return;
      const currentIdentity = this.#store.readExecutorIdentity(taskId, current.attempt);
      if (
        current.attempt !== snapshot.attempt || current.worker_pid !== snapshot.status_worker_pid ||
        (current.zcode_pid ?? null) !== snapshot.zcode_pid ||
        currentIdentity?.worker?.pid !== snapshot.identity?.worker?.pid ||
        currentIdentity?.worker?.fingerprint !== snapshot.identity?.worker?.fingerprint ||
        currentIdentity?.runtime?.pid !== snapshot.identity?.runtime?.pid ||
        currentIdentity?.runtime?.fingerprint !== snapshot.identity?.runtime?.fingerprint
      ) return;
      this.#store.writeStatus(taskId, { cleanup_unverified: null, worker_pid: null, zcode_pid: null });
      this.#store.appendEvent(taskId, "cleanup_verified", "Recorded worker and ZCode runtime exits were confirmed; terminal result was preserved", {
        attempt: snapshot.attempt,
        worker_reason_code: snapshot.worker_pid === null ? "not_recorded" : verdicts.worker.reason_code,
        runtime_reason_code: snapshot.zcode_pid === null ? "not_recorded" : verdicts.runtime.reason_code,
      }, this.#now().toISOString());
      this.#pumpLocked();
    });
  }

  /** Persisted facts needed for one recovery probe cycle. */
  async #reconcileRunningThreePhase(taskId: string, status: InternalTaskStatus): Promise<void> {
    // Phase 1 (lock-free persisted reads): snapshot the attempt/owner facts.
    const snapshot = {
      attempt: status.attempt,
      worker_pid: status.worker_pid,
      zcode_pid: status.zcode_pid ?? null,
      started_at: status.started_at,
      heartbeat: this.#store.readWorkerHeartbeat(taskId, status.attempt),
      identity: this.#store.readExecutorIdentity(taskId, status.attempt),
    };
    const heartbeatAgeMs = snapshot.heartbeat ? this.#now().getTime() - Date.parse(snapshot.heartbeat.heartbeat_at) : Number.NaN;
    // Fresh heartbeat is attempt- and PID-bound worker-alive evidence; a live
    // worker needs no OS query at all.
    if (
      snapshot.heartbeat && snapshot.worker_pid !== null &&
      snapshot.heartbeat.worker_pid === snapshot.worker_pid &&
      heartbeatAgeMs >= 0 && heartbeatAgeMs <= 15_000
    ) return;

    // Phase 2 (outside the manager mutex): bounded OS probes.
    const verdicts = await this.#probeExecutors(snapshot);

    // Phase 3 (manager mutex): re-verify the snapshot against current state,
    // then commit. A stale query can never act on a newer attempt (A2-06).
    await this.#exclusive(async () => {
      const current = this.#safeStatus(taskId);
      if (!current) return;
      if (isTerminalStatus(current.status)) return;
      if (
        current.attempt !== snapshot.attempt ||
        current.worker_pid !== snapshot.worker_pid ||
        (current.zcode_pid ?? null) !== snapshot.zcode_pid
      ) return; // the world moved on; discard this probe cycle
      this.#persistProbeVerdicts(taskId, snapshot.attempt, verdicts);
      this.#applyReconcileVerdicts(taskId, current, snapshot, verdicts);
    });
  }

  async #probeExecutors(snapshot: {
    attempt: number;
    worker_pid: number | null;
    zcode_pid: number | null;
    identity: { worker?: ProcessIdentityLike; runtime?: ProcessIdentityLike | null } | null;
  }): Promise<{ worker: ProbeVerdict; runtime: ProbeVerdict }> {
    const probe = this.#probe;
    const nowMs = (): number => this.#now().getTime();
    const workerIdentity = snapshot.identity?.worker ?? null;
    const runtimeIdentity = snapshot.identity?.runtime ?? null;
    // Probe known PIDs even for legacy attempts without a persisted identity.
    // A missing identity can still prove that the PID is absent, but a live
    // PID without a fingerprint must remain unknown and must never be signalled.
    if (probe && (snapshot.worker_pid !== null || snapshot.zcode_pid !== null)) {
      try {
        const requests: ProbeRequest[] = [];
        if (snapshot.worker_pid !== null) requests.push({ pid: snapshot.worker_pid, identity: workerIdentity as ProcessIdentity | null });
        if (snapshot.zcode_pid !== null) requests.push({ pid: snapshot.zcode_pid, identity: runtimeIdentity as ProcessIdentity | null });
        const results = await probe.probe(requests);
        let worker = livenessVerdict(snapshot.worker_pid, this.#isProcessRunning, nowMs);
        let runtime = snapshot.zcode_pid === null
          ? { state: "unknown" as ExecutorState, reason_code: "runtime_pid_not_reported", observed_at: new Date(nowMs()).toISOString() }
          : livenessVerdict(snapshot.zcode_pid, this.#isProcessRunning, nowMs);
        let index = 0;
        if (snapshot.worker_pid !== null) { worker = results[index] ?? worker; index += 1; }
        if (snapshot.zcode_pid !== null) { runtime = results[index] ?? runtime; }
        if (worker.state === "unknown") this.#counters.record("probe_unknown_worker", worker.reason_code);
        if (runtime.state === "unknown") this.#counters.record("probe_unknown_runtime", runtime.reason_code);
        return { worker, runtime };
      } catch (error) {
        this.#counters.record("probe_failed", boundedErrorMessage(error, 80));
        // Fall through to legacy liveness evidence; unknown never kills.
      }
    }
    // Legacy evidence path (tests, missing identities): only PID-absence is
    // conclusive; everything else stays on the keep-occupied side.
    return {
      worker: livenessVerdict(snapshot.worker_pid, this.#isProcessRunning, nowMs),
      runtime: snapshot.zcode_pid === null
        ? { state: "unknown", reason_code: "runtime_pid_not_reported", observed_at: new Date(nowMs()).toISOString() }
        : livenessVerdict(snapshot.zcode_pid, this.#isProcessRunning, nowMs),
    };
  }

  #persistProbeVerdicts(taskId: string, attempt: number, verdicts: { worker: ProbeVerdict; runtime: ProbeVerdict }): void {
    try {
      const current = this.#store.readObservationSnapshot(taskId, attempt).snapshot;
      const revision = (current?.writers["manager"] ?? -1) + 1;
      this.#store.writeManagerObservation(taskId, attempt, {
        worker_probe: { state: verdicts.worker.state, reason_code: verdicts.worker.reason_code },
        runtime_probe: { state: verdicts.runtime.state, reason_code: verdicts.runtime.reason_code },
      }, revision, this.#now().toISOString());
    } catch {
      // Snapshot persistence is observation-only; never blocks reconciliation.
    }
  }

  /** Latches a failed termination (ADR-009): occupancy is retained via
   * cleanup_unverified and the member pids observed by the failed
   * transaction are persisted so later claimant scans cover them. The
   * complete member set is persisted structurally (cleanup-failure.json);
   * the bounded [cleanup-members: …] marker in the status text is a durable
   * fallback that is only trusted when complete — a truncated marker (or a
   * missing/corrupt record) fails later releases closed instead of silently
   * narrowing the scan (review-round-1 R3 + addendum). */
  #recordCleanupFailure(taskId: string, attempt: number, error: unknown): void {
    const message = boundedErrorMessage(error, 300);
    const freshPids = Array.isArray((error as { memberPids?: number[] }).memberPids)
      ? ((error as { memberPids: number[] }).memberPids).filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      : [];
    // Recover the previous set MONOTONICALLY (review-round-1 addendum
    // 13:16 + 13:39): the prior latch marker is ALWAYS parsed and merged —
    // even when the structural record reads back successfully — and its
    // incomplete state (or the record's persisted complete:false flag)
    // sticks forever: no later failure may wash a partial set back to
    // completeness.
    let metaPids: number[] = [];
    let metaKnownIncomplete = false;
    try {
      const previous = this.#store.readAttemptMeta<{ member_pids?: unknown; complete?: unknown }>(taskId, attempt, "cleanup-failure.json");
      if (previous !== null) {
        metaPids = this.#validMemberPids(previous.member_pids);
        metaKnownIncomplete = previous.complete === false;
      }
    } catch {
      // Corrupt/unreadable record: fall through to the marker below.
    }
    const priorMarker = this.#parseCleanupMembersMarker(this.#safeStatus(taskId)?.error);
    const priorMarkerIncomplete = priorMarker !== null && !priorMarker.complete;
    const previousPids = [...new Set([...metaPids, ...(priorMarker?.pids ?? [])])];
    const mergedPids = [...new Set([...previousPids, ...freshPids])];
    const joined = mergedPids.join(",");
    const fitsWithoutTruncation = joined.length <= 1_600 && !(metaKnownIncomplete || priorMarkerIncomplete);
    const memberMarker = mergedPids.length > 0
      ? (fitsWithoutTruncation ? ` [cleanup-members: ${joined}]` : ` [cleanup-members: ${mergedPids.slice(0, 200).join(",")},…]`)
      : (metaKnownIncomplete || priorMarkerIncomplete ? " [cleanup-members: ,…]" : "");
    const recordComplete = fitsWithoutTruncation;
    try {
      this.#store.writeAttemptMeta(taskId, attempt, "cleanup-failure.json", {
        member_pids: mergedPids,
        complete: recordComplete,
        last_error: message,
      });
    } catch {
      // The status marker below keeps the member set durable even without
      // the meta record; an over-long or already-incomplete set keeps its
      // truncation marker and later releases fail closed rather than scan
      // a partial set.
    }
    try {
      this.#store.writeStatus(taskId, {
        cleanup_unverified: true,
        error: `cancellation could not be verified: ${boundedErrorMessage(error, 200)}${memberMarker}`,
      });
      this.#store.appendEvent(taskId, "cancel_failed", message, mergedPids.length > 0 ? { member_pids: mergedPids } : undefined, this.#now().toISOString());
    } catch {
      // Status writes under the lock should not throw here; if they do the
      // CANCEL_FAILED propagation still surfaces the failure.
    }
  }

  /** Validates a persisted member_pids value (review-round-1 addendum R3): a
   * PRESENT record without the member_pids field, a null, or a non-array is
   * corrupt and fails closed — "missing" must never read as "no members". */
  #validMemberPids(value: unknown): number[] {
    if (value === undefined || value === null) {
      throw new TaskManagerError("CANCEL_FAILED", "cleanup failure record is corrupt: member pid list is missing");
    }
    if (!Array.isArray(value) || !value.every((pid) => Number.isSafeInteger(pid) && (pid as number) > 0)) {
      throw new TaskManagerError("CANCEL_FAILED", "cleanup failure record is corrupt: member pid list is not a valid array of positive integers");
    }
    return value as number[];
  }

  /** Parses the durable [cleanup-members: …] marker from a latched status
   * error text. A TRUNCATED marker (…) is reported as incomplete: it must
   * never be treated as the full member set (addendum R3 case 2). */
  #parseCleanupMembersMarker(errorText: string | null | undefined): { pids: number[]; complete: boolean } | null {
    const marker = /\[cleanup-members: ([0-9,]+)(,…)?\]/u.exec(errorText ?? "");
    if (!marker) return null;
    const pids = marker[1]!.split(",").map((part) => Number(part)).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    return { pids, complete: marker[2] === undefined };
  }

  /** Classification of the persisted cleanup-failure state for an attempt:
   * "none" (no record and no known-member marker — legacy latch), "empty"
   * (explicitly member-less record), "members" (known member pids must stay
   * covered, including via a complete latch marker), or "corrupt" (fail
   * closed). A read error is treated as corrupt. */
  #cleanupFailureRecordState(taskId: string, attempt: number): "none" | "empty" | "members" | "corrupt" {
    let meta: { member_pids?: unknown; complete?: unknown } | null = null;
    try {
      meta = this.#store.readAttemptMeta<{ member_pids?: unknown; complete?: unknown }>(taskId, attempt, "cleanup-failure.json") ?? null;
    } catch {
      return "corrupt";
    }
    const marker = this.#parseCleanupMembersMarker(this.#safeStatus(taskId)?.error);
    if (meta === null) {
      // No structural record: a latch marker proves known members existed
      // (terminal recovery must not treat this as legacy).
      if (marker === null) return "none";
      return marker.complete ? "members" : "corrupt";
    }
    let memberPids: number[];
    try {
      memberPids = this.#validMemberPids(meta.member_pids);
    } catch {
      return "corrupt";
    }
    // A record that declares itself partial (complete:false, written when the
    // full set exceeded the durable marker) can never bound a release.
    if (meta.complete === false) return "corrupt";
    return memberPids.length > 0 ? "members" : "empty";
  }

  /** Recorded pids (with persisted fingerprints when available) that later
   * claimant scans must cover after a termination failure. The durable
   * [cleanup-members: …] marker inside the latched status text is ALWAYS
   * unioned in (R3): a missing or emptied failure record can never narrow
   * the scan below what the latch itself recorded; a corrupt record — or a
   * TRUNCATED marker that cannot restore the full set — fails closed before
   * any scan runs. */
  #claimantTargets(
    taskId: string,
    attempt: number,
    probeSnapshot: { worker_pid: number | null; zcode_pid: number | null; identity: { worker?: ProcessIdentityLike; runtime?: ProcessIdentityLike | null } | null },
  ): TreeClaimantTarget[] {
    const targets: TreeClaimantTarget[] = [];
    const addPid = (pid: number, fingerprint: string | null): void => {
      if (Number.isSafeInteger(pid) && pid > 0 && !targets.some((t) => t.pid === pid)) targets.push({ pid, fingerprint });
    };
    const workerFingerprint = typeof probeSnapshot.identity?.worker?.fingerprint === "string" ? probeSnapshot.identity.worker.fingerprint : null;
    const runtimeFingerprint = typeof probeSnapshot.identity?.runtime?.fingerprint === "string" ? probeSnapshot.identity.runtime.fingerprint : null;
    if (probeSnapshot.worker_pid !== null) addPid(probeSnapshot.worker_pid, workerFingerprint);
    if (probeSnapshot.zcode_pid !== null) addPid(probeSnapshot.zcode_pid, runtimeFingerprint);
    // Durable fallback first: the latch text was written together with the
    // failure; only a COMPLETE marker may restore the member set.
    const marker = this.#parseCleanupMembersMarker(this.#safeStatus(taskId)?.error);
    if (marker !== null && !marker.complete) {
      throw new TaskManagerError("CANCEL_FAILED", "cleanup member record is incomplete: the latched member list was truncated and cannot be reconstructed; the task stays occupied");
    }
    if (marker !== null) {
      for (const pid of marker.pids) addPid(pid, null);
    }
    let meta: { member_pids?: unknown; complete?: unknown } | null = null;
    try {
      meta = this.#store.readAttemptMeta<{ member_pids?: unknown; complete?: unknown }>(taskId, attempt, "cleanup-failure.json") ?? null;
    } catch {
      // Read failure: the marker above still covers the recorded members;
      // falling back to root-only would narrow coverage and is not done.
    }
    if (meta === null) return targets;
    // A record that declares itself partial can never bound a release.
    if (meta.complete === false) {
      throw new TaskManagerError("CANCEL_FAILED", "cleanup member record is incomplete: the structured member list is marked partial; the task stays occupied");
    }
    // A present-but-corrupt record must fail the release, not narrow it.
    for (const pid of this.#validMemberPids(meta.member_pids)) addPid(pid, null);
    return targets;
  }

  /** Applies confirmed probe verdicts to one unchanged attempt snapshot. */
  #applyReconcileVerdicts(
    taskId: string,
    status: InternalTaskStatus,
    snapshot: { attempt: number; worker_pid: number | null; zcode_pid: number | null; started_at: string | null; heartbeat: ReturnType<TaskStore["readWorkerHeartbeat"]> },
    verdicts: { worker: ProbeVerdict; runtime: ProbeVerdict },
  ): void {
    if (status.cleanup_unverified === true) {
      // ADR-009 / review-round-1 R1: a latched descendant-cleanup failure is
      // never cleared by recovery evidence — neither a persisted worker
      // result, nor an outcome checkpoint, nor worker_lost finalization.
      // Only a cancel's probe-verified, claimant-scan-gated release may
      // clear it; occupancy is retained until then.
      const occurrence = this.#counters.record("reconcile_latched_cleanup", "cleanup_unverified");
      if (this.#counters.shouldEmit("reconcile_latched_cleanup", "cleanup_unverified")) {
        this.#store.appendEvent(taskId, "cleanup_unverified", "Reconciliation skipped: a recorded tree-cleanup failure keeps the task occupied until a verified cancel releases it", {
          count: occurrence.count,
        }, this.#now().toISOString());
      }
      return;
    }
    const persistedResult = this.#store.readResult(taskId);
    if (persistedResult && persistedResult.attempt === status.attempt) {
      // The worker wrote the result but died before updating the status file.
      this.#store.writeStatus(taskId, {
        status: persistedResult.status,
        finished_at: persistedResult.finished_at,
        exit_code: persistedResult.exit_code,
        zcode_session_id: persistedResult.session_id,
        error_code: persistedResult.error_code ?? null,
        error: persistedResult.status === "failed" ? persistedResult.summary : null,
        worker_pid: null,
        cleanup_unverified: persistedResult.error_code === "cleanup_failed",
      });
      return;
    }
    const pid = status.worker_pid;
    const heartbeat = snapshot.heartbeat;
    const heartbeatAt = heartbeat ? Date.parse(heartbeat.heartbeat_at) : Number.NaN;
    const heartbeatAgeMs = this.#now().getTime() - heartbeatAt;
    if (pid !== null && heartbeat?.worker_pid === pid && heartbeatAgeMs >= 0 && heartbeatAgeMs <= 15_000) return;

    // Unknown probe verdicts never kill a task (A1-04, A2-02): the attempt
    // keeps its occupancy, no respawn, no worker_lost, only a bounded hint.
    // A task with NO recorded worker pid falls through to the cold-start
    // grace and respawn rules, exactly as the legacy contract decided it.
    if (verdicts.worker.state === "alive") return; // identity-confirmed running
    if (verdicts.worker.state === "unknown" && pid !== null) {
      const occurrence = this.#counters.record("worker_probe_unknown", verdicts.worker.reason_code);
      if (this.#counters.shouldEmit("worker_probe_unknown", verdicts.worker.reason_code)) {
        this.#store.appendEvent(taskId, "probe_unknown", "Worker liveness could not be confirmed; the task stays occupied", {
          reason_code: verdicts.worker.reason_code,
          count: occurrence.count,
          observed_at: verdicts.worker.observed_at,
        }, verdicts.worker.observed_at);
      }
      return;
    }

    // Worker exit is confirmed. Distinguish the runtime's fate by its own
    // verdict; an unknown runtime keeps the directory occupied.
    const runtimePid = status.zcode_pid ?? null;
    if (runtimePid !== null && verdicts.runtime.state === "alive") {
      if (this.#recoverOutcomeCheckpoint(taskId, status, runtimePid, false)) return;
      this.#store.writeStatus(taskId, { cleanup_unverified: true, error_code: "cleanup_failed", error: "Worker exited while ZCode remains alive; cancel to verify runtime cleanup" });
      return;
    }
    if (runtimePid !== null && verdicts.runtime.state === "unknown") {
      // Cannot confirm the runtime exited: no verified cleanup, no release.
      if (this.#recoverOutcomeCheckpoint(taskId, status, runtimePid, false)) return;
      const occurrence = this.#counters.record("runtime_probe_unknown", verdicts.runtime.reason_code);
      if (this.#counters.shouldEmit("runtime_probe_unknown", verdicts.runtime.reason_code)) {
        this.#store.appendEvent(taskId, "probe_unknown", "ZCode runtime exit could not be confirmed; cleanup stays unverified", {
          reason_code: verdicts.runtime.reason_code,
          count: occurrence.count,
        }, verdicts.runtime.observed_at);
      }
      this.#store.writeStatus(taskId, { cleanup_unverified: true, error_code: "cleanup_failed", error: "Worker exited; ZCode runtime exit could not be confirmed; cancel to verify cleanup" });
      return;
    }
    if (this.#recoverOutcomeCheckpoint(taskId, status, runtimePid, true)) return;
    // Cold-start grace. Several Bridge processes may share one data root, and
    // any of them can reconcile a task between the "running" status write and
    // the pid write in #startWorkerLocked (worker_pid null), while a freshly
    // spawned worker may die or look dead before it wrote started.json. A
    // state this fresh must not finalize worker_lost; the next tick
    // re-checks, so a genuine loss is reported once the grace expires.
    const startedAtMs = status.started_at === null ? Number.NaN : Date.parse(status.started_at);
    const withinGrace = Number.isFinite(startedAtMs) && this.#now().getTime() - startedAtMs < this.#workerStartGraceMs;
    const workerBegan = this.#store.readAttemptMeta(taskId, status.attempt, "started.json") !== null;
    if (pid === null && withinGrace) return; // possibly still inside the spawn window
    if (pid !== null && workerBegan && withinGrace) return; // outcome may still be in flight
    // A worker that exited before writing started.json never ran the task.
    // Spawn one replacement for the same attempt, claim-gated so the Bridge
    // processes sharing this data root cannot double-spawn; a replacement
    // that is still in flight (fresh claim) is left alone for the next tick.
    // A worker that did start is never auto-respawned: its attempt may have
    // already touched the workspace, so only the master decides to retry.
    if (!workerBegan) {
      if (this.#store.claimAttemptRespawn(taskId, status.attempt)) {
        const respawned = this.#spawnWorker(this.#dataRoot, taskId, status.attempt);
        this.#store.writeStatus(taskId, { worker_pid: respawned.pid });
        this.#store.appendEvent(
          taskId,
          "worker_respawned",
          `Bridge respawned the worker: previous pid ${String(pid)} exited before writing any task state`,
          { worker_pid: respawned.pid, worker_pid_previous: pid, attempt: status.attempt },
        );
        return;
      }
      const claimedAt = this.#store.respawnClaimedAt(taskId, status.attempt);
      if (claimedAt && Date.now() - claimedAt.getTime() < BridgeTaskManager.RESPAWN_IN_FLIGHT_MS) return; // another process's respawn is in flight
      // Stale claim and still no started.json: the replacement died too.
    }
    const task = this.#store.readTask(taskId);
    const finishedAt = this.#now().toISOString();
    const workerStderr = this.#store.readAttemptText(taskId, status.attempt, "worker-stderr.log") ?? "";
    const failure: TaskFailure = {
      code: "worker_lost",
      message: `worker pid ${String(pid)} is gone without a terminal result${workerStderr.trim() ? "; diagnostic stderr is available in private attempt evidence" : "; worker stderr was empty"}`,
    };
    const result = buildTaskResult({
      task,
      attempt: status.attempt,
      startedAt: status.started_at,
      finishedAt,
      outcome: null,
      failure,
      sessionId: status.zcode_session_id,
    });
    this.#store.writeResult(taskId, result);
    this.#store.writeStatus(taskId, {
      status: "failed",
      finished_at: finishedAt,
      error_code: "worker_lost",
      error: result.summary,
      worker_pid: null,
    });
    this.#store.appendEvent(taskId, "error", result.summary, { error_code: "worker_lost" }, finishedAt);
  }

  async createTask(task: TaskPackage): Promise<TaskReceipt> {
    return this.#exclusive(async () => {
      this.#validateTaskPackage(task);
      if (this.#store.hasTask(task.task_id)) {
        const existing = this.#store.readTask(task.task_id);
        const ref = this.#store.readWorkspaceRef(task.task_id);
        const sameWorkspace = path.resolve(task.workspace) === path.resolve(ref?.requestedPath ?? existing.workspace);
        const sameExecutionPath = task.worktree_path === undefined
          ? existing.worktree_path === undefined
          : existing.worktree_path !== undefined && path.resolve(task.worktree_path) === path.resolve(ref?.canonicalPath ?? existing.worktree_path);
        const normalizedRetry: TaskPackage = {
          ...task,
          workspace: existing.workspace,
          ...(existing.worktree_path === undefined ? { worktree_path: undefined } : { worktree_path: existing.worktree_path }),
        };
        const fingerprint = createHash("sha256").update(stableJson(normalizedRetry)).digest("hex");
        const previous = this.#store.readSubmission<{ fingerprint: string; receipt: TaskReceipt }>(task.task_id);
        const existingFingerprint = previous?.fingerprint ?? createHash("sha256").update(stableJson(existing)).digest("hex");
        if (!sameWorkspace || !sameExecutionPath || existingFingerprint !== fingerprint) {
          throw new TaskManagerError("TASK_ID_CONFLICT", `task_id already belongs to a different request: ${task.task_id}`);
        }
        const status = this.#store.readStatus(task.task_id);
        const receipt = previous?.receipt ?? {
          task_id: task.task_id,
          status: status.status === "running" ? "running" as const : "queued" as const,
          created_at: status.created_at,
        };
        this.#store.writeSubmission(task.task_id, { fingerprint, receipt });
        return receipt;
      }
      let workspaceRef;
      try {
        workspaceRef = await this.#workspaceProvider.resolve(task.workspace, task.task_id, task.worktree_path);
      } catch (error) {
        throw new TaskManagerError(
          "TASK_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
      const createdAt = this.#now().toISOString();
      try { buildTaskPrompt(task); } catch (error) { throw new TaskManagerError("TASK_INVALID", String(error)); }
      const normalizedTask: TaskPackage = {
        ...task,
        workspace: workspaceRef.sourcePath ?? workspaceRef.canonicalPath,
        ...(workspaceRef.mode === "worktree" ? { worktree_path: workspaceRef.canonicalPath } : { worktree_path: undefined }),
      };
      const fingerprint = createHash("sha256").update(stableJson(normalizedTask)).digest("hex");
      try {
        this.#store.createTask(normalizedTask, createdAt);
        this.#store.writeWorkspaceRef(task.task_id, workspaceRef);
      } catch (error) {
        await this.#workspaceProvider.release(workspaceRef).catch(() => undefined);
        throw error;
      }
      this.#store.appendEvent(task.task_id, "queued", "Task accepted and queued", undefined, createdAt);
      this.#store.appendEvent(task.task_id, "workspace_ready", workspaceRef.mode === "worktree"
        ? "Using the the calling host-selected worktree for execution under the requested project"
        : "Using the requested project directory for execution", {
          project_path: workspaceRef.sourcePath ?? workspaceRef.canonicalPath,
          execution_path: workspaceRef.canonicalPath,
          ...(workspaceRef.mode === "worktree" ? { worktree_path: workspaceRef.canonicalPath } : {}),
          mode: workspaceRef.mode,
          ...(workspaceRef.branchName ? { branch_name: workspaceRef.branchName } : {}),
        }, createdAt);
      // Commit an accepted receipt before dispatch so a crash or lost MCP
      // response cannot turn a retry into a second execution.
      const acceptedReceipt: TaskReceipt = { task_id: task.task_id, status: "queued", created_at: createdAt };
      this.#store.writeSubmission(task.task_id, { fingerprint, receipt: acceptedReceipt });
      this.#pumpLocked();
      const status = this.#store.readStatus(task.task_id);
      const receipt: TaskReceipt = status.status === "running" ? {
        task_id: task.task_id,
        status: "running",
        created_at: createdAt,
      } : acceptedReceipt;
      if (receipt !== acceptedReceipt) this.#store.writeSubmission(task.task_id, { fingerprint, receipt });
      return receipt;
    });
  }

  async getStatus(taskId: string): Promise<TaskStatusRecord> {
    // Status is an atomic persisted snapshot. Do not make callers wait behind
    // a recovery scan or a slow worker cleanup operation; the observation is
    // assembled from persisted evidence only — no OS query on the read path.
    this.#requireTask(taskId);
    const status = this.#store.readStatus(taskId);
    const observation = this.#safeObservation(taskId, status);
    return { ...toPublicStatus(status), ...(observation ? { observation } : {}) };
  }

  /** Observation built by the shared judger; a corrupt/failed build degrades
   * to a minimal unknown observation instead of failing the status read.
   * Fresh persisted probe verdicts from the recovery scan are included. */
  #safeObservation(taskId: string, status: InternalTaskStatus): TaskObservation | null {
    try {
      const snapshot = this.#store.readObservationSnapshot(taskId, status.attempt).snapshot;
      const probes = snapshot?.worker_probe || snapshot?.runtime_probe
        ? {
            task_id: taskId,
            attempt: status.attempt,
            worker_pid: status.worker_pid,
            runtime_pid: status.zcode_pid ?? null,
            worker: (snapshot!.worker_probe ?? { state: "unknown", reason_code: "not_probed" }) as { state: "alive" | "exited" | "unknown"; reason_code: string },
            runtime: (snapshot!.runtime_probe ?? { state: "unknown", reason_code: "not_probed" }) as { state: "alive" | "exited" | "unknown"; reason_code: string },
            probed_at: snapshot!.updated_at,
          }
        : null;
      return buildTaskObservation(this.#store, taskId, status, {
        now: this.#now,
        startGraceMs: this.#workerStartGraceMs,
        stallHintMs: this.#stallHintMs,
        probes,
      });
    } catch {
      return null;
    }
  }

  async getEvents(input: GetEventsInput): Promise<TaskProgressPage> {
    const afterSeq = input.after_seq ?? 0;
    const limit = input.limit ?? 100;
    const waitMs = input.wait_ms ?? 0;
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new TaskManagerError("TASK_INVALID", "after_seq must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TaskManagerError("TASK_INVALID", "limit must be an integer from 1 to 200");
    }
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
      throw new TaskManagerError("TASK_INVALID", "wait_ms must be an integer from 0 to 25000");
    }
    if (input.view !== undefined && input.view !== "raw" && input.view !== "summary") {
      throw new TaskManagerError("TASK_INVALID", "view must be raw or summary");
    }
    if (input.max_bytes !== undefined && (!Number.isInteger(input.max_bytes) || input.max_bytes < 1024 || input.max_bytes > 32 * 1024 * 1024)) {
      throw new TaskManagerError("TASK_INVALID", "max_bytes must be an integer from 1024 to 33554432");
    }
    let startCursor: EventsScanCursor | null = null;
    if (input.scan_cursor !== undefined) {
      if (typeof input.scan_cursor !== "string" || input.scan_cursor.length > 2_048) {
        throw new TaskManagerError("TASK_INVALID", "scan_cursor must be an opaque cursor string returned by a previous page");
      }
      try {
        const decoded = JSON.parse(Buffer.from(input.scan_cursor, "base64url").toString("utf8")) as EventsScanCursor;
        if (decoded?.v !== 1 || decoded.task_id !== input.task_id) throw new Error("cursor does not belong to this task");
        startCursor = decoded;
      } catch {
        throw new TaskManagerError("TASK_INVALID", "scan_cursor is not a valid cursor for this task; restart the scan with after_seq");
      }
    }
    const deadline = Date.now() + waitMs;
    const readPage = (): TaskProgressPage & { cursor_invalid?: boolean } => {
      this.#requireTask(input.task_id);
      const status = this.#store.readStatus(input.task_id);
      const observation = this.#safeObservation(input.task_id, status);
      const bounded = Boolean(startCursor) || input.max_bytes !== undefined;
      const read = bounded
        ? this.#store.readEventsBounded(input.task_id, { afterSeq, limit, view: input.view ?? "raw", maxBytes: input.max_bytes, cursor: startCursor })
        : this.#store.readEvents(input.task_id, afterSeq, limit, input.view ?? "raw");
      const page: TaskProgressPage = {
        task_id: input.task_id,
        status: status.status,
        events: read.events,
        next_seq: read.nextSeq,
        has_more: read.hasMore,
        ...(read.omittedEvents ? { omitted_events: read.omittedEvents } : {}),
        ...(observation ? { observation } : {}),
      };
      if (bounded) {
        const scan = read as ReturnType<TaskStore["readEventsBounded"]>;
        if (scan.scan_incomplete) page.scan_incomplete = true;
        if (scan.scan_cursor) page.scan_cursor = encodeScanCursor(scan.scan_cursor);
        page.scan_metrics = {
          bytes_read: scan.metrics.bytes_read,
          records_scanned: scan.metrics.records_scanned,
          invalid_lines: scan.metrics.invalid_lines,
          corrupt_count: scan.metrics.corrupt_count,
          first_corrupt_offset: scan.metrics.first_corrupt_offset,
          index_fallback: scan.metrics.index_fallback ? 1 : 0,
        };
        return { ...page, cursor_invalid: scan.cursor_invalid };
      }
      return page;
    };
    while (true) {
      const page = readPage();
      if (page.cursor_invalid) {
        throw new TaskManagerError("TASK_INVALID", "scan_cursor no longer matches the task log (log replaced or truncated); restart with after_seq");
      }
      if (page.events.length || isTerminalStatus(page.status) || Date.now() >= deadline) return page;
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  async getFeedback(taskId: string): Promise<TaskFeedbackSnapshotV01> {
    this.#requireTask(taskId);
    const status = this.#store.readStatus(taskId);
    const startTime = status.started_at ? Date.parse(status.started_at) : Number.NaN;
    const relevantTypes = new Set(["model_selected", "model_tool_call", "tool_status", "report_ready", "worker_started"]);
    const attemptEvents = [];
    let afterSeq = 0;
    while (true) {
      const previousSeq = afterSeq;
      const page = this.#store.readEvents(taskId, afterSeq, 200, "raw");
      for (const event of page.events) {
        const eventTime = Date.parse(event.at);
        if (!Number.isFinite(startTime) || !Number.isFinite(eventTime) || eventTime < startTime) continue;
        if (relevantTypes.has(event.type)) attemptEvents.push(event);
      }
      afterSeq = page.nextSeq;
      if (!page.hasMore || page.nextSeq <= previousSeq) break;
    }
    let currentWorkerStarted: TaskProgressEvent | null = null;
    for (const event of attemptEvents) {
      if (event.type === "worker_started" && event.details?.["attempt"] === status.attempt) currentWorkerStarted = event;
    }
    const events = attemptEvents.filter((event) => {
      if (event.type === "worker_started") return false;
      if (!currentWorkerStarted) return true; // Legacy events lack attempt on worker_started; timestamp scoped above.
      return event.seq > currentWorkerStarted.seq;
    });
    const result = isTerminalStatus(status.status) ? this.#store.readResult(taskId) : null;
    return buildTaskFeedbackSnapshotV01({ status: toPublicStatus(status), events, result });
  }

  async getResult(taskId: string): Promise<TaskResult> {
    return (async () => {
      this.#requireTask(taskId);
      const status = this.#store.readStatus(taskId);
      if (!isTerminalStatus(status.status)) {
        throw new TaskManagerError(
          "TASK_NOT_FINISHED",
          `task ${taskId} is not finished (status: ${status.status})`,
        );
      }
      const result = this.#store.readResult(taskId);
      if (!result) {
        throw new TaskManagerError(
          "TASK_NOT_FINISHED",
          `task ${taskId} has terminal status ${status.status} but no persisted result`,
        );
      }
      return result;
    })();
  }

  async replyToInteraction(input: ZCodeInteractionReplyInput): Promise<{ task_id: string; request_id: string; state: "answered" }> {
    return this.#exclusive(async () => {
      this.#requireTask(input.task_id);
      if (typeof input.request_id !== "string" || !input.request_id.trim() || input.request_id.length > 512) {
        throw new TaskManagerError("TASK_INVALID", "request_id must be a non-empty string up to 512 characters");
      }
      const status = this.#store.readStatus(input.task_id);
      if (status.status !== "running") {
        throw new TaskManagerError("TASK_STATE", `ZCode interaction can only be answered while the task is running (status: ${status.status})`);
      }
      let record: ReturnType<TaskStore["readInteractionRequest"]>;
      try {
        const read = this.#store.readInteractionRequest(input.task_id, input.request_id);
        if (!read) throw new TaskManagerError("TASK_NOT_FOUND", `unknown ZCode interaction request: ${input.request_id}`);
        record = read;
      } catch (error) {
        if (error instanceof TaskManagerError) throw error;
        // Corrupt full-request records are never treated as authorization
        // (ADR-008); the explicit reason replaces a raw filesystem error.
        throw new TaskManagerError(
          "TASK_STATE",
          `ZCode interaction request ${input.request_id} could not be read: the persisted full request is unreadable or corrupt`,
        );
      }
      if (record.state === "answered") {
        throw new TaskManagerError("TASK_STATE", `ZCode interaction request ${input.request_id} was already answered`);
      }
      const answer = buildInteractionAnswer(record, input);
      // ADR-008: an approval may only be recorded when the full request it
      // refers to is available and consistent; damaged or edited records
      // cannot count as granted authorization. The check runs under the same
      // interaction lock as the answer write, so the verified record is
      // exactly the one the answer lands on.
      const answered = input.decision === "allow" || input.decision === "accept"
        ? this.#store.answerInteractionRequestVerified(input.task_id, input.request_id, answer, { requireIntegrity: true }, this.#now().toISOString())
        : { state: this.#store.answerInteractionRequest(input.task_id, input.request_id, answer, this.#now().toISOString()) } as const;
      if (answered.state === "already_answered") {
        throw new TaskManagerError("TASK_STATE", `ZCode interaction request ${input.request_id} was already answered`);
      }
      if (answered.state === "integrity_failed") {
        throw new TaskManagerError(
          "TASK_STATE",
          `ZCode interaction request ${input.request_id} cannot be approved: ${answered.reason}; the approval was not recorded as granted`,
        );
      }
      this.#store.appendEvent(input.task_id, "interaction_reply_submitted", "the calling host submitted a response to the ZCode interaction", {
        request_id: input.request_id,
        method: record.method,
        decision: input.decision,
      }, this.#now().toISOString());
      return { task_id: input.task_id, request_id: input.request_id, state: "answered" };
    });
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskReceipt> {
    return this.#exclusive(async () => {
      const taskId = input.task_id;
      this.#requireTask(taskId);
      if (typeof input.feedback !== "string" || input.feedback.trim().length === 0) {
        throw new TaskManagerError("TASK_INVALID", "feedback must be a non-empty string");
      }
      if (
        input.additional_requirements !== undefined &&
        (!Array.isArray(input.additional_requirements) ||
          input.additional_requirements.some((item) => typeof item !== "string"))
      ) {
        throw new TaskManagerError("TASK_INVALID", "additional_requirements must be an array of strings");
      }
      const status = this.#store.readStatus(taskId);
      const continueFingerprint = createHash("sha256").update(stableJson({ feedback: input.feedback, additional_requirements: input.additional_requirements ?? [] })).digest("hex");
      if (input.operation_id !== undefined && (typeof input.operation_id !== "string" || !input.operation_id.trim() || input.operation_id.length > 128)) {
        throw new TaskManagerError("TASK_INVALID", "operation_id must be a non-empty string up to 128 characters");
      }
      if (input.operation_id) {
        for (let attempt = 2; attempt <= status.attempt; attempt += 1) {
          const prior = this.#store.readAttemptMeta<{ operation_id?: string; fingerprint?: string; receipt?: TaskReceipt }>(taskId, attempt, "continue.json");
          if (prior?.operation_id !== input.operation_id) continue;
          if (prior.fingerprint !== continueFingerprint) throw new TaskManagerError("CONTINUE_OPERATION_CONFLICT", "operation_id already belongs to different continuation input");
          if (prior.receipt) return prior.receipt;
          return { task_id: taskId, status: status.status === "running" ? "running" : "queued", created_at: status.created_at };
        }
      }
      // cancelled is continuable: cancel records it only after the process
      // tree is verified gone, and interaction records are keyed by the
      // current attempt, so a request left unanswered by the cancelled
      // attempt cannot be answered from the next one.
      if (!["completed", "failed", "cancelled", "waiting_for_master"].includes(status.status)) {
        throw new TaskManagerError(
          "TASK_STATE",
          `zcode_continue is not allowed from status ${status.status}`,
        );
      }
      if (status.cleanup_unverified) throw new TaskManagerError("TASK_STATE", "Cannot continue until unverified ZCode process cleanup is resolved");
      const task = this.#store.readTask(taskId);
      // The continuation reuses the original workspace; it must still resolve
      // to the same canonical directory.
      try {
        const ref = await this.#workspaceProvider.resolve(task.workspace, taskId, task.worktree_path);
        const recorded = this.#store.readWorkspaceRef(taskId);
        if (recorded && (ref.canonicalPath !== recorded.canonicalPath || ref.requestedPath !== recorded.requestedPath)) {
          throw new Error(`project or execution workspace no longer resolves to its recorded path`);
        }
      } catch (error) {
        throw new TaskManagerError(
          "TASK_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
      const previousAttempt = status.attempt;
      const previousResult = this.#store.readResult(taskId);
      try { buildContinuePrompt({ task, feedback: input.feedback, additionalRequirements: input.additional_requirements ?? [], previousSessionId: previousResult?.session_id ?? status.zcode_session_id, previousResult }); }
      catch (error) { throw new TaskManagerError("TASK_INVALID", String(error)); }
      const nextAttempt = previousAttempt + 1;
      const createdAt = this.#now().toISOString();
      const continuationReceipt: TaskReceipt = { task_id: taskId, status: "queued", created_at: createdAt };

      // Preserve prior evidence: the previous terminal result is archived into
      // its attempt directory before the new attempt starts.
      this.#store.archiveResultToAttempt(taskId, previousAttempt);
      this.#store.writeAttemptMeta(taskId, nextAttempt, "continue.json", {
        ...(input.operation_id ? { operation_id: input.operation_id, fingerprint: continueFingerprint, receipt: continuationReceipt } : {}),
        feedback: input.feedback,
        additional_requirements: [...(input.additional_requirements ?? [])],
        previous_session_id: previousResult?.session_id ?? status.zcode_session_id,
        previous_attempt: previousAttempt,
      });
      this.#store.writeStatus(taskId, {
        status: "queued",
        attempt: nextAttempt,
        started_at: null,
        finished_at: null,
        worker_pid: null,
        zcode_session_id: null,
        exit_code: null,
        error_code: null,
        error: null,
        cancel_requested: null,
        zcode_pid: null,
        cleanup_unverified: null,
      });
      this.#pumpLocked();
      const after = this.#store.readStatus(taskId);
      const receipt: TaskReceipt = {
        task_id: taskId,
        status: after.status === "running" ? "running" : "queued",
        created_at: after.updated_at,
      };
      if (input.operation_id) this.#store.writeAttemptMeta(taskId, nextAttempt, "continue.json", {
        ...this.#store.readAttemptMeta(taskId, nextAttempt, "continue.json"),
        receipt,
      });
      return receipt;
    });
  }

  async cancelTask(taskId: string): Promise<TaskStatusRecord> {
    return this.#exclusive(async () => {
      this.#requireTask(taskId);
      const status = this.#store.readStatus(taskId);
      const identity = this.#store.readExecutorIdentity(taskId, status.attempt);
      const started = this.#store.readAttemptMeta<{ worker_pid?: number }>(taskId, status.attempt, "started.json");
      const probeSnapshot = {
        attempt: status.attempt,
        worker_pid: status.worker_pid ?? identity?.worker?.pid ?? started?.worker_pid ?? null,
        zcode_pid: status.zcode_pid ?? null,
        identity,
      };
      // Identity re-verification always happens fresh here, never from cache
      // (A2): a reused PID must never be signalled for the old executor.
      const verdicts = await this.#probeExecutors(probeSnapshot);
      const workerFingerprint = typeof probeSnapshot.identity?.worker?.fingerprint === "string" ? probeSnapshot.identity.worker.fingerprint : null;
      const runtimeFingerprint = typeof probeSnapshot.identity?.runtime?.fingerprint === "string" ? probeSnapshot.identity.runtime.fingerprint : null;
      if (status.cleanup_unverified) {
        if (probeSnapshot.worker_pid === null && probeSnapshot.zcode_pid === null) {
          throw new TaskManagerError("CANCEL_FAILED", "No worker or ZCode process identity is available to verify cleanup");
        }
        if (probeSnapshot.zcode_pid !== null && verdicts.runtime.state === "unknown") {
          throw new TaskManagerError("CANCEL_FAILED", `ZCode cleanup could not be verified: runtime probe returned ${verdicts.runtime.reason_code}`);
        }
        if (probeSnapshot.worker_pid !== null && verdicts.worker.state === "unknown") {
          throw new TaskManagerError("CANCEL_FAILED", `Worker cleanup could not be verified: worker probe returned ${verdicts.worker.reason_code}`);
        }
        const verifiedRoots = new Set<number>();
        try {
          if (probeSnapshot.zcode_pid !== null && verdicts.runtime.state === "alive") {
            await this.#terminateProcessTree(probeSnapshot.zcode_pid, { graceMs: 500, killWaitMs: 5_000, expectedRootFingerprint: runtimeFingerprint });
            const after = (await this.#probeExecutors(probeSnapshot)).runtime;
            if (after.state === "alive") throw new Error("runtime still alive after termination");
            if (after.state === "unknown") throw new Error(`runtime exit could not be verified (${after.reason_code})`);
            verifiedRoots.add(probeSnapshot.zcode_pid);
          }
          if (probeSnapshot.worker_pid !== null && verdicts.worker.state === "alive") {
            await this.#terminateProcessTree(probeSnapshot.worker_pid, { graceMs: 500, killWaitMs: 5_000, expectedRootFingerprint: workerFingerprint });
            verifiedRoots.add(probeSnapshot.worker_pid);
          }
        }
        catch (error) {
          // ADR-009: a termination failure means the tree state is unverified.
          // It is never cleared by executor-only exit evidence — a known
          // descendant/ownership failure keeps the directory occupied, and a
          // later cancel re-enters this branch after fresh probes.
          this.#recordCleanupFailure(taskId, status.attempt, error);
          throw new TaskManagerError("CANCEL_FAILED", `ZCode cleanup could not be verified: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Recorded pids whose tree was not itself verified-terminated in
        // this cancel are gated by the read-only claimant scan: releasing on
        // root-executor exit evidence alone could orphan an untracked
        // descendant (ADR-009; unobserved intermediate ancestors remain
        // outside any proof and are logged, not claimed complete).
        const scanTargets = this.#claimantTargets(taskId, status.attempt, probeSnapshot).filter((target) => !verifiedRoots.has(target.pid));
        if (scanTargets.length > 0) {
          // Review-round-2 S2: whenever the scan keeps occupancy — false OR
          // rejected — the task-relevant pids it actually observed/requested
          // join the durable member evidence through the SAME monotonic
          // cleanup-failure record and marker used for termination
          // failures, so a later cancel (or a recreated manager) still scans
          // them; a pid already observed here is not an "unobserved
          // ancestor" later. Only pids the scan itself reports as its own
          // observation evidence are retained — never arbitrary pids from
          // malformed response payloads — and a clean scan records nothing.
          const retainObserved = (observed: readonly number[] | undefined, livePids: readonly number[] | undefined, error?: unknown): void => {
            const fromError = error instanceof WindowsTreeCleanupError ? error.memberPids : [];
            const pids = [...new Set([...(observed ?? []), ...(livePids ?? []), ...fromError])].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
            if (pids.length === 0) return;
            const carrier = error instanceof WindowsTreeCleanupError && error.memberPids.length > 0
              ? error
              : new WindowsTreeCleanupError(
                "process_tree_cleanup_unverified",
                `recorded-tree scan keeps occupancy: ${pids.join(",")} still requires attribution`,
                pids,
              );
            this.#recordCleanupFailure(taskId, status.attempt, carrier);
          };
          const scan = await this.#verifyTreeClean(scanTargets).catch((error: unknown) => {
            retainObserved(undefined, undefined, error);
            throw new TaskManagerError("CANCEL_FAILED", `ZCode cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          if (!scan.clean) {
            retainObserved(scan.observedPids, scan.livePids);
            this.#store.appendEvent(taskId, "cleanup_unverified", "Recorded-tree scan still observes live claimants; the task stays occupied", { live_pids: [...scan.livePids] }, this.#now().toISOString());
            throw new TaskManagerError("CANCEL_FAILED", `ZCode cleanup could not be verified: ${String(scan.livePids.length)} recorded-tree process(es) still alive`);
          }
        }
        if (status.status === "running") {
          const finishedAt = this.#now().toISOString();
          const result = buildTaskResult({ task: this.#store.readTask(taskId), attempt: status.attempt, startedAt: status.started_at, finishedAt, outcome: null, cancelled: true, sessionId: status.zcode_session_id });
          this.#store.writeResult(taskId, result);
          this.#store.writeStatus(taskId, { status: "cancelled", finished_at: finishedAt, worker_pid: null, cleanup_unverified: null, zcode_pid: null, error: null, error_code: null, cancel_requested: null });
        } else this.#store.writeStatus(taskId, { cleanup_unverified: null, zcode_pid: null });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId));
      }
      if (isTerminalStatus(status.status)) {
        throw new TaskManagerError(
          "TASK_STATE",
          `zcode_cancel is not allowed from status ${status.status}`,
        );
      }
      const task = this.#store.readTask(taskId);

      if (status.status === "running" && this.#store.readResult(taskId)) {
        // The worker already persisted a terminal result: align the lagging
        // status record instead of terminating anything.
        const raced = this.#store.readResult(taskId)!;
        this.#store.writeStatus(taskId, {
          status: raced.status,
          finished_at: raced.finished_at,
          exit_code: raced.exit_code,
          zcode_session_id: raced.session_id,
          error_code: raced.error_code ?? null,
          error: raced.status === "failed" ? raced.summary : null,
          worker_pid: null,
          cleanup_unverified: raced.error_code === "cleanup_failed",
        });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId));
      }

      if (status.status === "queued") {
        const finishedAt = this.#now().toISOString();
        const result = buildTaskResult({
          task,
          attempt: status.attempt,
          startedAt: null,
          finishedAt,
          outcome: null,
          failure: { code: "cancelled", message: "cancelled by request before the task started" },
          cancelled: true,
        });
        this.#store.writeResult(taskId, result);
        this.#store.writeStatus(taskId, { status: "cancelled", finished_at: finishedAt });
        this.#store.appendEvent(taskId, "cancelled", "Queued task cancelled before worker start", undefined, finishedAt);
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId));
      }

      // Running: persist the intent, then terminate and verify the worker
      // process tree before recording the cancelled terminal state.
      this.#store.writeStatus(taskId, { cancel_requested: true });
      this.#store.appendEvent(taskId, "cancel_requested", "Cancellation requested; waiting for process-tree confirmation", undefined, this.#now().toISOString());
      const pid = status.worker_pid;
      if (pid === null) {
        // No worker process was recorded; nothing to terminate, record loss.
        const finishedAt = this.#now().toISOString();
        const result = buildTaskResult({
          task,
          attempt: status.attempt,
          startedAt: status.started_at,
          finishedAt,
          outcome: null,
          failure: { code: "worker_lost", message: "running task had no worker pid recorded" },
        });
        this.#store.writeResult(taskId, result);
        this.#store.writeStatus(taskId, {
          status: "failed",
          finished_at: finishedAt,
          error_code: "worker_lost",
          error: result.summary,
        });
        return toPublicStatus(this.#store.readStatus(taskId));
      }
      // A probe-confirmed exit (including PID reuse) means the old executor is
      // already gone: never signal the recycled PID's new owner (A2-01).
      if (verdicts.worker.state === "exited") {
        // The worker may have completed while the probe ran; a persisted
        // terminal result always wins over our cancellation (A2-04).
        const racedEarly = this.#store.readResult(taskId);
        if (racedEarly) {
          this.#store.writeStatus(taskId, {
            status: racedEarly.status,
            finished_at: racedEarly.finished_at,
            exit_code: racedEarly.exit_code,
            zcode_session_id: racedEarly.session_id,
            error_code: racedEarly.error_code ?? null,
            error: racedEarly.status === "failed" ? racedEarly.summary : null,
            worker_pid: null,
            cancel_requested: null,
            cleanup_unverified: racedEarly.error_code === "cleanup_failed",
            zcode_pid: racedEarly.error_code === "cleanup_failed" ? status.zcode_pid ?? null : null,
          });
          this.#pumpLocked();
          return toPublicStatus(this.#store.readStatus(taskId));
        }
        const finishedAt = this.#now().toISOString();
        const reused = verdicts.worker.reason_code.startsWith("pid_reused");
        const result = buildTaskResult({
          task,
          attempt: status.attempt,
          startedAt: status.started_at,
          finishedAt,
          outcome: null,
          failure: {
            code: "cancelled",
            message: reused
              ? `cancelled by request; the recorded worker pid ${String(pid)} was reused by another process, so the previous executor had already exited`
              : `cancelled by request; the recorded worker pid ${String(pid)} no longer exists`,
          },
          cancelled: true,
          sessionId: status.zcode_session_id,
        });
        this.#store.writeResult(taskId, result);
        this.#store.appendEvent(taskId, "cancelled", "Cancellation confirmed without termination: the recorded worker process was already gone", { reason_code: verdicts.worker.reason_code }, finishedAt);
        this.#store.writeStatus(taskId, {
          status: "cancelled",
          finished_at: finishedAt,
          worker_pid: null,
          cleanup_unverified: verdicts.runtime.state !== "exited" && status.zcode_pid !== null,
          zcode_pid: verdicts.runtime.state === "exited" ? null : status.zcode_pid,
          cancel_requested: null,
        });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId));
      }
      const finishedSafely = (): boolean => {
        const result = this.#store.readResult(taskId);
        return result !== null && result.error_code !== "cleanup_failed"
          && !this.#store.readStatus(taskId).cleanup_unverified
          && !this.#isProcessRunning(pid)
          && (!status.zcode_pid || !this.#isProcessRunning(status.zcode_pid));
      };
      const waitForSafeExit = async (): Promise<boolean> => {
        const deadline = Date.now() + 500;
        do {
          if (finishedSafely()) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        return finishedSafely();
      };
      // Let the worker abort its interaction/RPC and verify its own runtime
      // cleanup first. Concurrent taskkill calls can race an ordinary exit.
      try {
        if (!(await waitForSafeExit())) {
          if (process.platform !== "win32" && status.zcode_pid && this.#isProcessRunning(status.zcode_pid)) {
            await this.#terminateProcessTree(status.zcode_pid, { graceMs: 500, killWaitMs: 5_000, expectedRootFingerprint: runtimeFingerprint });
          }
          await this.#terminateProcessTree(pid, { graceMs: 500, killWaitMs: 5_000, expectedRootFingerprint: workerFingerprint });
        }
      } catch (error) {
        // ADR-009: a termination failure is never absolved by the worker's
        // own exit or result arriving meanwhile — descendants were not proven
        // exited, so verified is not replaced by root exit and the directory
        // stays occupied. A later cancel re-enters the cleanup_unverified
        // flow with fresh probes and the recorded-tree scan.
        this.#recordCleanupFailure(taskId, status.attempt, error);
        const message = error instanceof Error ? error.message : String(error);
        throw new TaskManagerError(
          "CANCEL_FAILED",
          `process-tree termination for task ${taskId} (pid ${pid}) could not be verified: ${message}`,
        );
      }
      // The worker may have completed while termination was in flight; a
      // persisted terminal result always wins over our cancellation.
      const raced = this.#store.readResult(taskId);
      if (raced) {
        this.#store.writeStatus(taskId, {
          status: raced.status,
          finished_at: raced.finished_at,
          exit_code: raced.exit_code,
          zcode_session_id: raced.session_id,
          error_code: raced.error_code ?? null,
          error: raced.status === "failed" ? raced.summary : null,
          worker_pid: null,
          cancel_requested: null,
          cleanup_unverified: null,
          zcode_pid: null,
        });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId));
      }
      const finishedAt = this.#now().toISOString();
      const result = buildTaskResult({
        task,
        attempt: status.attempt,
        startedAt: status.started_at,
        finishedAt,
        outcome: null,
        failure: {
          code: "cancelled",
          message: `cancelled by request; worker process tree (pid ${pid}) was terminated and verified`,
        },
        cancelled: true,
        sessionId: status.zcode_session_id,
      });
      this.#store.writeResult(taskId, result);
      this.#store.appendEvent(taskId, "cancelled", "Worker process tree terminated and cancellation confirmed", undefined, finishedAt);
      this.#store.writeStatus(taskId, {
        status: "cancelled",
        finished_at: finishedAt,
        worker_pid: null,
        cleanup_unverified: null,
        zcode_pid: null,
        cancel_requested: null,
      });
      this.#pumpLocked();
      return toPublicStatus(this.#store.readStatus(taskId));
    });
  }

  // ---- internals (must be called under the mutex) ----

  #recoverOutcomeCheckpoint(
    taskId: string,
    status: { attempt: number; started_at: string | null; zcode_session_id?: string | null },
    runtimePid: number | null,
    runtimeExited: boolean,
  ): boolean {
    const checkpoint = this.#store.readAttemptMeta<Record<string, unknown>>(taskId, status.attempt, "outcome-checkpoint.json");
    if (!checkpoint || typeof checkpoint.response !== "string") return false;
    const outcome = {
      attempts: 1,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdout: checkpoint.response,
      stderr: "",
      exitCode: typeof checkpoint.exit_code === "number" ? checkpoint.exit_code : null,
      signal: typeof checkpoint.signal === "string" ? checkpoint.signal : null,
      sessionId: typeof checkpoint.session_id === "string" ? checkpoint.session_id : null,
      response: checkpoint.response,
      usage: checkpoint.usage && typeof checkpoint.usage === "object" ? checkpoint.usage : null,
      timedOut: false,
      agentReport: checkpoint.agent_report ?? null,
      reportCandidate: checkpoint.report_candidate && typeof checkpoint.report_candidate === "object" ? checkpoint.report_candidate : null,
      reportError: typeof checkpoint.report_error === "string" ? checkpoint.report_error : null,
      errorCode: typeof checkpoint.error_code === "string" ? checkpoint.error_code : null,
      cleanupError: typeof checkpoint.cleanup_error === "string" ? checkpoint.cleanup_error : null,
      cleanupVerified: checkpoint.cleanup_verified === true,
    } as ZCodeRunOutcome;
    const cleanupVerified = outcome.cleanupVerified && runtimeExited;
    const failure: TaskFailure | null = cleanupVerified ? null : {
      code: "cleanup_failed",
      message: outcome.cleanupError ?? "Worker exited before process cleanup could be verified; the ZCode result was recovered from its private checkpoint",
    };
    const finishedAt = this.#now().toISOString();
    const result = buildTaskResult({
      task: this.#store.readTask(taskId),
      attempt: status.attempt,
      startedAt: status.started_at,
      finishedAt,
      outcome,
      failure,
      sessionId: status.zcode_session_id ?? outcome.sessionId,
    });
    this.#store.commitWorkerResult(taskId, status.attempt, result, {
      status: result.status,
      finished_at: finishedAt,
      exit_code: result.exit_code,
      zcode_session_id: result.session_id,
      error_code: result.error_code ?? null,
      error: result.status === "failed" ? result.summary : null,
      worker_pid: null,
      cleanup_unverified: !cleanupVerified,
      zcode_pid: cleanupVerified ? null : runtimePid,
    });
    this.#store.appendEvent(taskId, "outcome_recovered", cleanupVerified
      ? "Recovered the completed ZCode report after the worker exited before committing its result"
      : "Recovered the ZCode report, but process cleanup could not be verified",
    { status: result.status, cleanup_verified: cleanupVerified }, finishedAt);
    return true;
  }

  #pumpLocked(): void {
    // Reuse one validated snapshot within this scheduling operation only.
    // Terminal/corrupt records remain checked; no cross-operation cache can
    // hide an external worker transition or release an unverified workspace.
    const snapshot = this.#store.listTaskIds().map((taskId) => ({ taskId, status: this.#safeStatus(taskId) }));
    const running = snapshot.filter(({ status }) => status?.status === "running" || status?.cleanup_unverified === true).map(({ taskId }) => taskId);
    if (running.length >= this.#maxConcurrentWorkers) return;

    const occupiedPaths = running.map((taskId) => this.#executionPathKeyLocked(taskId));
    for (const { taskId, status } of snapshot) {
      if (status) continue;
      try { occupiedPaths.push(this.#executionPathKeyLocked(taskId)); }
      catch { return; } // Unknown execution scope cannot be safely released.
    }
    let slots = this.#maxConcurrentWorkers - running.length;
    const queued = snapshot.filter(({ status }) => status?.status === "queued").sort((a, b) => a.status!.created_at.localeCompare(b.status!.created_at));
    for (const { taskId } of queued) {
      if (slots <= 0) break;
      const executionPath = this.#executionPathKeyLocked(taskId);
      // Never run two ZCode sessions against the same mutable directory.
      // Separate the calling host-prepared worktrees and separate project roots can run
      // concurrently, subject to the global worker limit.
      if (occupiedPaths.some((occupied) => pathsOverlap(occupied, executionPath))) continue;
      this.#startWorkerLocked(taskId);
      if (this.#store.readStatus(taskId).status === "running") {
        occupiedPaths.push(executionPath);
        slots -= 1;
      }
    }
  }

  #executionPathKeyLocked(taskId: string): string {
    const recorded = this.#store.readWorkspaceRef(taskId)?.canonicalPath;
    const task = recorded ? null : this.#store.readTask(taskId);
    const resolved = path.resolve(recorded ?? task!.worktree_path ?? task!.workspace);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  }

  #startWorkerLocked(taskId: string): void {
    const status = this.#store.readStatus(taskId);
    if (status.status !== "queued") return;
    this.#store.writeStatus(taskId, {
      status: "running",
      started_at: this.#now().toISOString(),
      worker_pid: null,
    });
    let pid: number;
    try {
      const spawned = this.#spawnWorker(this.#dataRoot, taskId, status.attempt);
      pid = spawned.pid;
    } catch (error) {
      const finishedAt = this.#now().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const task = this.#store.readTask(taskId);
      const result = buildTaskResult({
        task,
        attempt: status.attempt,
        startedAt: null,
        finishedAt,
        outcome: null,
        failure: { code: "spawn_failed", message },
      });
      this.#store.writeResult(taskId, result);
      this.#store.writeStatus(taskId, {
        status: "failed",
        finished_at: finishedAt,
        error_code: "spawn_failed",
        error: result.summary,
      });
      this.#store.appendEvent(taskId, "error", result.summary, { error_code: "spawn_failed" }, finishedAt);
      return;
    }
    this.#store.patchRunningAttempt(taskId, status.attempt, { worker_pid: pid });
    this.#store.appendEvent(taskId, "worker_started", "Bridge worker started", { worker_pid: pid, attempt: status.attempt }, this.#now().toISOString());
  }

  #requireTask(taskId: string): void {
    if (!this.#store.hasTask(taskId)) {
      throw new TaskManagerError("TASK_NOT_FOUND", `unknown task_id: ${taskId}`);
    }
  }

  #validateTaskPackage(task: TaskPackage): void {
    if (typeof task !== "object" || task === null) {
      throw new TaskManagerError("TASK_INVALID", "task package must be an object");
    }
    if (typeof task.task_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.task_id)) {
      throw new TaskManagerError(
        "TASK_INVALID",
        "task_id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}",
      );
    }
    if (typeof task.objective !== "string" || task.objective.trim().length === 0) {
      throw new TaskManagerError("TASK_INVALID", "objective must be a non-empty string");
    }
    for (const field of [
      "requirements",
      "allowed_paths",
      "forbidden_paths",
      "acceptance_criteria",
      "test_commands",
    ] as const) {
      const value = task[field];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new TaskManagerError("TASK_INVALID", `${field} must be an array of strings (may be empty)`);
      }
    }
    if (task.context !== undefined && typeof task.context !== "string") {
      throw new TaskManagerError("TASK_INVALID", "context must be a string when present");
    }
    if (task.timeout_ms !== undefined) {
      try {
        validateTaskTimeout(task.timeout_ms);
      } catch (error) {
        throw new TaskManagerError("TASK_INVALID", error instanceof Error ? error.message : String(error));
      }
    }
    if (typeof task.workspace !== "string" || task.workspace.trim().length === 0) {
      throw new TaskManagerError("TASK_INVALID", "workspace is required");
    }
    if (task.worktree_path !== undefined && (typeof task.worktree_path !== "string" || task.worktree_path.trim().length === 0)) {
      throw new TaskManagerError("TASK_INVALID", "worktree_path must be a non-empty absolute path when present");
    }
    if (task.model !== undefined && (
      typeof task.model !== "object" || task.model === null ||
      typeof task.model.provider_id !== "string" || task.model.provider_id.trim().length === 0 ||
      typeof task.model.model_id !== "string" || task.model.model_id.trim().length === 0 ||
      (task.model.reasoning_level !== undefined &&
        (typeof task.model.reasoning_level !== "string" || task.model.reasoning_level.trim().length === 0))
    )) {
      throw new TaskManagerError("TASK_INVALID", "model must include non-empty provider_id and model_id strings");
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#queuedOperations >= 32) return Promise.reject(new TaskManagerError("BRIDGE_BUSY", "Bridge operation queue is full; retry with the same task_id"));
    this.#queuedOperations += 1;
    let started = false;
    let expired = false;
    let rejectTimeout: ((error: Error) => void) | undefined;
    const timeout = setTimeout(() => {
      if (started) return;
      expired = true;
      this.#queuedOperations = Math.max(0, this.#queuedOperations - 1);
      rejectTimeout?.(new TaskManagerError("REQUEST_QUEUE_TIMEOUT", "Bridge operation did not start within 5 seconds; retry with the same task_id"));
    }, 5_000);
    const locked = async () => {
      if (expired) throw new TaskManagerError("REQUEST_QUEUE_TIMEOUT", "Bridge operation expired before it started");
      started = true;
      clearTimeout(timeout);
      this.#queuedOperations = Math.max(0, this.#queuedOperations - 1);
      try {
        return await withProcessLock(path.join(this.#store.tasksRoot, ".manager.lock"), operation, 5_000);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("timed out waiting for process lock:")) {
          throw new TaskManagerError("REQUEST_QUEUE_TIMEOUT", "Bridge operation did not acquire the shared scheduling lock within 5 seconds; retry with the same task_id");
        }
        throw error;
      }
    };
    const run = this.#mutex.then(locked, locked);
    const bounded = new Promise<T>((resolve, reject) => {
      rejectTimeout = reject;
      run.then(resolve, reject);
    });
    this.#mutex = run.catch(() => undefined);
    return bounded;
  }

  #safeStatus(taskId: string): ReturnType<TaskStore["readStatus"]> | null {
    try {
      const status = this.#store.readStatus(taskId);
      this.#store.readTask(taskId);
      this.#store.readWorkspaceRef(taskId);
      this.#store.readResult(taskId);
      this.#store.readAttemptMeta(taskId, status.attempt, "started.json");
      this.#store.readAttemptMeta(taskId, status.attempt, "continue.json");
      return status;
    } catch (error) {
      console.error(`Bridge skipped corrupt task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  const inside = (value: string): boolean => value === "" || (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`));
  return inside(relative) || inside(reverse);
}

/** Opaque MCP projection of the bounded-scan byte cursor (B1). */
function encodeScanCursor(cursor: EventsScanCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function buildInteractionAnswer(
  record: import("../interfaces.js").ZCodeInteractionRecord,
  input: ZCodeInteractionReplyInput,
): Record<string, unknown> {
  const params = record.params;
  if (record.method === "interaction/requestPermission") {
    if (input.decision !== "allow" && input.decision !== "deny") {
      throw new TaskManagerError("TASK_INVALID", "permission requests require decision allow or deny");
    }
    if (input.decision === "allow") {
      const options = Array.isArray(params.options) ? params.options : [];
      const canAllow = options.some((option) => {
        const item = asRecord(option);
        return typeof item.kind === "string" && item.kind.startsWith("allow");
      });
      if (!canAllow) throw new TaskManagerError("TASK_INVALID", "ZCode did not offer an allow option for this request");
    }
    return {
      decision: input.decision,
      ...(input.decision === "deny" ? { reason: boundedReason(input.reason) } : {}),
    };
  }

  if (input.decision !== "accept" && input.decision !== "decline") {
    throw new TaskManagerError("TASK_INVALID", "user input requests require decision accept or decline");
  }
  if (input.decision === "decline") return { action: "decline" };
  if (asRecord(params.schema).interaction === "plan_approval") {
    return { action: "accept", content: { answer_0: "approve" } };
  }

  const rawQuestions = Array.isArray(params.questions)
    ? params.questions
    : Array.isArray(asRecord(params.input).questions) ? asRecord(params.input).questions as unknown[] : [];
  const validQuestions = rawQuestions
    .map(asRecord)
    .filter((question) => typeof question.question === "string")
    .map((question) => question.question as string);
  if (!validQuestions.length) throw new TaskManagerError("TASK_INVALID", "ZCode request has no supported questions");
  const answers = input.answers ?? {};
  const answerKeys = Object.keys(answers);
  if (!answerKeys.length) throw new TaskManagerError("TASK_INVALID", "accepting an AskUserQuestion requires answers");
  if (answerKeys.some((question) => !validQuestions.includes(question))) {
    throw new TaskManagerError("TASK_INVALID", "answers must be keyed by the exact ZCode question text");
  }
  for (const [question, value] of Object.entries(answers)) {
    if (!value.trim() || value.length > 4_000) {
      throw new TaskManagerError("TASK_INVALID", `answer for '${question.slice(0, 80)}' must be non-empty and at most 4000 characters`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(answers), "utf8") > 16_000) {
    throw new TaskManagerError("TASK_INVALID", "combined ZCode answers exceed the 16 KB limit");
  }
  return { action: "accept", content: { answers } };
}

function boundedReason(reason: string | undefined): string {
  return (reason?.trim() || "the calling host declined this request").slice(0, 2_000);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
