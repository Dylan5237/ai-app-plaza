# 应用资料与收录契约

更新：2026-10-19。本页是旧接入路径的索引；现行操作统一见 [上传、分享与更新接入规范](../integration/publishing.md)。

## 现行依据

- 在线契约：`GET /api/publish-contract`；已有应用用 `GET /api/apps/{appId}/publish-contract`。
- 完整可执行 Schema：[server/contracts/app-manifest.schema.json](../../server/contracts/app-manifest.schema.json)，新发布及更新使用字符串 `schemaVersion: "2"`。
- [旧 Schema 文件](app-manifest.schema.json)保留为指向上述文件的 JSON Schema 引用，避免维护两套规则。离线校验器须解析相对引用，或直接读取完整 Schema。
- v2 结构样例：[平台](examples/platform-app.json)、[Agent](examples/agent-app.json)、[本地工具](examples/local-tool.json)。示例是虚构资料，不是可直接发布的完整应用包。

## 已修正的旧版口径

| 旧版说明 | 当前实现 |
| --- | --- |
| 只接收 GitLab 定位，不上传文件 | 托管模式由官方 CLI 上传必要源码与资料；直连模式仍只提交固定来源定位 |
| `projectVersion`、tag、Release 可选 | 新建与更新均必需，版本及固定 commit 须匹配；历史 v1 快照仅兼容读取 |
| 作者为字符串联系人 | 每位作者包含 `name` 与 `nameEn`；作者声明不授予权限 |
| 同软件版本可以提交不同资料快照 | 新发布内容需要更高版本；同来源同内容重放可幂等返回既有结果 |
| 登录后确认、预览 URL 不是凭据 | 无登录门户；完整预览链接携带短期能力凭证，持有者可查看和确认 |
| Agent 提交后可自行确认 | 必须把预览交作者，MCP 不提供确认工具，Agent 不代确认 |
| 存在 `registering` 状态、编辑/取消/撤回接口 | 当前发布状态与接口以统一规范为准；没有公开编辑、取消或撤回 API |
| 文档大小仅为建议 | Manifest 64 KiB、共享文档合计 512 KiB 为实现限制；托管包另有限额 |
| API 待实现 | 仓库已有 HTTP、MCP、官方托管 CLI；部署与真实 Host 能力仍按实际验证报告 |

## 维护方式

字段、请求、状态、恢复、更新和完成判定集中维护在统一规范；本页不再复制完整协议。接口行为变化时同时核对服务端 Schema、官方 CLI、发布提示词、统一规范及示例。早期设计过程可通过 Git 历史与[当时决策](decisions-2026-10-10.md)追溯，不用于当前上传。
