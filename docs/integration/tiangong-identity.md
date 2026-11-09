# 广场用户体系与天宫接入

2026-11-09：按用户确认的方向建设广场自身用户与会话，复用天宫身份。本文对应本地开发候选，不代表目标门户已挂载、真实账号验证或生产启用。

## 使用边界

- 公开目录、随机发现、详情及原有发布与接入链路继续可匿名使用。
- 登录后可保存个人收藏；卡片、轮盘、详情复用同一收藏操作。登录中保留一次收藏意图，成功后由服务端再次读取当前应用；取消或无权不会显示为已收藏。
- “我的收藏”仅返回本人记录；应用不可访问时返回通用占位，可移除。收藏不计使用意向，切换账号或核验失败会清除上一身份的页面状态。
- 小组由广场本地维护；成员候选来自已通过天宫核验并至少登录过一次的广场用户。这不是天宫全量员工名册，也不代表成员当前在线或实时启用状态。
- 名册管理员由服务端明确配置，不从天宫用户类型、昵称、首个登录者或小组成员关系推导。此角色不授予应用维护、审核或运营统计权限。
- 应用归属、四类受限分享、维护委派、上级审核及 MCP 身份关联继续按各自实施段接入；登录不自动认领存量应用或修改其公开范围。

## 同源部署条件

参考伏羲的 `backend/services/tiangong-auth.js` 与 `docs/TIANGONG_LOGIN_INTEGRATION.md`：浏览器需在天宫 origin 下访问广场，如 `https://portal.example.invalid/plaza/`，才能读取门户既有的 localStorage Token。普通跨域 iframe 或单独的广场 IP 不满足该条件。

广场读取固定键名，后端只访问固定 `findByToken` 地址；不接收客户端传入查询地址，不跟随重定向。天宫返回的 `userId`、租户字段、用户类型、非匿名状态及启用状态均须符合契约，业务成功码或 HTTP 200 不足以认定有效。长整数 ID 保留原始精度。

浏览器先取得 120 秒、HttpOnly Cookie 绑定的一次性请求，再兑换广场独立会话。广场保存用户资料与会话随机值的 SHA-256，天宫 Token 不落库、不写日志、不放入 URL，不复制到其他存储。HTTPS 使用 Secure Cookie；Cookie 名隔离 origin 与挂载路径，避免同主机不同环境的 Cookie 相互覆盖。

受保护读取及写入均向天宫重新核验当前 Token，不用八小时会话期限代替撤权核验。天宫过期、停用、匿名或账号变化时停止受保护操作；服务故障返回 503，不冒充无权限。更换账号需要显式确认。退出仅结束广场会话，不退出天宫；本标签页刷新不自动重新登录。

## 配置

沿用 `.env.example` 的数据库、GitLab 和持久化密钥配置，再显式设置：

```dotenv
PUBLIC_ORIGIN=https://portal.example.invalid
PLAZA_PUBLIC_BASE_PATH=/plaza
TIANGONG_AUTH_ENABLED=true
TIANGONG_USERINFO_URL=https://portal.example.invalid/pedestal-service/inner/skyUser/findByToken
TIANGONG_SUCCESS_CODE=00000000
TIANGONG_TOKEN_STORAGE_KEY=sky-token
TIANGONG_ALLOWED_USER_TYPES=03,04
TIANGONG_WEB_SESSION_HOURS=8
PLAZA_IDENTITY_ADMIN_SUBJECTS=
```

示例 origin 与接口路径是占位值，应与实际门户合同核对。管理员项填写经过核对的天宫稳定用户 ID，逗号分隔；留空不会自动生成管理员。上游 URL 是连接地址，用户关联使用固定 `tiangong` 来源与 `userId`，不因接口地址调整或显示姓名变化而另建账号。

默认关闭身份；关闭后不注册个人与小组接口、不展示这些入口。身份模式不与 `PLAZA_LOCAL_MANAGEMENT`、`PLAZA_INTRANET_MANAGEMENT`、`PLAZA_PREVIEW_ADMIN_PROXY_IP` 或双 origin 的 `PLAZA_HTTPS_ORIGIN` 同时启用。应将门户同源地址设置为唯一 `PUBLIC_ORIGIN`，由受控反向代理传入对应 Host；网络与证书准备不由应用启动自动完成。

`PLAZA_PUBLIC_BASE_PATH` 仅接受一个固定路径段。前端资源、API、私有预览回执、发布契约、包链接及现有 MCP / Python 客户端均保留此前缀；客户端仍不读取或取得网页身份。无前缀部署保留原行为。

启用时在当前配置的数据库创建 `plaza_identities`、`plaza_login_requests`、`plaza_sessions`、`plaza_groups`、`plaza_group_members`、`plaza_identity_operations`、`plaza_favorites`，不更改既有应用或发布记录。会话和请求到期后在启动及每分钟清理。小组变更在同一事务保存成员、修订与真实操作者；未知结果重试保留创建请求 ID，已有修订冲突须回读。

## 本地验证

```powershell
npm run typecheck
node --import tsx --test tests/identity.test.ts tests/personal-space.test.ts
npm run build
$env:PLAYWRIGHT_CHANNEL='msedge'
npm run test:identity:browser
```

浏览器场景使用显式启动的回环合成天宫服务，验证真实网页、API 与 PostgreSQL 引擎，不连接真实账号。`node --import tsx tests/identity-browser.ts --serve` 可启动同样的本地审阅入口；入口在控制台输出。测试数据和测试 Token 只存在测试夹具，正式服务不会注册合成门户或注入应用。

真实天宫账号、同源反向代理及发布环境仍需独立验证。Windows 发布客户端的完整测试依赖 DPAPI；应在允许调用用户凭据保护的测试环境执行，保留原安全检查。

## 设计核对记录

```yaml
route: {mode: ARCH_DESIGN, dp: DP-001, overlays: none, basis: 为第二段身份接入选择最小实现}
intent_and_properties: [公开浏览匿名, 身份由天宫核验, 广场授权独立, 凭据不落库]
activated_dimensions: [trust]
question_sets: [Q-INT, Q-PRP, Q-EVD, Q-ALT, Q-UNK, Q-TRS]
knowledge_route: [security, MP-005, FP-006, T-011, GC-012]
evidence:
  - {origin: PRODUCT_INTENT, pointer: AGENTS.md, claim_epistemic_state: CONFIRMED}
  - {origin: CODE, pointer: server/domain/tiangong-identity.ts, claim_epistemic_state: CONFIRMED}
  - {origin: CODE, pointer: server/identity.ts, claim_epistemic_state: CONFIRMED}
gc_checked: [GC-012不适用，网页登录及多权限边界确实存在]
terminal_outcome: NO_DECISION_CHANGING_WORK
stop_reason: 6
```

采用天宫核验加广场独立用户/会话，复用现有数据库与组件。可信入口直接传递已核验身份是另一可行方向，但需要额外入口合同；本轮按已确认的独立会话方向实现。真实入口可用性仍为待验证事实。
