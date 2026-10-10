# [Phase 1] 确认应用登记的最小契约

状态：`type:phase`、`status:backlog`，待 `@Dylan5237` Freeze。此文件为首个 Phase 提案，不授权开始落地开发。

## Core problem

明确项目作者的 Agent 需要提交什么最小信息，才能让应用广场完成发现、使用与分享，且不与现有 17 项 Mock 绑定。

## NON-GOALS

不开发后端、不接入真实 GitLab、不实现安装器或部署系统、不新增移动端、不重做已确认的原型视觉。

## Owner

Implementer：当前 Codex Agent（propose）；Disposer：`@Dylan5237`。

## Freeze contract / 待冻结

### In scope

- 从现有原型归纳最小应用登记信息，区分必填、可选及 GitLab 派生字段。
- 约定平台链接与 Agent 接入提示词两类使用入口。
- 明确 AI 生成草稿、作者确认、源码/版本发布、广场收录的责任及结果反馈边界。
- 用互不依赖的示例验证通用性，并说明真实服务上线仍缺少的环境配置。

### Interfaces / data contracts

输出应用登记契约、GitLab 字段来源映射和发布/使用状态说明。字段格式与同步机制在阶段内提出、由 Disposer 评审，不预设当前 JSON fixture 为正式接口。

### Acceptance tests

1. 原型中展示的名称、描述、作者标签、版本、日期、使用说明和入口均能找到明确来源；作者无须手填表单。
2. 平台应用、Skill、MCP、需本地部署的应用，均可用同一最小契约表达，不要求形态专用的目录页。
3. 能区分源码上传、版本发布、广场收录和使用者实际接入结果；失败恢复不把未执行的安装标成成功。
4. 文档明确权限、未确认信息和不属于广场的职责，并由 Disposer 决定 Accept 或 Return。

### Risks

GitLab 实例、身份权限和真实 Agent 服务尚未核对；不能把原型演示当作接口可用证据，也不能以 Mock 字段倒推正式实现。

## Freeze / Verification log

- [ ] 合同经 Disposer 审阅
- [ ] Disposer 在 Issue 留下带日期的 `FREEZE ACK`
- [ ] Freeze 后才开 `feat/` / `fix/` 实现分支
- [ ] 每次阶段状态变化同步更新 Command Center §1 与标签
- [ ] 验证证据可复验
- [ ] Disposer 明确 `PHASE ACCEPT` / `PHASE RETURN`

当前没有 FREEZE ACK、实现分支或阶段验收。本次已授权的仓库初始化与历史迁移不代替本阶段工作。
