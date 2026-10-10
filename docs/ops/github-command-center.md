# [Command Center] AI应用广场

此文件为待发布正文；发布时以实际 Issue / PR 链接替换明确的待创建项。

## 1. One-glance / 一眼状态

| 字段 | 状态 |
| --- | --- |
| Current phase | Phase 1：确认应用登记的最小契约（Issue 待创建） |
| Status word | backlog |
| Last closed phase | 无 |
| Open gates | Phase 尚未 Freeze；Fleet 登记 PR 与镜像待确认 |
| Single Next Action | @Dylan5237 审阅首个 Phase 合同并决定是否 Freeze |

Updated: 2026-10-10。初始化和原型迁移不代表产品阶段通过。每次 gate / 状态 / Freeze / verification / Accept 变化，同步更新本节与 Phase 标签。

## 项目与方法论

AI应用广场面向应用使用者和成果分享者，以能力发现、平台访问及 Agent 提示词接入/发布为主线。当前为桌面 Mock 原型，无真实 GitLab、发布后端或安装执行。

- Methodology：`https://github.com/Dylan5237/agent-project-ops`
- PIN SHA：`21983f17eccae3beb844fa0fec3f7e7e1e10746e`，ref `main`，2026-10-10。
- Root binding files：已生成。Chat ≠ state；Agent proposes / control plane disposes；merge ≠ Phase PASS。

## Disposer 与 Roster

| 角色 | 身份 | 权限 |
| --- | --- | --- |
| Disposer | @Dylan5237 | FREEZE ACK / PHASE ACCEPT / EXCEPTION ACCEPT |
| Implementer / Project-ops | 当前 Codex Agent | 提案、实现和证据；不得自验收 |
| Reviewer | 按任务指派的审查 Agent | 独立复核，不替代 Disposer |

Agent 使用的 GitHub 身份也是 `Dylan5237`，不能将 GitHub 账号检查描述为区分人类与 Agent 的审批边界。

## Git authority / remotes

- 默认分支 `main`；唯一写入权威 `origin=https://github.com/Dylan5237/ai-app-plaza.git`。
- Projection、export、share-export：均为 `(none)`，与 `.agent-project-ops/remotes` 一致。未知远端先分类，禁止回退写入另一远端。
- 后续任务在 `.worktrees/` 使用独立分支；分支格式 `feat|fix|docs|evidence/{issue}-{slug}`。
- 初始化首次空仓 seed 后，禁止直接推送默认分支；后续通过 PR。推送按用户约定先确认；禁止 force、删除或绕过 hooks。
- 本机 `core.hooksPath=.githooks`。新 clone 需安装本地 hook。

## Protection capability

**C**：私有仓库 rulesets API 返回 403，当前计划不支持；服务端 PR 限制、强推/删除保护未验证。使用 hooks 与 PR 工作纪律继续，不能宣称 A/B 或独立人类评审门禁。

## Phase index

| Phase | 核心问题 | 状态 | 结果 |
| --- | --- | --- | --- |
| 待创建的 Phase 1 | 项目 Agent 应提交什么最小信息，才能满足应用发现、使用与分享 | backlog | 未 Freeze，未实施 |

## Fleet 与 Open gates

- Fleet SoT：`Dylan5237/agent-project-ops/fleet/REGISTRY.md`，登记 PR 待创建并回填链接。
- 镜像：`/home/box/agent-data/fleet-morning-digest/REGISTRY.md`，当前没有确认访问或同步证据。
- 若镜像不可访问：`BLOCKED: Fleet 镜像未核验，登记 PR 的创建不代表已纳入晨报扫描。`
- 不自行合并 Fleet PR，不因创建控制面或通过本地测试宣布产品验收。
