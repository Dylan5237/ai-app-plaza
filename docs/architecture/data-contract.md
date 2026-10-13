# 应用资料与收录契约

版本：0.2 · 2026-10-10。依据[已确认决策](decisions-2026-10-10.md)，配套[架构方案](architecture.md)。以下为待实现的技术契约，不是已可调用 API；开发合同仍需冻结。

## 1. 作者交付内容

Agent 在 GitLab 项目中维护 ai-app.json 与明确可共享的 Markdown。作者通过对话调整资料，无须填表。广场只接收项目、固定 commit 和资料路径等定位，自己从 GitLab 读取并生成预览，不接收待上传文件副本。

| 内容 | 最小要求 |
| --- | --- |
| ai-app.json | 项目名称、能力、作者标签、维护者、说明引用和入口 |
| 共享说明 | 适用场景、准备条件、步骤、示例、限制与求助方式；可以仅一个 Markdown 文件 |
| Agent 接入说明 | 仅 Agent 入口需要；固定版本获取、环境核对、授权渠道、操作、验证及恢复 |
| 固定 commit | 必需；tag 和 Release 均可选，已有版本可直接登记 |
| 下载产物 | 适用时声明分发 URL 和 SHA-256；用户 Agent 下载后核验，广场不代理下载 |

默认根目录 ai-app.json，一库多应用可以显式指定 .ai-apps/<appKey>/ai-app.json，不需要专门目录页或自动发现机制。所有文档路径相对仓库根。

## 2. 资料字段

[JSON Schema](app-manifest.schema.json)限定结构；大小和数量为接口保护建议，不是新增业务能力。

| 字段 | 作用 |
| --- | --- |
| schemaVersion / appKey | 协议版本与项目内稳定应用标识，改名不变 |
| name / summary | 项目名称、一句话能力说明 |
| projectVersion | 可选的项目正式版本声明；没有时使用核验 tag 或快照短 SHA，不强迫项目创建版本 |
| tags / maintainers | 作者自定义标签、GitLab 联系人；允许无标签，联系人不授予发布权限 |
| capabilities / examples | 任务、输入、输出、示例，服务搜索与使用判断 |
| requirements / limitations | 前置条件和边界；未知不能伪装成无限制 |
| docs.readme / docs.usage | 明确选择的共享说明，可指同一个专用文件；不强制公开根 README |
| entries / primaryEntry | web 或 agent 入口及默认入口，允许同一应用两者兼有 |

web 包含 id、kind、label、url。agent 包含 id、kind、label、instructionsPath、compatibility，可选 artifacts(url、sha256)。申请指引放在说明中，不新增审批实体或第三类主按钮。Skill 保留原有 SKILL.md，接入说明引用它；不复制一套 Skill 格式。

instance/project ID、commit、可选 tag、卡片日期、受众与收录结果由 GitLab 和广场记录提供，不要求作者在 manifest 手填。projectVersion 是作者维护的版本声明，不能证明平台运行版本；相同项目版本允许多份资料快照。缺少正式版本不报错。

## 3. 共享边界与校验

首期提交候选和确认时均通过 GitLab 项目 API 核验发布者当前有效 Maintainer/Owner 权限；组织指定负责人的例外须先接入现有可核验授权来源，不能由 manifest 自报。发布者显式确认 manifest、指定 Markdown、接入说明和产物声明向唯一首期内部受众展示。共享清单不自动包含整个仓库；目录查询不要求读者具备 GitLab 账号或源码权限。

1. 结构：UTF-8 JSON，拒绝重复键和未知协议版本；启用 Schema format 校验。建议 manifest 不超过 64 KiB，所有引用 Markdown 总计不超过 512 KiB。
2. 语义：非空白字段、唯一入口 ID、有效主入口、标签规范化去重；路径不得含绝对路径、反斜杠、空段、. / .. 或 URL。只读固定 commit 的普通 UTF-8 文件，不跟随符号链接、子模块或 LFS 指针。URL 不得包含凭据，分发来源符合部署规则。
3. 来源：当前作者项目权限、稳定标识、完整 commit、所有指定文件原始字节摘要；提供 tag 时核验它与 commit 对应。Agent 报告不是来源证据；说明与结构化字段的显式冲突须修正。
4. 展示：预览和详情共用安全 Markdown 渲染，不执行脚本或任意 HTML。不递归抓取图片/附件；相对链接指向原来源并保留其权限要求，不借广场源连接下载。共享文件外的内容不能经接口取得。

