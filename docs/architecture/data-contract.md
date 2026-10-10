# 应用资料与发布契约草案

状态：0.1 评审草案 · 2026-10-10。配套[架构方案](architecture.md)，尚未冻结或接入生产。

## 1. 作者需要交付什么

作者向自己的 Agent 表达分享意图，Agent 生成或补齐以下内容。广场展示只读预览；缺项通过对话澄清，作者不填写结构化表单。

| 内容 | 最小要求 | 用途 |
| --- | --- | --- |
| `ai-app.json` | 名称、能力、标签、维护者、说明引用和入口 | 确定性生成目录、详情与接入资料 |
| README / 使用说明 | 准备条件、步骤、示例、限制与求助方式 | 帮助用户判断和开始使用；可以是同一文件 |
| Agent 接入说明 | 仅 Agent 入口需要；固定版本取得方式、环境核对、操作、验证与恢复 | 交给用户的 Agent 执行，不由广场服务端执行 |
| GitLab tag + Release | tag 指向批准的 commit；Release 描述该版本及其产物 | 版本定位与发布证据；现有版本可直接登记 |
| 下载产物（适用时） | 公司允许的分发地址、文件 SHA-256 | 用户 Agent 下载后校验；无需安装包的项目不填 |

默认一个仓库一个根目录 manifest。一库多应用使用 `.ai-apps/<appKey>/ai-app.json` 并显式登记路径；文件中所有说明路径均以仓库根为基准。不要扫描仓库后凭名称自动创建应用。

## 2. manifest 字段

机器可读定义：[JSON Schema](app-manifest.schema.json)。以下长度与数量上限是首版接口的建议保护值，可在冻结时调整；不属于已经确认的业务限制。

| 字段 | 内容与来源 | 展示或校验 |
| --- | --- | --- |
| `schemaVersion` | 固定字符串 `"1"` | 资料协议版本，不是应用版本 |
| `appKey` | Agent 首次生成的稳定标识，作者确认 | 同一 GitLab 项目内唯一；改名称不改此值 |
| `name` / `summary` | 项目名称、一句话能力描述 | 列表和详情；不用技术形态替代项目名 |
| `tags` | 作者自定义，Agent 辅助整理 | 标签筛选；允许空数组，不擅自补标签 |
| `maintainers` | 维护者的 GitLab 用户名 | 读回解析为用户 ID 和展示名；不把最近提交者当作者 |
| `capabilities` | `scenarios`、`inputs`、`outputs` | 说明适用任务、所需材料和预期结果；无输入可为空数组 |
| `examples` | 示例任务 `request` 和预期结果 `expectedResult` | 至少一个可理解的首次使用场景，不充当实测证据 |
| `requirements` / `limitations` | 前置条件与已知边界 | 可为空；Agent 无法判断时先澄清，不把未知写成无限制 |
| `docs.readme` / `docs.usage` | 固定 commit 内的文档路径 | 详情默认可读的说明来源，可引用同一文件 |
| `entries` / `primaryEntry` | 可用入口及主入口 ID | 支持多个入口；目录仍只有平台访问和 Agent 接入两类操作 |

维护者字段是经作者确认的联系信息，不赋予权限。服务端要验证这些用户确实存在且符合项目维护者登记规则；发起者与被列为维护者的人可以不同。发起者能否发布仍由其自己的 GitLab 权限决定。

### 两类入口

| 字段 | `web` | `agent` |
| --- | --- | --- |
| `id` / `kind` / `label` | 唯一入口标识、`web`、入口名称 | 唯一入口标识、`agent`、入口名称 |
| `url` | 平台 HTTP(S) 地址 | 不使用；MCP 地址或安装来源写入固定版本接入说明 |
| `instructionsPath` | 不使用 | 同一 commit 的接入说明文件 |
| `compatibility` | 不使用 | 已声明的 Host / OS / 依赖条件；没有实测时注明范围未验证 |
| `artifacts` | 不使用 | 可选下载产物数组，每项包含 `url` 和 `sha256` |

