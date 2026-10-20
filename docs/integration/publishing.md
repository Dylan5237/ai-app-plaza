# AI应用广场上传、分享与更新接入规范

核对日期：2026-10-20。实现基线：`54471817`（同步 main 后复核，完整 SHA 见 Git）。适用读者：在应用项目内工作的 Agent、Host 集成维护者及应用作者。本文归纳现有实现，不新增接口、授权或验收承诺。

## 1. 接入起点与依据

每次操作先读取目标广场的契约，不把历史提示词、本文中的示例值或其他部署的工具用于本次上传：

| 目的 | 请求 |
| --- | --- |
| 首次分享 | `GET /api/publish-contract` |
| 更新已收录应用 | `GET /api/apps/{appId}/publish-contract` |
| 明确采用原有 GitLab 项目发布 | `GET /api/publish-contract?mode=gitlab` |
| 读取已有能力标签 | `GET /api/tags` |

契约返回 `mode`、`prompt`、`schema`、`submitUrl`、`gitlabUrl`、`audience` 和 `tagPolicy`。托管模式额外返回 `managed`，包含托管群组、官方工具地址和 SHA-256、校验地址、回执地址及文件限额；更新契约另有 `updateTarget`。以响应的 `mode` 选择流程：启用托管时新应用默认 `managed`，未启用时为 `gitlab`；已有应用按其原发布方式更新，不自动迁移。

资料协议版本为字符串 `"2"`，应用自身版本是 `projectVersion`，两者不同。当前 API 路径未版本化，没有独立的 API 版本协商机制。本文和代码相符不代表目标服务器已经部署该版本；接口、字段或官方工具不匹配时，先核实部署差异，不猜测写入方式。

依据优先级：目标服务当前返回的契约与错误诊断 → 对应版本的服务端实现和官方工具 → 本文。仓库内唯一完整可执行 Schema 为 [server/contracts/app-manifest.schema.json](../../server/contracts/app-manifest.schema.json)。[旧 Schema 路径](../architecture/app-manifest.schema.json)仅作引用入口。

## 2. 应用作者交付什么

最小资料是 `ai-app.json`、它明确引用的共享 Markdown，以及至少一个使用入口。托管发布还要包含本次应用需要的源码；直连发布的这些文件须已经存在于固定 GitLab commit 中。

所有新建及更新都使用 v2。已收录的 v1 仅兼容读取，不可照搬为新的提交。字段不得擅自增加，JSON 不允许注释、尾逗号、重复键或空白文本。

| 字段 | 当前约束与含义 |
| --- | --- |
| `schemaVersion` | 必填，字符串 `"2"`，不是数字 `2` |
| `appKey` | 必填，项目内稳定标识，1–64 字符，小写字母/数字及分隔用连字符；改名称不改它 |
| `name` / `summary` | 必填，分别最多 80 / 240 字符；摘要用一句话说明价值 |
| `projectVersion` | 必填，如 `1.2.3`、`v1.2.3`、`v1.2.3-rc.1`；当前不接受 `+build` 元数据 |
| `tags` | 必填数组，可为空，最多 3 个不重复的核心能力标签，每项最多 32 字符；先读已有标签并优先复用 |
| `maintainers` | 1–10 位作者，每项为 `{ "name": "中文姓名", "nameEn": "英文全名或完整拼音" }`；缺少任一姓名先询问作者，不从 Git/GitLab 推断 |
| `capabilities` | 必填对象，含 `scenarios`、`inputs`、`outputs`；场景和产出不可为空，输入可为空 |
| `examples` | 1–5 项，每项有 `request`、`expectedResult` |
| `requirements` / `limitations` | 必填数组，陈述真实条件与限制，不把未知写成“无限制” |
| `docs` | 必填 `readme`、`usage` 两个仓库相对路径，可指同一个专用 Markdown |
| `entries` / `primaryEntry` | 1–8 个入口，入口 ID 唯一；主入口必须引用其中一个 ID |

