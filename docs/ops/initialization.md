# 项目初始化记录

日期：2026-10-10。此文件是本地初始化证据；GitHub Command Center 建立后，阶段状态以该 Issue 为准。

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

## 待完成的远端初始化

用户约定推送前须明确确认；当前尚未推送代码，也未创建远端控制面。已准备：

1. 首次推送：`git push -u origin main`。执行前重新确认远端仍为空，禁止覆盖已有引用。
2. 按 APO 字典创建标签，创建 Command Center 与首个 backlog Phase，并互相补充实际链接。
3. 按实际 Command Center 编号准备 `Dylan5237/agent-project-ops` 的 `fleet/REGISTRY.md` 单行登记 PR。仅提出登记，不合并该 PR。
4. 核对 Fleet 镜像；无法访问镜像时，在 Command Center 写明 `BLOCKED:`，不声称已纳入晨报扫描。

可审阅正文：[Command Center 草稿](github-command-center.md)、[首个 Phase 草稿](github-phase-1.md)、[Fleet 登记草稿](fleet-registration.md)。首个 Phase 为提案，不因创建 Issue 自动冻结或开始实现。
