# ADR-010：Claude Code 作为宿主的增量接入

> Status: DECISION / Implemented proposal for maintainer review
> Date: 2026-10-22

## Context

MCP 服务本身与宿主无关：工具描述已写作 "the calling host"。本机 Claude Code 通过用户级 `mcpServers` 直接运行 `plugins/codex-zcode-bridge/dist/bridge.mjs`，并与 Codex 共用 `runtime-config.json` 指定的数据根。缺口在宿主侧：

- Skill 只把 Codex 写成宿主，包括 `create_goal`、“Codex 项目根目录”和 token 行。Claude Code 没有 Goal 工具，照抄会误报“已启用持久续行”。
- Claude Code 的长等待机制是后台命令退出后通知宿主。用 `zcode_events` 的 `wait_ms`（上限 25 秒）等待，宿主每轮都要重复调用工具，auto mode 下每次调用还要经过权限分类。观察到的后果是：长任务的宿主等待被拆成大量短调用。

## Decision

1. 新增只读等待器 `plugins/codex-zcode-bridge/scripts/wait-task.mjs`，只依赖 Node 内置模块，从已安装插件直接运行。
   - 读取：`status.json`、`events.jsonl`（按字节游标增量读取）、`events.gen`。
   - 退出时机：`after_seq` 之后出现尚未答复的 `interaction_requested`（按去掉 `<n>:` 前缀的 request_id，与 `interaction_reply_submitted`、`interaction_replied`、`interaction_request_undeliverable`、`interaction_request_oversized` 配对）；或任务进入终态；或到达期限。
   - 输出 `zcode-bridge/wait-task-v1` JSON。退出码：0 表示需要宿主处理，3 表示超时，2 表示参数或读取错误。
   - 代际标记变化或文件变短时从头重扫，不信任旧游标。
2. 等待器按 ADR-004 只是观察，不属于控制面。它不写任何文件，不改变任务状态，也不替代 `zcode_events`。宿主不得仅凭它的输出批准交互或判定完成；`preview: true` 时输出的只是预览，仍须读取 `full_request`。
3. 数据根复刻插件模式：`runtime-config.json` 中的 `ZCODE_BRIDGE_DATA_DIR` 优先于环境变量，空值或 null 视为清除；未设时取 `~/.codex/codex-zcode-bridge`；`--data-dir` 优先于以上全部。legacy 设置目录不在复刻范围内，这种情况用 `--data-dir`。
4. Skill 改为宿主中立，新增“Claude Code 宿主”一节，写明等待器用法、权限与 auto mode 的边界、token 行写法和项目指令加载方式。Codex 的 Goal 规则保持不变。
5. 不改 MCP 工具名、schema、任务状态语义和隐私边界，不新增运行时依赖。本次不新增 `.claude-plugin/` 清单：现有 `hooks/hooks.json` 与 `.mcp.json` 按 Codex 约定编写（`${PLUGIN_ROOT}`、相对 `cwd`），在 Claude Code 插件加载实测前，不声明 Bridge 可作为 Claude Code 插件安装。

## Consequences

- 等待器依赖任务存储的文件布局：原子替换的 `status.json`、追加写入的 `events.jsonl` 和一次性生成的 `events.gen`。布局变化时必须同步修改等待器及其测试。
- 等待器只报告 `after_seq` 之后的交互。宿主须传入最近一次读到的游标；早于游标仍未答复的请求，应通过 `zcode_events` 处理。
- 验证范围：`test/wait-task.test.ts` 覆盖终态、交互配对与游标过滤、预览引用、超时、追加与半行、代际重写、数据根优先级、参数拒绝，以及“不写文件”的快照核对；`validate:plugin` 检查文件存在，且只导入 `node:` 内置模块。Claude Code 后台通知的真实链路只在本机 RecShop 任务中观察过，未做跨版本验证。
