# 广场按钮与天宫认证分离：本地候选

2026-11-03：本地方案及隔离验证完成，未推送、合并、部署或替换门户。现有线上 `portal-widget` 免登录保持。本文不是正式发布授权或生产验收结论。

## 结论与责任边界

按钮的文案、样式、尺寸和卡片布局全部由广场维护。天宫同源中转页只运行稳定的认证桥，不包含可见按钮、按钮 CSS 或按钮文案。伏羲沿用既有认证窗口、后端身份核验和已审计的旧账号关联。

```text
用户点击广场通用按钮
  → 天宫同源祖先页的认证桥（读取天宫登录状态）
  → 固定伏羲认证窗口（核验身份，进入同一旧账号）

广场只发送入口请求和策略确认，不接收 token 或用户资料。
```

| 所有者 | 负责内容 | 改按钮外观时是否发布 |
| --- | --- | --- |
| 广场 | `PlatformOpenButton`、内容、CSS、卡片和详情入口 | 是，只发布广场 |
| 天宫同源中转页 | 固定来源、一次点击授权、打开伏羲窗口、凭据交接 | 否 |
| 伏羲 | 请求创建/兑换、上游核验、身份映射、原密码及原资产 | 否 |

这是展示与认证职责的分离，仍保留必要的认证集成关系。首次迁移需要安装新的认证桥；以后改变信任来源或认证协议仍需协调，不能承诺天宫文件永远不变。

## 为什么使用祖先页

原方案把可见按钮放在天宫同源的子 iframe 内，导致改按钮要同步天宫。共享源码并生成两份静态资产只能减少重复编辑，不能消除发布依赖，因此未采用先前候选 `6d7c176`。

