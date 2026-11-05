// stdio MCP server factory. V0.1 task lifecycle tools remain compatible;
// MVP 0.3 adds the optional model selector, the calling host-selected execution worktree and progress
// events. All tools use strict snake_case
// schemas, return readable text plus structured content, and map stable
// TaskManagerError codes onto MCP tool-error results. The TaskManager is
// injected so tests can drive the server with a fake and no real workers.
//
// Built with the official MCP TypeScript SDK (McpServer / registerTool);
// the SDK owns all JSON-RPC framing — this module never writes to stdout.
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type {
  ContinueTaskInput,
  ProgressTaskManager,
  TaskManager,
  TaskPackage,
  TaskReceipt,
  TaskResult,
  TaskStatusRecord,
  TaskFeedbackSnapshotV01,
  ZCodeInteractionReplyInput,
} from "../interfaces.js";
import { TaskManagerError } from "../manager/errors.js";
import {
  taskReceiptSchema,
  taskResultSchema,
  taskStatusRecordSchema,
  taskIdOnlyInputSchema,
  zcodeContinueInputSchema,
  zcodeEventsInputSchema,
  zcodeTaskInputSchema,
  zcodeInteractionReplyInputSchema,
  taskProgressPageSchema,
  doctorReportSchema,
  zcodeModelCatalogInputSchema,
  zcodeDefaultModelInputSchema,
  modelCatalogSchema,
  defaultModelSchema,
  taskFeedbackSnapshotV01Schema,
  zcodeFeedbackInputSchema,
} from "./schemas.js";
import type { DoctorReport } from "../runtime/doctor.js";
import { BridgeError } from "../runtime/errors.js";
import type { ZCodeModelSettings } from "../runtime/model-settings.js";
import { registerLedgerTools } from "../ledger/mcp.js";
import { renderTaskFeedback } from "../feedback/renderer.js";

export const SERVER_NAME = "codex-zcode-bridge";
export const SERVER_VERSION = "1.2.7"; // x-release-please-version

export interface BridgeServerOptions {
  taskManager: TaskManager & Partial<Pick<ProgressTaskManager, "getEvents" | "getFeedback" | "replyToInteraction">>;
  doctor?: () => Promise<DoctorReport>;
  modelSettings?: Pick<ZCodeModelSettings, "listModels" | "getDefaultModel" | "setDefaultModel" | "clearDefaultModel">;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  enableExperiments?: boolean;
  /** Opt-in project task ledger (C1-C3). Absent = disabled: the frozen core
   * tools behave exactly as before and no ledger data is ever created. */
  ledger?: import("../ledger/mcp.js").LedgerToolOptions;
}

const EXECUTION_NOT_VERDICT =
  "Results describe Bridge/ZCode execution only: status 'completed' means the invocation and report normalization finished, NOT that the calling host accepted the work. the calling host must independently review the workspace diff and checks before deciding PASS.";

function okResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function errorResult(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
  };
}

function feedbackResult(snapshot: TaskFeedbackSnapshotV01): CallToolResult {
  return {
    content: [{ type: "text", text: renderTaskFeedback(snapshot) }],
    structuredContent: snapshot as unknown as Record<string, unknown>,
  };
}

async function runTool<T>(operation: () => Promise<T>): Promise<CallToolResult> {
  try {
    const data = await operation();
    return okResult(data as unknown as Record<string, unknown>);
  } catch (error) {
    if (error instanceof TaskManagerError) {
      return errorResult(error.code, error.message);
    }
    if (error instanceof BridgeError) return errorResult(error.code.toUpperCase(), error.message);
    throw error;
  }
}