`label` 用来区分同类入口；界面主操作沿用“打开应用”“接入我的Agent”。一个应用既有网站又提供 MCP 时，可登记两个入口，无须拆成两个应用。Skill、插件、CLI、本地工具等都引用各自接入说明，不新增形态枚举。

接入说明至少包括：固定版本定位、环境及已有配置核对、所需授权渠道、安装/连接步骤、最小验证任务、重复执行与升级处理、失败恢复或卸载。Skill 继续保留标准 `SKILL.md`，接入说明引用它；不复制一份技能内容到 manifest。

### 不放进 manifest 的字段

| 信息 | 来源 |
| --- | --- |
| instanceId、projectId、仓库 URL | 已登记 GitLab 实例与 API 读回 |
| commit SHA、tag、Release | 发布计划 + GitLab 读回；避免把所在 commit 的 SHA 写回文件形成自引用 |
| 卡片创建/更新时间 | 推荐项目创建时间 / 当前版本发布时间，按架构方案评审 |
| 发布人、批准人、收录时间与阶段结果 | 已认证的广场操作记录 |
| 用户是否收藏、是否有权读取 | 广场用户状态与当前 GitLab 权限 |
| 凭据、密码、令牌 | 不进入 manifest、文档、提示词或预览链接 |

## 3. 三层校验

Schema 校验只证明结构正确。服务端仍须执行语义校验和来源核验，不能拿一个绿色 Schema 结果替代发布成功。

1. **结构**：UTF-8 JSON，拒绝重复 JSON 键和未知协议版本；严格字段、大小与数量限制。建议 manifest 最大 64 KiB；引用 Markdown 总量最大 512 KiB。Schema 的 `format` 需启用校验器，不能只当注释。
2. **语义**：入口 ID 唯一，主入口存在；标签去空格和规范化后不重复；路径规范化后仍在仓库内。路径不含绝对盘符、反斜杠、空段、`.`/`..` 段或 URL；仅读取固定 commit 的普通 UTF-8 文件，不跟随符号链接、子模块或 LFS 指针去任意地址取资料。URL 不含用户名/密码、控制字符或凭据参数，分发域名符合公司规则。空白字符串不能作为内容，正文不得含有效凭据。
3. **来源**：验证当前作者权限、稳定应用标识、预期 tag/commit、manifest 和引用文件原始字节摘要、Release 与产物声明。manifest 引用的文件全部存在才可正式收录。声明中的维护者必须可核验；README 与 manifest 中重复字段有冲突时返回作者修订。

manifest 是结构化字段的唯一读取源；README 不做自由文本字段自动抽取。自然语言中的含义是否一致由作者 Agent 检查、作者预览确认；服务端只能对显式重复的结构化值做确定性比较，不承诺自动识别所有语义冲突。

摘要用 SHA-256，文件摘要基于原始字节，不做换行或 Unicode 改写。批准对象序列化规范另在接口实现时固定，不能用任意对象序列化顺序作为跨端签名。摘要由服务端重新计算，Agent 提交值只用于比对。

产物 URL 与 SHA-256 一致，只能证明**批准和仓库中的产物声明一致**。首期广场不拉取并验证所有安装包字节；真正的包摘要核验由使用者 Agent 下载后完成。已收录不代表二进制安全、安装成功或业务效果已验证。

## 4. 发布绑定与接口边界

发布绑定不写进应用资料。它是服务端保存的计划、确认与核验记录。以下为字段级提案，并非已可调用 API。