`capabilities` 内数组及 `requirements`、`limitations` 最多各 20 项，通常每项最多 1000 字符；其余精确长度、必填与类型以 Schema 为准。服务端另行校验路径、URL、版本、来源与标签复用等语义，Schema 校验通过不等于可以发布。

### 使用入口

- `web`：`id`、`kind: "web"`、`label`、`url`。登记实际平台地址；平台自己负责登录、部署与运行版本。
- `agent`：`id`、`kind: "agent"`、`label`、`instructionsPath`、非空 `compatibility`。接入说明写清固定版本获取、环境要求、授权渠道、安装/升级步骤、配置和本地修改保护、最小验证及失败恢复。可选 `artifacts` 每项含 `url` 和 64 位小写十六进制 `sha256`。

同一应用可同时有两类入口。Skill、MCP、CLI、脚本或工作流通过合适的 `agent` 入口表达，不新增 `kind: "mcp"` 等类型；已有 `SKILL.md` 保持原格式。入口和产物 URL 只允许不含用户名、密码的 HTTP(S)。包摘要是作者声明，由使用者 Agent 下载后验证，不代表广场已下载或扫描该包。

### 路径、共享内容与文件限制

默认 manifest 为应用根目录 `ai-app.json`。直连接口允许显式指定其他安全路径，例如 `.ai-apps/{appKey}/ai-app.json`；当前官方托管 CLI 从 `--project` 下的根 `ai-app.json` 采集。文档路径均相对应用仓库根，不相对 manifest 所在目录。

路径使用 `/`，不得为绝对路径，不含反斜杠、冒号、空段、`.`、`..` 或控制字符。共享文件是固定 commit 中的普通 UTF-8 文件，不能用符号链接、子模块或 LFS 指针代替正文。Manifest 上限 64 KiB；所有去重后的共享说明和 Agent 接入说明合计上限 512 KiB。

广场目录展示 manifest 和它指定的共享说明，不因托管上传而公开完整源码或未声明文件。Markdown 安全渲染，不执行 HTML/脚本，不递归抓取附件。源码、包和目标平台仍保留各自访问权限。

托管包限 1–1000 个文件，单文件最多 5 MiB，总原始字节最多 20 MiB。只上传必要源码和共享资料；排除凭据、`.env`、私钥、机器配置、`.git`、`node_modules`、缓存、归档及无关会话/治理文件。工具和服务端有路径、文件类型与敏感内容检查；不要把扫描通过解释为所有内容均已获准分享。超限时向作者说明精简范围，不能静默丢失必要文件。

### 可复制的结构样例

[平台应用](../architecture/examples/platform-app.json)、[Agent 应用](../architecture/examples/agent-app.json)、[本地工具](../architecture/examples/local-tool.json)均使用 v2。作者姓名、域名、文件路径和哈希都是虚构示例，不能直接用于真实发布。示例仅展示 manifest 结构，不包含完整应用源码及引用文档；发布前必须换成项目实际资料，并经过目标服务预检。

## 3. 首次分享：统一托管

适用条件：契约返回 `mode: "managed"`，当前 Host 能读取项目、执行 Python 3.10+、访问门户并安全保存本机恢复记录。负责人无需提供个人 GitLab 令牌；服务器持有固定群组授权。

1. 阅读项目和它的分享规则，确定应用根目录及获准上传范围，补齐作者姓名与 v2 资料。不要改 remote、改写历史或顺带合并/部署。
2. 从契约的 `managed.publisherUrl` 下载官方工具，保存到项目之外；按本次返回的 `managed.publisherSha256` 校验原始字节。
3. 可先本地检查，正式上传前必须执行服务端无写入预检：

   ```text
   python "<官方工具绝对路径>" --origin "<门户根地址>" --project "<应用根目录绝对路径>" --dry-run
   python "<官方工具绝对路径>" --origin "<门户根地址>" --project "<应用根目录绝对路径>" --validate
   ```

   `--dry-run` 不联网，不能替代 `--validate`。后者调用 `POST /api/managed-publications/validate`，不创建发布身份、业务记录、仓库或 receipt，也不执行 GitLab 写入。它验证资料包和适用的目录标签规则，不预先保证更新归属、修订、版本或来源权限成立。按安全诊断定位修正后再预检。