结构化字段只读 manifest，不从任意 README 段落推测。自然语言是否准确由 Agent 和作者审阅，服务端不声称能发现所有语义冲突。摘要基于原始字节；包摘要比对仅证明声明匹配，不能宣称包安全或已安装。

## 4. 候选、确认与接口

| 对象 | 必要信息与规则 |
| --- | --- |
| 候选请求 | projectId、appKey、manifestPath、完整 commitSha、可选 tag 与 expectedAppRevision；instanceId 由服务端已配置的 GitLab 连接确定；所有者来自认证主体，不信任自报用户 ID |
| 候选结果 | publicationId、revision、previewUrl、validationIssues、来源观测时间；预览 URL 不是凭据 |
| 预览快照 | 目标、commit、原始资料摘要、指定共享内容、版本来源、入口/包声明、内部受众、expectedAppRevision；服务端计算摘要 |
| 确认 | 登录网页提交 publicationId、revision 和预览摘要；检查所有者、当前发布权、受众配置与来源，不允许 MCP 自批准 |
| 结果 | checking / preview_ready / registering / registered / failed / cancelled，source 与 version 核验、catalog 结果、observedAt、error、nextAction、条目链接 |

instanceId 是部署配置的 GitLab 实例标识，不是应用 ID。首期仅连接一个实例，Agent 无须创建或填写该标识。服务端按 (instanceId, projectId, appKey) 查找应用；首次候选的预览基线 expectedAppRevision 为 0，成功收录时原子创建 appId 并以该三元组作唯一约束；已有应用由服务端读取当前修订号并绑定预览。请求显式携带 expectedAppRevision 时须匹配当前值，否则返回冲突。同库新增 appKey 才视为另一应用，不能用改名绕过更新冲突。

确认后来源定位或内容改变必须生成新预览，不沿用旧摘要。受众配置若改变也须重新确认，不默默扩大旧快照可见范围。网页权限与 MCP 权限使用同一广场主体。各阶段只据已核验事实给结果；没有 Release 的阶段标为“不适用”，不是失败。

| 操作 | HTTP / 网页 | MCP |
| --- | --- | --- |
| 获取规范 | 规范说明与样例 | get_publish_contract |
| 提交候选定位 | 共用发布服务，更新检查 revision | submit_candidate |
| 预览 / 确认 / 取消 | 登录网页；检查候选归属和发布权 | 不提供确认工具 |
| 查询结果 | 同一 publicationId | get_publish_status |
| 重试核验/收录 | 复用相同候选和已确认内容 | retry_registration |
| 获取接入说明 | 已发布快照及受众检查 | get_agent_instructions |

不再提供 report_gitlab_result 作为上传状态入口：源码已在 GitLab，submit_candidate 的定位已经足够供独立读取。不建设广场侧 GitLab 上传调度。

可重试的注册状态落库，关联同一候选 revision、摘要、确认人和受众；恢复时重新核验当前权限及固定来源。编辑、取消和最终收录通过同一发布记录锁裁决。收录事务原子保存快照、切换当前快照、写结果；应用修订冲突返回给作者，旧操作不能覆盖更新的版本。

请求幂等键按主体与操作绑定；同键不同请求摘要报冲突。已经 registered 的请求返回既有结果，不重复创建应用。网络超时不直接视为失败，按 publicationId 查询；源码和版本已存在时只恢复收录，不重复写 GitLab。

建议错误：VALIDATION_FAILED、REVISION_CONFLICT、CONFIRMATION_REQUIRED、SOURCE_MISMATCH、SOURCE_UNAVAILABLE、PERMISSION_DENIED、REGISTRATION_RETRYABLE。用户反馈给下一步，日志脱敏；未授权用户不能通过错误差异探知私有候选。

## 5. 样例与验证

[平台](examples/platform-app.json)、[Agent](examples/agent-app.json)、[本地工具](examples/local-tool.json)仅为虚构结构样例，域名为 example.invalid，路径与哈希不证明真实可用；本地工具样例省略 projectVersion，验证无正式版本也能表达。

需验证：三个样例结构通过；两类入口可表达新形态；无入口/非法路径/重复入口/无效主入口被拒；非所有者不能读候选；无源码权限用户可以读已批准共享说明但不能通过广场取得私有文件；确认后改 commit 或受众不能沿用旧确认；重复/并发收录不错误覆盖；GitLab 成功、目录失败只重试目录。
