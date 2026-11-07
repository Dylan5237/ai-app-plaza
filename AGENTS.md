# ai-app-plaza — 工程协作约定

## 工作方式

2026-11-02 用户明确要求停用 APO 机制，按直接的产品与工程协作方式推进。此决定替代本项目旧的 APO binding、Freeze / Exception / Phase Accept、Command Center 和对应 skill / playbook / wrapper 要求。

- 不再加载、调用或执行 `.agent-project-ops/` 及 `.agents/skills/` 中的 APO 流程，不自动恢复或升级 APO。
- 历史方法论快照、Issue、PR 和证据保留为历史资料；它们不构成新增工作或审批门禁。
- 按实际目标完成实现、代码审阅和必要验证；用源码、运行结果和用户反馈区分开发完成、合并、发布及验收。
- 默认中文。已明确授权的范围主动推进；重大范围变化或越界操作先说明并确认。
- 保留其他任务的工作树、未提交变更、业务数据和历史恢复材料。

## Git 与交付

- `origin` → `https://github.com/Dylan5237/ai-app-plaza` 为唯一写入权威；主题分支只推 `origin`，通过 PR 合入 `main`。
- 本项目没有配置投影或同事分享远端。新增或不明远端先核对用途，不绕过 GitHub 权威流程。
- 一项任务使用一个 `.worktrees/` 下的工作区；主工作区用于同步和控制，不混入本任务修改。
- `core.hooksPath=.githooks`。项目自有 pre-push 保留固定 authority URL、禁止直接推送/删除 main 和禁止非快进的检查，不依赖 APO。
- 提交使用 `type(scope): 中文标题`，每个提交对应一个独立逻辑改动，添加 `Co-Authored-By: Codex <noreply@openai.com>`。
- 推送前取得用户明确确认；已经确认的同一范围不重复询问。合并、正式发布和回退按准备好的具体候选确认。
- 不将本地实现或检查通过表述为已合并、已部署或用户验收完成。
- Bugbot 已停用，不发送 `bugbot run`，也不等待其结果。

## 产品与代码

- 产品范围与边界见 `docs/product/mainflow-scope.md`、`docs/product/capability-boundaries.md`；历史 Mock 不进入真实目录。
- 前端在 `src/`，服务在 `server/`，生成脚本在 `scripts/`；不要直接维护生成的 `public/portal.html`。
- Node.js 22.16+、Python 3.10+。按变更影响执行类型、单元、构建和相关浏览器检查；真实 GitLab / Host 结果与合成测试分开记录。
- `archive/`、`artifacts/` 为本地历史和证据，不提交；不提交凭据、机器配置、真实身份或私钥。
- 广场保持匿名目录，不建设账号体系。伏羲入口只做固定入口和受控身份交接，凭据不进入广场、URL、日志或新增持久化。
- 用户通过浏览器查看原型，对话中给简洁说明或链接，不嵌入原型页面。

## 二阶段 UI/UX 实现

- 二阶段每一段均按已确认的 `docs/design/plaza-ui-ux.md` 实现与审查；复用共同设计变量、控件、卡片、状态反馈与动效，不按模块另建视觉规范。
- 后续能力只在接通真实服务后进入正式页面，交互原型示例不作为已实现业务状态。
