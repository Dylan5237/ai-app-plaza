# 项目初始化记录

日期：2026-10-10。此文件记录初始化事实；当前状态以 [Command Center #1](https://github.com/Dylan5237/ai-app-plaza/issues/1) 为准。

## 已核对的起点

- 目标目录初始为空；GitHub `Dylan5237/ai-app-plaza` 已存在，为私有空仓库，无初始引用和 Issue。
- 拍板人：`@Dylan5237`。当前 Agent 使用同一 GitHub 身份，不构成独立人类审批边界。
- 官方 `bootstrap-project.sh` 完成 dry-run 后，以 `--skip-github --no-projection` 生成本地骨架，随后配置已存在的 `origin`。
- 方法论固定 SHA：`21983f17eccae3beb844fa0fec3f7e7e1e10746e`。
- `core.hooksPath=.githooks`；默认分支 `main`。无 projection、export 或 share-export 远端。
- GitHub rulesets API 返回 403，提示当前私有仓库计划不支持该功能。因此保护能力记录为 **C**；服务端 PR、禁止强推及删除保护均未验证，不能宣称 A/B。

## 迁入范围

- 迁入最近一版 Vue 承载工程、原型模板、完整 Mock 数据及生成脚本。
- 迁入并改为仓库相对路径的应用和发布流程检查脚本；Playwright 由项目依赖管理。
- 旧任务的 `work/` 和 `outputs/` 整体移动到 `archive/2026-10-09-prototype/`，保留多轮历史交付、截图、运行记录、原始资料和依赖；归档不入 Git。
- 文件清单、大小与逐文件 SHA-256 核对保存在本地 `artifacts/migration-manifest.json`。
- 旧对话预览副本保留为历史引用，新工程的构建不读取或写入该副本。

## 本地验证

验证结论见同目录下 `migration-verification.md`。本次仅建立可复现原型基线，不新增产品能力，不代表 Phase Freeze、PHASE ACCEPT 或生产验收。

## 远端初始化结果

用户明确确认后，已完成首次空仓推送并读回远端：`main=b64d06abf14b992c5b011b9018bd7557dbc31eff`，包含治理绑定与原型迁移两项提交。已创建 APO 标签、[Command Center #1](https://github.com/Dylan5237/ai-app-plaza/issues/1) 与[首个待冻结 Phase #2](https://github.com/Dylan5237/ai-app-plaza/issues/2)。

[Fleet 登记 PR #63](https://github.com/Dylan5237/agent-project-ops/pull/63) 仅新增本项目一行，已关联业务控制面，保持 OPEN 待审核。晨报运行镜像未核验，控制面已记录 `BLOCKED:`；当前不能声称已纳入晨报扫描。

2026-10-10 进一步核对固定版本 [ADR 0002](https://github.com/Dylan5237/agent-project-ops/blob/21983f17eccae3beb844fa0fec3f7e7e1e10746e/docs/adr/0002-canonical-fleet-index.md) 的具体口径：登记步骤允许已打开的 PR 关联业务控制面，无法核验镜像时记录缺口。该条件已满足。此前将镜像核验列为需求提案整理的阻塞条件过严，现予修正；仓库初始化与登记提案已经就绪，晨报运行接入继续独立跟踪。

用户授权初始化后整理需求文档，现由 [Docs #3](https://github.com/Dylan5237/ai-app-plaza/issues/3) 跟踪[需求草稿](../product/requirements.md)。此项是提案准备，不实施功能，不替 Disposer Freeze 或 Accept，Phase #2 继续保持 backlog / freeze:pending。

### 需求方向确认记录（2026-10-10）

用户确认在 Docs #3 的 v0.2 需求提案中采纳本轮方向：首期只面向一个约定的内部受众，广场使用公司现有统一身份（实际身份源待核验），作者 Agent 以 GitLab 项目、固定 commit 和 manifest 路径提交资料定位，由广场生成只读预览，作者确认分享受众和内容后收录。详细规则见[需求说明](../product/requirements.md)。

此确认用于更新需求提案，不代表公司身份或 GitLab 环境已验证，不构成 Phase Freeze、Phase Accept 或功能已实现；Phase #2 继续保持 backlog / freeze:pending。

同目录的 [Command Center 草稿](github-command-center.md)、[首个 Phase 草稿](github-phase-1.md)、[Fleet 登记草稿](fleet-registration.md) 保留为初始化时的提案快照；实际编号、状态与最新正文以链接的 GitHub Issue / PR 为准。
