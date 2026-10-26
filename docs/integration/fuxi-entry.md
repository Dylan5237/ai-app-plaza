# 从广场进入伏羲

本接入只负责伏羲入口和天宫凭证交接。广场保持匿名目录，不保存用户库、不解析用户角色，不调用跨域身份兑换接口。伏羲验证门户凭证、建立或查找账号映射并管理自身会话。对应需求为 [#78](https://github.com/Dylan5237/ai-app-plaza/issues/78)，伏羲接收方合同为 [#111](https://github.com/Dylan5237/prototype-manager/issues/111)。

## 部署前核实来源

默认没有受控入口配置，现有应用继续原外链行为。配置固定应用UUID及入口ID后，该入口由受控策略管理；停用时明确提示，不静默打开Manifest原URL。

策略只绑定指定entry ID。同一应用的其他Web入口仍是普通外链，不会取得门户凭证；需要受控接入的入口应明确配置，不能靠显示名称推断。

本实现从**当前广场origin**的既有 `sessionStorage` 或 `localStorage` 指定单一键读取原始token字符串。只在主动点击时读取，不扫描存储、不写回、不读取用户JSON/父页面存储/URL凭证，也不要求用户粘贴token。存储为空、不可访问或格式不符时明确失败。

门户截图中的 `sky-token` 属于 `https://192.168.5.143:17090`；已有广场部署说明使用 `http://192.168.2.145:16090`。两者不同origin，截图不能证明广场可读取门户存储。需要核实实际入口是否与门户同源挂载，或是否有现成跨域桥接；未核实的部署保持关闭。当前实现不虚构父页面消息契约，不替部署者迁移门户令牌。

2026-10-26匿名读取门户公开前端后已核实：主包 `/web/design-portal-web/assets/index-pQfoMoY7.js` 的普通浏览器分支直接从localStorage读取 `sky-token`，没有JSON/TTL/加密包装。因此Chrome/Edge可在同origin部署后显式配置 `localStorage` + `sky-token`。Zoe专用浏览器另走Cef存储，本实现没有验证或适配该宿主。

现有 `/web/design-portal-web/assets/iframe-adapter-Bij5jdvO.js` 的初始化机制传递globalStates，已找到用户资料写入，未找到token写入或转交证据；该机制还使用通配消息目标，缺少本接入所需的来源/窗口/请求关联校验，不能直接作为凭证桥。公开资源代码研究不等于已取得登录后的真实菜单配置或完成门户联调。

如确认同源挂载可复用既有存储，再配置以下字段。如实际必须跨域传入，先确认现有消息协议或最小门户改动，再补适配；不能通过放开来源校验绕过同源限制。无需重复索取已取得的findByToken接口文档。

同源挂载还需由门户部署方验证路径及API路由不冲突：当前广场使用根路径 `/api/*`，伏羲接入使用固定 `/auth/tiangong`。不能仅改Manifest URL，就把不同origin的现有独立广场当成同源应用。

## 固定配置

| 字段 | 用途 |
| --- | --- |
| `PLAZA_FUXI_APP_ID` | 已收录伏羲应用UUID，不按名称或Manifest自报标记匹配 |
| `PLAZA_FUXI_ENTRY_ID` | 固定Web入口ID，卡片和详情使用同一策略 |
| `PLAZA_FUXI_ENABLED` | 显式 `1` 启用，`0` 停用；绑定保留时停止新交接 |
| `PLAZA_FUXI_ORIGIN` | 固定完整origin，无路径、查询、片段或凭据；路径固定 `/auth/tiangong` |
| `PLAZA_FUXI_CREDENTIAL_STORAGE` | `sessionStorage` 或 `localStorage`，不猜默认来源 |
| `PLAZA_FUXI_CREDENTIAL_KEY` | 当前origin中已确认的原始token键名，不是token值 |
| `PLAZA_FUXI_ALLOW_INTRANET_HTTP` | 显式 `1` 才接受RFC1918字面IPv4内网HTTP |

HTTPS可直接配置，回环HTTP只在本地模式接受；非本地模式拒绝回环测试目标。公网HTTP、通配目标、IP别名、URL用户密码及任意路径均拒绝。不完整启用配置在启动时失败，错误不回显配置值。内网HTTP不提供链路加密；开关不改变原有PUBLIC_ORIGIN、Host/Origin和跨站限制。

浏览器从同源 `GET /api/entry-policies` 读取不含凭证的固定策略，响应 `Cache-Control: no-store`。策略来自维护者服务配置，Manifest及查询参数不能选择凭证接收方。未取得策略时入口暂不可用，不绕过接入打开原URL。

伏羲将实际广场origin加入 `TIANGONG_ALLOWED_ORIGINS`，自身origin、门户查询地址和成功码由伏羲服务端配置。文档7090接口的成功包装码 `00000000` 已由伏羲侧无效合成凭证探测取得；空身份不代表真实用户登录通过。广场不直接访问7090接口。

## 消息交接

1. 用户点击卡片或详情，广场读取指定既有token，打开固定伏羲 `/auth/tiangong`，仅此入口保留opener。其他Web外链继续 `noopener noreferrer`。
2. 伏羲在自身后端创建Cookie绑定的短时一次性请求，向允许的广场origin发送 `{ type: 'fuxi:tiangong:ready', requestId }`。
3. 广场同时核对精确event.origin、本次窗口event.source、消息类型和有界requestId；重新向广场服务读取策略，确认绑定仍启用、接收方和凭证来源均未改变。
4. 广场向本次窗口的精确伏羲origin发送一次 `{ type: 'fuxi:tiangong:login', requestId, token }`，清除持有凭证和监听器。重复消息不能再次交接，不用通配targetOrigin。
5. 伏羲自行同源兑换及验证。广场发送完成不等于登录成功；身份错误与切换确认由伏羲接收页显示，不自动访客登录。

凭证最多8192字符，拒绝空白和控制字符；不进入URL、广场HTTP请求、日志、埋点或新增持久化。弹窗拦截、关闭、15秒超时或配置重检失败均提示并清理。连续点击取消前一次未完成交接，卸载页面也取消；已完成交接的页面由伏羲管理。

## 回退

保留固定应用及入口ID，将 `PLAZA_FUXI_ENABLED=0` 后重启广场。新交接停止；旧页面在交接前重新读取开关，也会拒绝。不要通过删除绑定恢复未经核实的Manifest外链。其他应用和目录数据不变，已有伏羲会话按伏羲自身规则结束。

## 本地复核

常规验证为 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`。定向协议验证为 `node --import tsx --test tests/fuxi-entry.test.ts`。

联合测试额外需要伏羲本地候选树，包含支持外部回环origin的 `backend/tests/fixtures/tiangong-browser-server.js` 及构建好的 `frontend/dist`。广场不复制或修改伏羲源码。PowerShell示例：

```powershell
$env:PLAZA_FUXI_FIXTURE_ROOT='D:\_projects\platform\FuxiPlatform\.worktrees\111-codex-tiangong-login'
npm run test:fuxi-entry:browser
$env:PLAYWRIGHT_CHANNEL='msedge'
npm run test:fuxi-entry:browser
```

脚本运行真实广场API/页面，自行启动隔离伏羲服务，只允许回环地址，使用临时库、模拟门户和合成甲/乙/无效/停用/mock身份。覆盖卡片/详情、身份切换、失败保留会话、普通外链、未点击零凭证读取、旧页停用重检及Network/存储/运行日志检查。fixture输出中的合成token契约排除在运行日志泄露检查之外，其他日志不得出现凭证。证据在忽略的 `artifacts/fuxi-entry/<channel>/`；标准输入 `stop` 结束fixture，不访问实际门户或真实伏羲实例。

本地模拟通过不等于真实门户接通、真实账号上传/归属验收或AI Host接入。真实来源、两名有效天宫用户和两端部署仍需分别验证。
