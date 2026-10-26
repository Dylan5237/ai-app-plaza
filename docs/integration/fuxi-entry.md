# 从广场进入伏羲

本接入只负责伏羲入口和天宫凭证交接。广场保持匿名目录，不保存用户库、不解析用户角色，不调用跨域身份兑换接口。伏羲验证门户凭证、建立或查找账号映射并管理自身会话。对应需求为 [#78](https://github.com/Dylan5237/ai-app-plaza/issues/78)，伏羲接收方合同为 [#111](https://github.com/Dylan5237/prototype-manager/issues/111)。

## 部署前核实来源

默认没有受控入口配置，现有应用继续原外链行为。配置固定应用UUID及入口ID后，该入口由受控策略管理；停用时明确提示，不静默打开Manifest原URL。

策略只绑定指定entry ID。同一应用的其他Web入口仍是普通外链，不会取得门户凭证；需要受控接入的入口应明确配置，不能靠显示名称推断。

本实现从**当前广场origin**的既有 `sessionStorage` 或 `localStorage` 指定单一键读取原始token字符串。只在主动点击时读取，不扫描存储、不写回、不读取用户JSON/父页面存储/URL凭证，也不要求用户粘贴token。存储为空、不可访问或格式不符时明确失败。

门户 `sky-token` 属于 `https://192.168.5.143:17090`；用户确认独立广场为 `http://192.168.2.145:16090`。两者不同origin，广场不能直接读取门户存储。原目录接入继续保持默认关闭；本期另外提供下文的专用测试桥，不接受旧全局状态消息或URL凭证。

2026-10-26匿名读取门户公开前端后已核实：主包 `/web/design-portal-web/assets/index-pQfoMoY7.js` 的普通浏览器分支直接从localStorage读取 `sky-token`，没有JSON/TTL/加密包装。因此Chrome/Edge可在同origin部署后显式配置 `localStorage` + `sky-token`。Zoe专用浏览器另走Cef存储，本实现没有验证或适配该宿主。

现有 `/web/design-portal-web/assets/iframe-adapter-Bij5jdvO.js` 的初始化机制传递globalStates，已找到用户资料写入，未找到token写入或转交证据；该机制还使用通配消息目标，缺少本接入所需的来源/窗口/请求关联校验，不能直接作为凭证桥。公开资源代码研究不等于已取得登录后的真实菜单配置或完成门户联调。

如确认同源挂载可复用既有存储，再配置以下原目录入口字段。当前两个实际地址之间的验证，使用下文独立测试profile和明确的消息桥；不能放开来源校验绕过同源限制，也无需重复索取已取得的findByToken文档。

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

联合测试默认采用门户普通浏览器实际使用的localStorage方式；设置 `PLAZA_FUXI_TEST_STORAGE=sessionStorage` 可单独验证另一个显式配置的存储方式。这仅选择合成测试上下文，不会读取真实门户存储。

本地模拟通过不等于真实门户接通、真实账号上传/归属验收或AI Host接入。真实来源、两名有效天宫用户和两端部署仍需分别验证。

## 不改正式卡片的跨域测试桥

用户已确认本地实现及GitHub交付范围，见 [#79](https://github.com/Dylan5237/ai-app-plaza/issues/79)。16090/17090实际发布仍待具体维护路径、验证和备份齐备后确认；16088及真实目录记录保持。

测试页面固定为 `/integration/fuxi-test`，只读取 `/api/integration/fuxi-test/config`。它不修改 `/api/entry-policies` 默认行为，不按URL参数选择接收方，也不修改现有appId `2b549391-93c5-4335-9c87-dd5677e59d3f` 的 `platform-web` 正式16088入口。测试路径是环境提示，不是身份或权限证明。

维护者可为该独立profile准备以下配置，未获发布确认时不要写入线上：

```text
PLAZA_FUXI_TEST_ENABLED=1
PLAZA_FUXI_TEST_ORIGIN=http://192.168.2.145:16077
PLAZA_FUXI_TEST_PORTAL_ORIGIN=https://192.168.5.143:17090
PLAZA_FUXI_TEST_ALLOW_INTRANET_HTTP=1
```

默认关闭。非本地模式的伏羲测试目标必须与广场同主机且端口为16077，拒绝16088；门户须HTTPS。HTTP测试目标仍需显式内网开关，固定RFC1918字面地址限制继续有效。本地回环模拟允许随机端口，不得把回环目标配置到非本地环境。

门户侧仅准备两个独立静态资产：

- `ops/integration/tiangong-test/fuxi-entry-test.html`
- `ops/integration/tiangong-test/fuxi-entry-test-bridge.js`

发布候选地址为 `https://192.168.5.143:17090/web/design-portal-web/fuxi-entry-test.html`，但实际静态资源目录必须由门户维护者核对，不能猜路径或覆盖已有主包。HTML仅加载同目录外部模块，无内联凭证/脚本；脚本中的门户、广场origin是固定值，不读取URL覆盖。现有CSP、COOP和浏览器策略仍须核验，禁止降低全站安全头。两个文件均为本仓可审查源码，尚不意味着已上传门户。

用户正常登录天宫后打开该同origin测试页，点击按钮创建固定16090测试窗口。门户仅为此窗口保留120秒、一次性的授权；打开页面和按钮本身都不读token。用户再在广场点击进入伏羲，广场先收到固定伏羲窗口的ready并重检开关，然后向原门户opener发送：

```js
{ type: 'plaza:tiangong:credential-request', requestId: '<32字节随机值的64位hex>', purpose: 'fuxi-test' }
```

门户同时核对精确广场origin、自己打开的窗口、用途、格式及未过期授权；先消费授权，再读取一次自身localStorage的 `sky-token`，回给精确广场origin：

```js
{ type: 'plaza:tiangong:credential-result', requestId: '<原值>', token: '<仅内存交接>' }
// 无凭证只返回固定错误，不包含用户JSON或异常原文
{ type: 'plaza:tiangong:credential-result', requestId: '<原值>', error: 'NO_PORTAL_CREDENTIAL' }
```

广场核对原门户opener、精确portalOrigin及本次随机值，只接受一次结果。凭证到达后再次读取测试开关及固定目标，才沿既有伏羲协议发送；随后清除凭证、监听和计时器。旧请求、重复消息、来源/窗口错误、关闭、取消、超时、缺失opener或配置变化均拒绝，不退回访客账号或手工粘贴token。HTTP页面用 `crypto.getRandomValues` 生成关联值，不依赖仅安全上下文可用的randomUUID。

HTTPS门户打开HTTP顶层测试窗口不属于嵌入HTTP iframe的混合内容；本期不使用HTTP iframe。仍需在实际浏览器验证opener可用。COOP切断窗口关系时明确报错；本地负向测试不得关闭该头来伪造通过。[浏览器混合内容说明](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)、[跨窗口消息校验](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)。

新桥独立回归：

```powershell
node --import tsx --test tests/fuxi-entry.test.ts tests/tiangong-credential.test.ts
$env:PLAZA_FUXI_FIXTURE_ROOT='D:\_projects\platform\FuxiPlatform\.worktrees\111-codex-tiangong-login'
$env:PLAYWRIGHT_CHANNEL='chrome'
npm run test:tiangong-bridge:browser
$env:PLAYWRIGHT_CHANNEL='msedge'
npm run test:tiangong-bridge:browser
```

浏览器测试使用本机临时TLS证书的合成HTTPS门户、HTTP广场及伏羲隔离服务，网络限回环。仅测试上下文允许该合成证书；不访问真实门户或复用真实token。覆盖完整三方链、一次授权、账号隔离、COOP缺opener、过期、最终开关重检、原正式链接及泄露检查。结果在忽略的 `artifacts/fuxi-test-bridge/`。两个静态资产需随部署申请单独列出摘要及回退方式；不要把共享广场首次安装器当成现有服务更新器。