4. 预检通过、文件清单符合分享范围且具备本次上传授权后，执行正式上传：

   ```text
   python "<官方工具绝对路径>" --origin "<门户根地址>" --project "<应用根目录绝对路径>"
   ```

   工具先安全保存应用专属凭证、幂等键和原请求，再上传。服务器在固定私有群组创建独立项目，关闭新仓库 CI，建立 commit、匹配版本 tag 和 Release，并交给共同的来源核验与预览流程。上传不会执行应用代码。
5. 只有 `preview_ready`、有效 `previewUrl` 且回执保存成功，才将私有预览链接交给作者，说明“预览已生成，尚未收录”。HTTP 201 本身不能证明交接完成。
6. 作者打开预览确认。Agent 不调用确认接口，不代点确认。之后只读查询，取得 `registered` 和 `appId` 后才能报告收录成功。

上传辅助工具是托管发布的正式 Agent 入口。校验失败、4xx、超时或未知结果都不是改写 HTTP 上传器的理由。禁止对正式上传接口用小包、逐文件或二分探测；**资料包/标签问题**使用 `--validate` 定位，身份、修订、版本、权限或已上传 GitLab 状态问题应沿原回执核实，不能用预检替代对账。环境确实无法使用官方工具时，说明缺口，转到具备项目上下文和执行能力的 Host。

## 4. 首次分享：直连 GitLab

适用条件：契约返回 `mode: "gitlab"`，已有目标 GitLab 项目，作者 Agent 具有相应项目写入授权和发布流程依据。

1. 按原有分支/MR/发布政策准备实际文件及最终 commit。HTTP 请求使用完整 40 或 64 位**小写**十六进制 SHA，不用分支名、`HEAD`、`latest` 或短 SHA。
2. 创建匹配 `projectVersion` 的版本 tag 和正式 GitLab Release。服务端会核验请求 SHA、`tag.commit.id`、`Release.commit.id` 相同，`Release.tag_name` 等于请求 tag；manifest 版本与 tag 比较时允许可选 `v` 前缀。不要移动已有 tag，新 commit 使用新版本。
3. 通过安全环境读取 GitLab 授权，当前用户须有目标项目有效 Maintainer/Owner 权限及必要读取能力。令牌只通过 `X-GitLab-Token` 请求头发送，不进 JSON、命令行实参、日志、仓库或聊天。
4. `POST /api/publications`，使用 `Content-Type: application/json`、`X-GitLab-Token`、`Idempotency-Key`。幂等键建议 UUID；HTTP 校验允许 16–128 个字母/数字/下划线/连字符。以下仅为请求形状：

   ```json
   {
     "projectId": "123",
     "appKey": "task-studio",
     "manifestPath": "ai-app.json",
     "commitSha": "0123456789abcdef0123456789abcdef01234567",
     "tag": "v2.1.0"
   }
   ```

   `projectId` 是 GitLab 数字项目 ID（接口也接受正的安全整数）。不发送源码/文档副本，不自报作者身份 ID 或 GitLab 实例地址。服务端从已配置实例独立读取并核验。
5. 保存返回的发布 `id`、`ticket` 和私有 `previewUrl`；先看 `status`，再按第 6 节处理。需要修改来源时，明确准备新的版本和新的请求；原请求结果未知时先使用原幂等键对账。

这条路径的 GitLab 写入由作者既有工具执行；广场确认只授权目录展示，不能作为此前源码上传、MR 合并或部署的授权。

## 5. 更新已收录应用

首先读取 `GET /api/apps/{appId}/publish-contract`，随后用 `GET /api/apps/{appId}` 复核当前 `revision`、`version` 与来源。保留原项目、`appKey` 和 manifest 路径；托管应用还保留原 `managedAppId` 和应用专属凭证。