另一个隐藏子 iframe 方案也不能靠普通消息保持一次点击打开新窗口：用户激活会通知祖先窗口，而跨源后代不在同一传播范围内。[HTML Standard](https://html.spec.whatwg.org/multipage/interaction.html#activation-notification) 规定了这一差别；Chrome、Edge 的隔离实测与之相符。

新的窗口关系为：天宫顶层 → 天宫同源中转页 → 跨源广场。广场按钮被真实点击后，祖先中转页具有用户激活，可打开固定伏羲窗口。中转页处于天宫第一方上下文，不需要为天宫后代 iframe 申请 Storage Access 权限。后者仅是本结构下 Chrome、Edge 的验证结果，不推广到未测试宿主或浏览器。

## 固定配置与文件

新增显式模式 `portal-parent`。默认和现有模式保持，未配置不会自行迁移。关闭示意：

```dotenv
PLAZA_FUXI_APP_ID=<现有固定应用 UUID>
PLAZA_FUXI_ENTRY_ID=<现有固定 Web 入口 ID>
PLAZA_FUXI_ENABLED=0
PLAZA_FUXI_MODE=portal-parent
PLAZA_FUXI_ORIGIN=https://fuxi.example.invalid
PLAZA_FUXI_PORTAL_ORIGIN=https://portal.example.invalid
```

不得与 `PLAZA_FUXI_WIDGET_URL`、`PLAZA_FUXI_CREDENTIAL_STORAGE`、`PLAZA_FUXI_CREDENTIAL_KEY` 混配。正式来源必须 HTTPS；HTTP 回环仅用于隔离夹具。存在 `PLAZA_HTTPS_ORIGIN` 时，本模式绑定 HTTPS 入口，原 HTTP 目录及 MCP 地址保持原配置，不向 HTTP 入口返回这项认证策略。

候选文件：

- `ops/integration/tiangong-bridge/fuxi-plaza.html`：稳定全屏中转页，只有一个固定广场 iframe。
- `ops/integration/tiangong-bridge/portal-auth-bridge.js`：无展示内容的认证桥。
- `ops/integration/tiangong-bridge/fuxi-plaza.css`：中转页全屏布局，未放入按钮样式。

认证桥复用同目录固定的 `fuxi-widget-test-policy.json`，字段仍为 `enabled`、`portalOrigin`、`plazaOrigin`、`fuxiOrigin`、`appId`、`entryId`。文件名沿用既有合同，内容是固定的服务配置，不接受 URL 或目录资料覆盖。

## 消息合同 v1

广场和天宫之间的每条入口消息携带 `version:1`、固定 `appId` / `entryId`、32 字节随机值的 64 位十六进制 `requestId`，仅使用精确 `targetOrigin`。同时核对来源和实际窗口对象；详见 [postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)。

| 顺序 | 消息 | 用途 |
| --- | --- | --- |
| 1 | 广场 → 天宫 `fuxi:portal:hello` | 发现当前父窗口中的桥 |
| 2 | 天宫 → 广场 `fuxi:portal:ready` | 回显发现请求；不读登录状态 |
| 3 | 真实点击：广场 → 天宫 `fuxi:portal:launch` | 发送随机入口请求，不传用户、token 或目标 URL |
| 4 | 天宫打开固定 `/auth/tiangong`；伏羲 → 天宫 `fuxi:tiangong:ready` | 沿用伏羲 Cookie 绑定的一次性请求 |
| 5 | 天宫 → 广场 `fuxi:portal:policy-check` | 附新的随机 `policyRequestId`，要求重新读取广场服务策略 |
| 6 | 广场 → 天宫 `fuxi:portal:policy-result` | 只回 `enabled` 布尔值及对应请求值 |
| 7 | 天宫重读固定门户策略，消费点击授权后 → 固定伏羲窗口 `fuxi:tiangong:login` | 沿既有格式交接一次凭据 |

天宫从既有 `localStorage` 的单个 `sky-token` 键读取一次，凭据只发送给本次打开的固定伏羲窗口。广场只可能收到固定状态码，不持有窗口或身份凭据。认证请求的过期、重放、身份核验及账号选择继续由伏羲负责。

天宫同时只保留一个待处理窗口。请求过期、替换、窗口关闭、页面卸载、策略关闭、固定值变化、网络失败和迟到异步回调均不会复用旧授权；广场销毁客户端会发送取消消息。入口有效期 120 秒、策略确认等待 5 秒；门户策略网络读取最多 5 秒。开关影响新的交接，不注销已有伏羲会话。

## 已验证与未验证

本轮使用本机隔离广场、真实伏羲接收端代码、临时数据库与文件目录，天宫核验接口和身份全部合成。伏羲夹具代码为 `2fe1a344`，其 `backend/` 和 `frontend/src/` 与已合并的 `73a5b20d` 无差异；没有修改伏羲或配套 Skill。

- 协议、配置及双入口检查通过：新模式绑定 HTTPS、HTTP 不返回该策略、两端开关重检、来源/窗口/随机值校验、一次性交接及迟到回调失效。
- Chrome 与 Edge 均使用全新浏览器上下文，未预存伏羲登录态，保留正常弹窗限制并启用存储分区，没有预授 Storage Access 权限。
- 一次点击实际进入同一合成旧账号；原密码仍登录同一账号，原项目、原型及两个版本的数据库记录可读。详情入口、重复进入、取消切换其他身份、无效身份拒绝和普通平台外链均通过。
- 广场网络、消息和存储中未发现合成天宫凭据。
- 只修改广场共享按钮文案及水平间距并重新构建，得到 UI v2；天宫三个桥接文件摘要逐个不变。Chrome、Edge 再用全新伏羲上下文均免登录成功。恢复文案/样式后重建，首页摘要与原 UI v1 相同。

浏览器联合检查共 4 轮、36 项，协议、配置和双入口最终检查 40/40 通过；类型检查及生产前端构建通过。界面截图中的应用、作者和账号均是合成数据。

这些结果证明本地可行及外观变化的发布独立性；未验证真实正式 HTTPS、公司浏览器管理策略、真实天宫登录、现有生产部署包运行或完整预览/历史页面。不得把隔离记录校验写成正式业务验收，也不据此改动线上。

双仓评估：只修改广场展示、策略投影和天宫静态适配；伏羲 API、MCP 工具、Skill 入口、分发 ZIP、运行时 profile 与既有验收路径均未改动。因此伏羲平台及配套 Skill 无需源码或版本更新。

## 将来实施所需的一次适配

以下仅是后续范围说明，尚未执行：

1. 按固定提交审查/合并广场候选，准备既有服务的可回退更新。
2. 天宫中转页首次加载稳定认证模块，新增 JS 文件；对中转页精确响应增加 `script-src 'self'` 与 `connect-src 'self'`，保留准确的 `frame-src` 和 `frame-ancestors 'self'`。使用正确 MIME、no-store，不降低全站 CSP。
3. 复用现有固定门户 JSON 和原允许来源；新广场模式需要清除旧模式的 widget URL，切换精确模式与门户来源。不会修改账号、密码、权限、绑定、证书或网关。
4. 在受控验证后切换；普通按钮样式后续只发广场。实际版本、缓存、CSP、COOP 及 iframe 层级仍需按真实响应确认。

当前中转 HTML 特意保留旧 `storage-access` allow 项，以便恢复旧模式；新模式没有使用该权限。旧 widget 代码暂保留用于回退，不能在同一入口同时挂两套认证控制器。

失败时先停用新的交接，再恢复先前广场版本/配置及中转页；保留旧 widget 资产和原数据。该修改不涉及业务库迁移，不能通过恢复旧全库来回退按钮或入口，避免覆盖上线后新数据。所有正式执行均需后续明确授权。

## 复现

```powershell
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/portal-parent-entry.test.ts tests/tiangong-widget.test.ts tests/fuxi-entry.test.ts tests/config.test.ts tests/https-origin.test.ts
npm run build
$env:PLAZA_FUXI_FIXTURE_ROOT='<具有依赖与已构建前端的伏羲夹具源码目录>'
$env:PLAZA_BRIDGE_REPORT_DIR='<新的本地证据目录>'
node --import tsx tests/portal-parent-browser.ts
```

浏览器测试需要本机 Chrome 与 Edge，所有服务只监听回环。测试会临时修改两份广场 UI 源文件、构建 UI v2、恢复并重建 v1；请只在任务专用 worktree 执行。测试进程会关闭自己启动的浏览器和服务。

## 架构判断记录

- route：`ARCH_DESIGN / DP-001 / overlays:none`；依据是验证展示与认证分离能力，保持已有登录合同。
- 已确认：产品约束来自用户；现有耦合来自源码；可行性和隔离行为来自本地协议/浏览器证据；激活传播规则来自 HTML Standard。
- 适用原则：展示变更不应跨部署单元传播。跨域身份信任仍要求固定来源与一次性授权。首次认证合同迁移合理地需要协同，不据此接受未来按钮外观仍要双边发布。
- 未决：真实环境响应头与公司终端策略尚未验证，属于后续上线范围；本地结论不依赖继续索取真实账号或凭据。
- terminal：`NO_DECISION_CHANGING_WORK`；stop reason 6：本地方案判断与 UI 独立变化实验已完成，无需继续增加同类检查。实现候选不等于正式验收或发布。
