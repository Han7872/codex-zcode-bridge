# 决策记录 / Decisions

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-10-08

本目录保存已批准的架构决策和带日期的决策记录。决策回答"为什么这样定"，当前实现仍以 `ARCHITECTURE.md` / `INTERFACES.md` 为准。

## 现有记录

| 文档 | 状态 | 说明 |
|---|---|---|
| [roadmap-decisions-2026-09-27.md](roadmap-decisions-2026-09-27.md) | DECISION | 2026-09-27 的路线图与决策讨论。仍然成立的结论需要提炼进 `ARCHITECTURE.md` / `INTERFACES.md`；本文本身不是当前事实来源。 |
| [reliability-repair-plan-v2-2026-10-03.md](reliability-repair-plan-v2-2026-10-03.md) | DECISION | Bridge 可靠性修复计划。A/B 主要改动已实现；C/D 与宿主启动核验仍有未完成项。 |
| [ADR-005](ADR-005-long-session-reliability.md) | Accepted | 长会话 Windows 清理验证、原子锁释放、报告续作与 catalog provider 兼容；历史记录保持不变。 |
| [ADR-006](ADR-006-provider-quota-failure-diagnostics.md) | Accepted | 仅对白名单 provider 错误字段分类明确的用量额度耗尽；不公开原始 RPC 错误。 |

## ADR 索引

| ADR | 状态 | 主题 |
|---|---|---|
| [ADR-001](ADR-001-appserver-as-production-execution-path.md) | Accepted | 生产执行路径使用 ZCode app-server |
| [ADR-002](ADR-002-manager-owns-task-lifecycle.md) | Accepted | Manager 独占任务生命周期，worker 通过 attempt claim 入场 |
| [ADR-003](ADR-003-execution-directory-prepared-by-host.md) | Accepted | 执行目录由调用宿主准备，Bridge 不创建也不删除 |
| [ADR-004](ADR-004-separate-control-state-and-observation.md) | Accepted | 分离运行时控制、权威状态与补充观察；Desktop 索引是登记过的集成例外 |

ADR-001 到 ADR-003 只搬运权威文档里已经写明的结论。ADR-004 原先没有明文记录，只有 bridge 之外的设计讨论，因此先以 Proposed 记录；2026-10-07 由 Master 明确按"强化版 A"接受，原则冻结，未因此增加任何读取 ZCode 本地材料的代码。

## 本分支待维护者审查的实现

- [ADR-007](ADR-007-browser-host-rpc.md)：可选headless浏览器宿主；默认关闭，限定版本实测。
- [ADR-008](ADR-008-session-frames-and-large-interactions.md)：会话帧与大审批输入；独立资源边界及可恢复错误。
- [ADR-009](ADR-009-windows-identity-bound-tree-termination.md)：Windows 进程树身份绑定归属与终止；句柄事务、零容差区间归属、单调失败锁存与有界传输。
- [ADR-010](ADR-010-claude-code-host.md)：Claude Code 作为宿主的增量接入；只读任务等待器与宿主中立 Skill，MCP 合同不变。

## 命名

新决策使用 `ADR-NNN-<slug>.md`，正文至少包含 Status、Date、Context、Decision、Rationale、Consequences。