1. 准备严格高于广场当前版本的 `projectVersion` 与资料。**托管更新由服务器创建对应 commit、tag 和 Release**；**直连更新由作者 Agent 按项目授权准备匹配 tag 和 Release**。即使只改名称、标签或使用说明，新的发布内容也须用更高版本；不能套用旧文档中“同版本改资料”的规则。历史 v1 快照可以更新为首个符合当前要求的正式版本。
2. 完善安装/升级说明，写清兼容变化、用户配置及本地修改的保留与恢复方式。无法从项目确认升级行为时询问作者。
3. 托管更新运行同一官方工具，预检后正式上传附加：

   ```text
   python "<官方工具绝对路径>" --origin "<原门户根地址>" --project "<原应用根目录绝对路径>" --managed-app-id "<更新契约中的 managedAppId>"
   ```

   工具须找到匹配的本机 receipt，复用凭证并读取服务器修订。缺少凭证时停止，不换目录、换身份或伪装成首次分享。
4. 直连更新沿用第 4 节请求，额外传本次读回的 `expectedAppRevision`。接口层允许省略，但 Agent 更新流程必须携带它，不能靠省略绕过已知冲突。
5. 作者核对新预览的 `change`、旧版到新版及共享内容，再确认更新。确认前及失败时原版本仍可用；成功后保留原 `appId`、应用链接与创建时间，目录修订递增。

首次创建的目录修订基线是 0，已收录应用从 1 起。`expectedAppRevision` 取自当前公开应用的 `revision`；确认请求使用发布回执**顶层** `revision`，它是本次预览修订。`preview.revision` 则是候选确认后的目录修订，例如当前应用为 1、更新预览为 2，不能用它代替确认所需的顶层值。`REVISION_CONFLICT` 时重新读取当前应用并生成新预览；不得强行覆盖。相同来源与内容可返回既有结果，不产生重复目录项；“可幂等重放”不表示允许同版本修改内容。

托管应用尚未首次收录时，也可能已有仓库和候选。此时沿原应用身份及 revision 0 继续；若明确修改候选包，仍须使用高于此前候选的版本，不覆盖旧 tag/Release。

## 6. 发布结果、作者确认与恢复

### 发布回执

直连提交返回 `PublicationView` 加 `ticket`、`previewUrl`。`PublicationView` 固定包含 `id`、`status`、`revision`、`nextAction`、`expiresAt`；随阶段可能包含 `digest`、`preview`、`change`、`appId`、`error`。

`preview` 包含应用资料、共享文档、来源、版本与目录修订。`change` 为 `{ kind, previousVersion?, changedFields }`，`kind` 为 `create` / `update` / `unchanged`。`digest` 由服务器计算，不由 Agent 自造。

托管上传 HTTP 响应在同一顶层扩展 `managedAppId` 和 `sourceUploaded: true`，不存在 `publication` 包装层。托管回执查询在操作未完成时也可能返回 `status: recovery_required`、`nextAction: retry_original`、`recoveryRequired`、`managedAppId`、`sourceUploaded` 和 `operationStatus`，而没有完整发布预览。官方 CLI 会校验身份、来源和链接，持久化后输出经过筛选的 JSON；不要把 CLI 输出和原始 HTTP 响应当作同一结构。消费结果同时检查状态、诊断、回执保存和退出码，不能仅看 HTTP 成功码。

| 状态/结果 | Agent 应如何处理 |
| --- | --- |
| `validated` / 本地 dry-run 成功 | 仅资料检查成功，尚未上传或收录 |
| `checking` | 结果未完成，沿原操作查询或恢复 |
| `preview_ready` | 有效预览已安全保存后交作者确认，尚未收录 |
| `failed` + `nextAction: retry` | 按现有恢复入口重试核验或已确认的收录，不重新上传源码或代做确认 |
| `failed` + `nextAction: submit_again` | 先查明原操作，修正明确问题并准备新候选，不用原幂等键发送新正文 |
| `registered` | 已收录，使用 `appId` 读回公开详情；安装、运行和业务效果另行验证 |
| HTTP 超时、无合法链接、回执保存失败 | 结果或交接待恢复，不能宣称成功或换身份重发 |

类型中保留 `cancelled`，但当前没有取消/撤回公开 API。不要假设有 `registering` 轮询状态、编辑候选或撤回工具。

### 私有链接与确认边界