export function createBridgeServer(options: BridgeServerOptions): McpServer {
  const manager = options.taskManager;
  const serverInfo = options.serverInfo ?? { name: SERVER_NAME, version: SERVER_VERSION };
  const server = new McpServer(serverInfo, options.instructions ? { instructions: options.instructions } : undefined);

  server.registerTool(
    "zcode_doctor",
    {
      title: "Check ZCode Bridge setup",
      description: "Run read-only checks for Bridge prerequisites, ZCode runtime/provider configuration, execution mode, task storage, and Desktop task-index availability. It does not start a ZCode session. App-server model availability and real permission approval are reported as unverified until a task runs.",
      inputSchema: {},
      outputSchema: doctorReportSchema,
    },
    async () => {
      if (!options.doctor) return errorResult("DOCTOR_UNAVAILABLE", "Bridge doctor is unavailable in this server instance");
      return runTool(() => options.doctor!());
    },
  );

  server.registerTool(
    "zcode_model_catalog",
    {
      title: "Read available ZCode models",
      description: "Read models and reasoning levels for this workspace. The Bridge caches the catalog for 24 hours, refreshes when provider settings change or the cache expires, and re-reads provider config before retrying a failed refresh. A cache response has current_model=null; use provider_id/model_id from models in zcode_task.model.",
      inputSchema: zcodeModelCatalogInputSchema,
      outputSchema: modelCatalogSchema,
    },
    async (args: { workspace: string }) => {
      if (!options.modelSettings) return errorResult("MODEL_SETTINGS_UNAVAILABLE", "model settings are unavailable in this server instance");
      return runTool(() => options.modelSettings!.listModels(args.workspace));
    },
  );

  server.registerTool(
    "zcode_default_model",
    {
      title: "Read the Bridge default model",
      description: "Read the provider, model, and optional reasoning level used when zcode_task has no model override.",
      inputSchema: {},
      outputSchema: defaultModelSchema,
    },
    async () => {
      if (!options.modelSettings) return errorResult("MODEL_SETTINGS_UNAVAILABLE", "model settings are unavailable in this server instance");
      return runTool(() => options.modelSettings!.getDefaultModel());
    },
  );

  server.registerTool(
    "zcode_set_default_model",
    {
      title: "Set the Bridge default model",
      description: "Persist a default provider/model selection for future tasks that omit zcode_task.model. Use IDs from zcode_model_catalog or the configured ZCode provider/model rules; the app-server validates the selection when a task starts. An optional reasoning_level applies to the configured default model; a per-task model selection can still override it.",
      inputSchema: zcodeDefaultModelInputSchema,
      outputSchema: defaultModelSchema,
    },
    async (args: { provider_id: string; model_id: string; reasoning_level?: string }) => {
      if (!options.modelSettings) return errorResult("MODEL_SETTINGS_UNAVAILABLE", "model settings are unavailable in this server instance");
      return runTool(() => options.modelSettings!.setDefaultModel(args));
    },
  );

  server.registerTool(
    "zcode_clear_default_model",
    {
      title: "Clear the Bridge default model",
      description: "Remove the Bridge default model so future tasks without zcode_task.model use the ZCode session default.",
      inputSchema: {},
      outputSchema: defaultModelSchema,
    },
    async () => {
      if (!options.modelSettings) return errorResult("MODEL_SETTINGS_UNAVAILABLE", "model settings are unavailable in this server instance");
      return runTool(() => options.modelSettings!.clearDefaultModel());
    },
  );

  server.registerTool(
    "zcode_task",
    {
      title: "Submit one ZCode coding task",
      description: `Create a bounded coding task for the local ZCode subordinate agent. workspace is the the calling host project root and determines the ZCode Desktop project identity. the calling host decides whether to create a worktree; if it does, pass its existing absolute directory as optional worktree_path. The Bridge never creates, selects, or removes a worktree. Without worktree_path, ZCode runs directly in workspace. Optional model selects a ZCode provider_id/model_id for this session without changing the project default. Returns a TaskReceipt; the task runs asynchronously in a detached worker. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: zcodeTaskInputSchema,
      outputSchema: taskReceiptSchema,
    },
    async (args: TaskPackage) => runTool(() => manager.createTask(args)),
  );

  server.registerTool(
    "zcode_status",
    {
      title: "Read ZCode task execution status",
      description: `Read the execution status record for one task. This is execution status only and never contains a PASS/FAIL code-review judgment. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: taskIdOnlyInputSchema,
      outputSchema: taskStatusRecordSchema,
    },
    async (args: { task_id: string }) => runTool(() => manager.getStatus(args.task_id)),
  );

  server.registerTool(
    "zcode_feedback",
    {
      title: "Read concise ZCode task feedback",
      description: `Read a provenance-aware v0.1 snapshot for one task attempt. Bridge status, runtime-reported model/tool observations, and Agent-reported result claims remain distinct. phase/progress stay null; interaction remains not_observed without reliable current evidence. This snapshot does not replace zcode_events and does not verify or accept the result. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: zcodeFeedbackInputSchema,
      outputSchema: taskFeedbackSnapshotV01Schema,
    },
    async (args: { task_id: string }) => {
      const getFeedback = manager.getFeedback;
      if (!getFeedback) return errorResult("FEEDBACK_UNAVAILABLE", "task manager does not provide feedback snapshots");
      try {
        const snapshot = await getFeedback.call(manager, args.task_id);
        return feedbackResult(snapshot);
      } catch (error) {
        if (error instanceof TaskManagerError) return errorResult(error.code, error.message);
        if (error instanceof BridgeError) return errorResult(error.code.toUpperCase(), error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "zcode_events",
    {
      title: "Read live ZCode execution events",
      description: "Read persisted progress events for a task. Set view to summary to merge adjacent model text chunks; raw is the default. next_seq advances across all scanned events, including merged chunks. Immediately after submission, report the project path, effective execution path (and worktree path when supplied), and queued/running state from the first events. Keep polling until turn_started or startup failure; before longer monitoring, report the ZCode session, runtime-reported selected model, runtime-reported reasoning level when present, and execution mode. Set after_seq to the last next_seq returned and wait_ms up to 25000. Hidden reasoning is excluded. interaction_requested events include bounded tool/request details needed for a deliberate permission or input decision.",
      inputSchema: zcodeEventsInputSchema,
      outputSchema: taskProgressPageSchema,
    },
      async (args: { task_id: string; after_seq?: number; limit?: number; wait_ms?: number; view?: "raw" | "summary"; scan_cursor?: string; max_bytes?: number }) => {
        if (!manager.getEvents) return errorResult("EVENTS_UNAVAILABLE", "task manager does not provide progress events");
        return runTool(() => manager.getEvents!(args));
      },
  );

  server.registerTool(
    "zcode_interaction_reply",
    {
      title: "Reply to a ZCode permission or input request",
      description: "Reply to a pending ZCode permission or user-input request surfaced by zcode_events. For permission requests, use allow only when the user explicitly authorized the requested action; otherwise deny or ask the user. Do not infer permission from task instructions, worktree use, or ZCode mode. For user-input requests, answer only from known facts or the user's explicit direction. This tool does not approve the task result.",
      inputSchema: zcodeInteractionReplyInputSchema,
    },
    async (args: ZCodeInteractionReplyInput) => {
      if (!manager.replyToInteraction) return errorResult("INTERACTIONS_UNAVAILABLE", "task manager does not provide ZCode interaction replies");
      return runTool(() => manager.replyToInteraction!(args));
    },
  );

  server.registerTool(
    "zcode_result",
    {
      title: "Read the terminal ZCode task result",
      description: `Read the persisted TaskResult for a finished task. Returns TASK_NOT_FINISHED before a terminal state. 'completed' is not a the calling host PASS: files_changed, tests, and decisions are normalized claims from the subordinate report and must be verified independently. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: taskIdOnlyInputSchema,
      outputSchema: taskResultSchema,
    },
    async (args: { task_id: string }) => runTool(() => manager.getResult(args.task_id)),
  );

  server.registerTool(
    "zcode_continue",
    {
      title: "Continue a ZCode task with master feedback",
      description: `Continue a finished task with master feedback: reuses the task ID and workspace, increments the attempt, and preserves prior evidence. Allowed from completed, failed, cancelled, or waiting_for_master. Supply a stable operation_id when retrying after a lost response; the same ID and input will not create another attempt. A decision flagged by ZCode is never auto-approved; the calling host must provide the follow-up instruction. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: zcodeContinueInputSchema,
      outputSchema: taskReceiptSchema,
    },
    async (args: ContinueTaskInput) => runTool(() => manager.continueTask(args)),
  );

  server.registerTool(
    "zcode_cancel",
    {
      title: "Cancel a queued or running ZCode task",
      description: `Cancel a queued or running task. Running cancellation returns only after the worker process tree termination is confirmed. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: taskIdOnlyInputSchema,
      outputSchema: taskStatusRecordSchema,
    },
    async (args: { task_id: string }) => runTool(() => manager.cancelTask(args.task_id)),
  );

  // Opt-in project task ledger tools (C1-C3); never registered by default.
  if (options.ledger) {
    registerLedgerTools(server, options.ledger);
  }

  // Temporary experiment tool: verify whether the calling host surfaces MCP progress notifications.
  if (options.enableExperiments) server.registerTool(
    "zcode_progress_probe",
    {
      title: "[Experiment] Check MCP progress display",
      description: "Temporary read-only experiment. Sends three MCP progress notifications over three seconds to test whether the calling host displays server progress while this tool runs. Does not start or modify a ZCode task.",
    },
    async (ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let notificationsSent = 0;

      if (progressToken !== undefined) {
        for (let progress = 1; progress <= 3; progress += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              total: 3,
              message: `Experiment progress ${progress}/3`,
            },
          });
          notificationsSent += 1;
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            experiment: "mcp-progress-display",
            progress_token_received: progressToken !== undefined,
            notifications_sent: notificationsSent,
            note: "The tool result confirms server delivery only; check whether the calling host displayed progress while it was running.",
          }, null, 2),
        }],
      };
    },
  );

  return server;
}

// Re-exported for consumers that want the receipt/result shapes.
export type { TaskReceipt, TaskResult, TaskStatusRecord };