| 对象 | 关键字段 | 约束 |
| --- | --- | --- |
| 草稿请求 | target(instanceId/projectId/appKey/manifestPath)、expectedCommitSha、tag、manifest 原始内容、文档原始内容、Release 计划、expectedAppRevision | 当前认证主体为所有者；文件内容按原始字节传送并校验 UTF-8；服务端计算摘要 |
| 草稿结果 | draftId、revision、previewUrl、validationIssues | 预览链接无凭据；缺项只允许保存草稿，不允许确认 |
| 批准记录 | draftId、revision、approvalDigest、actor、expiresAt、expectedAppRevision | 独立网页操作；校验最新 revision，产生或复用一个 operationId |
| 执行线索 | operationId、projectId、tag、commitSha、可选 MR/Release 定位 | 只接受与批准目标相符的定位；不能上传 `success=true` 直接改变阶段 |
| 操作结果 | operationId、source/release/catalog、observedAt、error、nextAction、catalogUrl | 阶段有独立证据和时间；超时可查询，已完成阶段不要求重新执行 |

批准摘要覆盖所有影响发布范围和预览的字段：目标、appKey/path、commit、tag、manifest/引用文件摘要、Release 说明及计划字段、产物 URL/校验值、可见范围与应用修订号。任何改变都生成新草稿 revision，旧确认不可沿用。Release 的服务端生成 ID、实际处理时间不预先参与批准；拟修改的发布时间等作者输入必须参与。批准期满前未完成收录则重新确认，期限在接口评审时确定。成功收录在同一事务将批准标为 `consumed`；后续过期不撤销既有收录，编辑和撤销与收录通过同一批准锁串行化。

建议的接口分工：

| 操作 | 网页 / HTTP 服务 | MCP 工具 |
| --- | --- | --- |
| 获取发布契约 | 公开说明页；项目资料需授权 | `get_publish_contract` |
| 创建/更新草稿 | 共用发布服务；更新须 `expectedRevision` | `submit_draft` |
| 预览 / 确认 / 撤销 | 登录网页操作，服务端检查归属与发布权限 | 不提供批准工具；查询返回批准状态 |
| 查询结果 | 同一 operationId 的结果视图 | `get_publish_status` |
| 提交 GitLab 执行线索 | 共用核验服务 | `report_gitlab_result` |
| 重试收录 | 不改变批准内容，仅重试同一操作 | `retry_registration` |
| 获取接入说明 | 有权限的固定版本详情 | `get_agent_instructions` |

所有修改请求具有请求幂等键；同键不同内容返回冲突，不能覆盖。所有对象操作先检查当前认证主体和对象权限，`ownerUserId` 不能由请求伪造。草稿预览与正式资料使用相同的安全 Markdown 渲染规则，不因“是作者自己看的”允许执行代码。

建议错误类别包括：`VALIDATION_FAILED`（字段或资料缺项）、`REVISION_CONFLICT`、`APPROVAL_REQUIRED`、`APPROVAL_EXPIRED`、`SOURCE_MISMATCH`、`SOURCE_UNAVAILABLE`、`PERMISSION_DENIED`、`VERSION_CONFLICT`、`REGISTRATION_RETRYABLE`。对无权用户不通过不同错误暴露私有对象是否存在。业务错误附可操作的下一步，日志另存排障上下文并脱敏。

## 5. 示例与验证边界

| 示例 | 说明 |
| --- | --- |
| [平台应用](examples/platform-app.json) | 一个网页入口，覆盖名称、能力与用户说明 |
| [Agent 应用](examples/agent-app.json) | 同一成果提供 Skill 与 MCP 两个接入说明；按钮类别均为 Agent |
| [本地工具](examples/local-tool.json) | 提供公司分发包声明，由使用者 Agent 下载、验证并部署 |

示例使用虚构名称、用户与 `.example.invalid` 地址；路径是未来项目中应存在的文件，哈希是格式占位值。它们用于检验表达能力与 Schema，不可直接发布或安装。Schema/示例校验通过，不代表引用文件、权限、URL、产物或 Host 兼容性已经验证。

正式实现前至少验证：三种示例结构可表达；新形态不改 Schema 也能引用说明；无入口/非法路径被拒；重复入口/无效主入口被语义校验拒；文件变更、MR 改写 commit、tag 漂移不能沿用旧确认；私有资料不会经列表、预览或 MCP 泄露。