发布记录有效期为 24 小时，以返回的 `expiresAt` 为准。完整链接携带本次能力凭证，持有者可以查看并确认；这不是实名审批。只交给本次作者，不写公共日志、Issue、群聊或共享文档。网页读取凭证后存入本标签页 sessionStorage，并从地址栏移除。

公开目录无需登录。部署者可另行启用[私有预览只读管理](../ops/private-preview-administration.md)，通过独立管理员口令及会话查看各作者尚未确认的记录。管理接口不返回作者 ticket 或确认摘要，不能确认、重试、恢复、取消或删除；管理员会话不能代替作者 Bearer ticket，也不会延长作者链接有效期。此能力不改变下述发布与确认协议。

`GET /api/publications/{id}` 使用 `Authorization: Bearer <ticket>` 查询。作者网页确认使用 `POST /api/publications/{id}/confirm`，请求体为 `{ "revision": <预览修订>, "digest": "<预览摘要>" }`，同样使用 ticket。此处记录接口用于理解系统边界，**Agent 不调用确认接口，也不代作者点击确认**。确认时服务器再次核验权限和固定来源。

### 托管 CLI 恢复

`--dry-run`、`--validate`、`--status`、`--recover` 互斥；无模式参数才正式上传。`--managed-app-id` 仅用于正式模式，不能和上述四个模式一起传。所有模式都需要同一 `--origin` 和绝对 `--project`；origin 必须是无凭据、无业务路径/查询/片段的门户根地址。预检和恢复时不要复制正式更新命令中的 `--managed-app-id`。

```text
python "<官方工具绝对路径>" --origin "<原门户根地址>" --project "<原项目绝对路径>" --status
python "<官方工具绝对路径>" --origin "<原门户根地址>" --project "<原项目绝对路径>" --recover
```

- `--status` 读取根 `ai-app.json` 的 appKey 以定位本机 receipt，不联网、不递归采集当前源码；它不能证明服务器此刻仍是该状态。找到并读出 receipt 时，输出外层为 `status: receipt_saved`，业务状态在 `publicationStatus` / `handoffState` 中；未找到时为 `receipt_not_found`，不能把外层 status 当成发布状态。
- `--recover` 使用原专属凭证和原幂等键读取 `GET /api/managed-publications/receipt`，校验后可更新本机 receipt；它不重新上传、不在服务器创建或推进操作。
- 未完成的原操作按原身份、原包、原幂等键对账继续。取得可核验的 `retry_original` 后，正式命令重放的是 **receipt 中保存的原请求包**，不会用当前工作区的新正文替换它。正式模式仍先采集当前项目，所以应保留原项目路径、appKey 和可读的完整项目；当前文件已变化时，工具可先恢复原请求并退出 3，提示新内容另行提交。工具若提示状态不允许，先按诊断处理，不为恢复而擅自回退用户文件。不要删除/改名 receipt、手改保存请求、轮换凭据或换键来绕过失败。
- 明确的新内容与原操作重试不同。先核清原操作状态，再准备更高版本并重新预检，由工具按已核实状态创建新请求；不要用同键发送不同正文。
- 工具凭证和恢复数据保存在用户私有目录；Windows 使用 DPAPI，POSIX 使用私有权限。receipt 身份由门户 origin、解析后的项目绝对路径和根 Manifest 的 appKey 共同定位；路径或 appKey 改变会定位到另一份记录，Manifest 缺失/损坏也可能无法查询。保留原系统用户及这三项身份信息；无凭证跨机器恢复不是当前承诺能力。
- `failed` 且 `nextAction: retry` 时，工具可能返回已验证的 `recoveryUrl`。只把它交作者到现有页面查看原因、手动重试，再运行 `--recover` 读回。恢复链接不等于预览完成。

| CLI 结果 | 当前退出码及含义 |
| --- | --- |
| dry-run / validate 成功 | 0，仍未上传 |
| status 查询到/未查询到 receipt | 都可能为 0，查看 `receipt_saved` / `receipt_not_found` 及业务状态 |
| 有效 `preview_ready` 且交接完整 | 0；`handoffState: complete` 只表示预览交接完成 |
| 恢复尚未完成、failed、未知结果 | 通常 1，按 JSON 与诊断恢复 |
| 本地资料/校验/一般操作错误 | 通常 2，核对 stdout 诊断或 stderr；并非所有错误都具有相同 JSON 外形 |
| 原操作已恢复，但当前文件与原包不同 | 3，表示当前改动尚未提交；先核对原结果，再明确准备新版本，重新预检和运行 |
| 已恢复 `registered` | 当前仍可能为 1，见下述限制 |

**当前已知限制：** 在本文基线中，正式模式或 `--recover` 取得并保存 `registered` 回执后仍可能退出 1（[维护事项 #50](https://github.com/Dylan5237/ai-app-plaza/issues/50)）。不能据此重新上传或重复确认。核对本次返回 JSON、已保存回执和公开应用详情；分别报告“已收录”与“CLI 退出码异常”。也不能把任意退出 1 都当成功。此处记录现状，不表示缺陷已修复。

### 直连恢复与通用错误

直连网络结果未知且尚无发布 ID 时，用**原 token、原幂等键、原请求**重放提交以取得原结果；已有 ID/ticket 时先查询。`POST /api/publications/{id}/retry`（Bearer ticket）恢复失败核验或已确认收录，不上传源码，也不代替新的作者确认。

HTTP 错误结构通常为 `{ "error": { "code": "...", "message": "...", "diagnostics": [...] } }`，`diagnostics` 可选。已有发布记录的失败也可能在 HTTP 201/200 的业务响应中表示，必须查看 `status`、`error` 和 `nextAction`。

下表为常见情形，不是完整错误码枚举。正式上传的部分 HTTP 错误在当前 CLI 中仅表现为通用 stderr；不要据此猜测错误码、自动重试或认为尚未发生远端写入。未知结果先保留原回执查询，无法核实则报告缺口、停止新的写入。

| 代码/情形 | 处理原则 |
| --- | --- |
| `INVALID_REQUEST`、`VALIDATION_FAILED`、预检诊断 | 按字段/相对路径修正，不绕过校验 |
| `IDEMPOTENCY_CONFLICT` | 同键对应不同请求，核对原操作；不盲目换键 |
| `REVISION_CONFLICT`、`VERSION_NOT_NEWER` | 读回当前版本/修订，准备更高版本与新预览 |
| `SOURCE_MISMATCH` | 来源或预览摘要变化，重新准备并确认候选 |
| `GITLAB_AUTH_REQUIRED`、`AUTH_TOKEN_INVALID`、`PERMISSION_DENIED` | 核对安全授权和项目权限，不索要聊天中的令牌 |
| `MANAGED_PUBLISH_DISABLED` | 核实部署能力，不把未启用误当临时上传失败 |
| `MANAGED_APP_OWNER_REQUIRED` | 原凭据或托管应用不匹配，停止更新，核对原身份与 receipt |
| `MANAGED_OPERATION_NOT_FOUND` | 未找到原凭据/幂等键对应操作；保留回执核实，不推断可新建替代应用 |
| `MANAGED_SOURCE_CONFLICT` | 托管来源或检查点不一致，服务已停止写入；保留原记录并交维护者核验，不循环上传 |
| `TAG_CONFLICT`、`RELEASE_CONFLICT` | 已有版本指向其他提交，不移动或覆盖；核清原操作后按新版本流程处理 |
| `UPLOAD_BUSY`、`RATE_LIMITED`、网络/来源暂不可达 | 保留原请求和回执，按状态稍后恢复 |
| `NOT_FOUND`、`PUBLICATION_NOT_FOUND`、`PUBLICATION_EXPIRED` | 不推断应用不存在；核对原链接、期限和公开目录，停止未经核实的新写入 |

诊断只保留可安全披露的规则、相对路径、行/列或字段与建议。不要回显命中原文、凭据、用户绝对路径或私有链接。完整操作说明见[发布校验与恢复](../ops/publishing-validation-recovery.md)。

## 7. HTTP 与 MCP 对照

| 能力 | HTTP | 现有 MCP |
| --- | --- | --- |
| 读取首次/更新契约 | `GET /api/publish-contract`、`GET /api/apps/{appId}/publish-contract` | `get_publish_contract({ appId? })` |
| 标签列表 | `GET /api/tags` | 无单独工具 |
| 托管校验/上传/恢复 | 官方 CLI 对应 `/api/managed-publications` 系列 | 无托管上传工具；使用契约下发的 CLI |
| 提交已有 GitLab 固定来源 | `POST /api/publications` | `submit_candidate`，含 `idempotencyKey`，token 从本机 `GITLAB_TOKEN` 读取 |
| 查询发布结果 | `GET /api/publications/{id}` | `get_publish_status({ publicationId, ticket })` |
| 恢复核验/收录 | `POST /api/publications/{id}/retry` | `retry_registration({ publicationId, ticket })` |
| 作者确认 | `POST /api/publications/{id}/confirm`，仅作者网页流程 | 无确认工具 |
| 已收录详情 | `GET /api/apps/{appId}` | 无单独工具 |
| 安装/升级说明 | `GET /api/apps/{appId}/instructions/{entryId}` | `get_agent_instructions({ appId, entryId })` |

托管低层接口供维护者对照实现：`POST /api/managed-publications` 接受 `appKey`、`manifestPath`、`files: [{path, content}]`，其中 `content` 为规范 Base64；更新可带 `managedAppId` 和 `expectedAppRevision`。Headers 为 `X-Plaza-Publish-Key` 与 UUID `Idempotency-Key`，不传个人 GitLab token。HTTP JSON 上限 32 MiB，与 20 MiB 原文件总量是不同限制。`GET /api/managed-publications/receipt` 使用同一专属凭证和原幂等键；`GET /api/managed-apps/{managedAppId}/status` 使用专属凭证查询更新状态。不要据此另写 Agent 上传器。

现有 MCP 是 stdio 到 HTTP 的适配器。`get_publish_contract` 没有 `mode` 参数，托管默认下如需直连规范，显式走 HTTP `?mode=gitlab`。MCP 不上传本地文件，也不执行安装。Host 配置见 [README](../../README.md#agent-接口)；实际 Host 连接与业务运行须单独验证。

## 8. 给 Agent 的完成判定

1. 资料已准备：真实项目证据充分、姓名齐全、符合 v2，尚未上传。
2. 预检通过：本地/服务端检查通过，尚未证明来源核验或收录。
3. 发布预览已交付：有效私有预览、回执安全保存且链接已交作者，尚待确认。
4. 已收录/更新：只读查询为 `registered`，公开详情的应用 ID、版本和来源符合本次操作。
5. 已安装/升级或业务可用：使用者自己的环境已完成对应验证，单独提供证据。

广场不自动跟踪新 Release、执行后台升级、保存用户安装状态或代作者验收。使用者升级先核对当前已确认版本与本地状态，保护配置和本地改动；发布规范和作者说明本身不授予额外操作权限。

## 9. 实现索引与历史迁移

- [契约选择及直连提示词](../../server/publish-contract.ts)、[托管提示词与工具元数据](../../server/managed-publish-contract.ts)。
- [HTTP 路由与请求结构](../../server/app.ts)、[MCP 工具](../../server/mcp.ts)。
- [资料语义校验](../../server/domain/manifest.ts)、[GitLab 固定来源核验](../../server/domain/gitlab-source.ts)。
- [预览、确认与更新](../../server/domain/service.ts)、[托管流程](../../server/domain/managed-publisher.ts)、[官方 CLI](../../server/publisher-cli.py)。

旧版“登录后确认、tag/Release 可选、仅提交定位、同版本改资料、预览 URL 不携带凭证、可取消/撤回”的描述不能用于当前接入。当前对应为：无登录的私有能力链接确认；新发布必须正式版本三方匹配；托管上传与直连定位并存；新内容使用更高版本；私有链接需要保密；没有公开取消/撤回接口。早期决策和原型材料保留历史用途，当前操作统一以本文和目标服务契约为准。
