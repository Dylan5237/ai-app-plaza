# 从广场进入伏羲

2026-11-04 起，伏羲入口恢复为 Manifest 普通 Web 外链：卡片和详情直接打开作者登记的 URL（新标签页，`noopener noreferrer`）。广场不读取、转发或持有天宫凭据，也不提供入口策略端点。

天宫免登录由伏羲与门户负责：门户 origin 下的 `/fuxi/`（测试）和 `/fuxi-prod/`（生产）同源挂载伏羲，伏羲前端读取同源 `sky-token`，经后端一次性兑换建立伏羲会话。合同见伏羲仓 [`docs/TIANGONG_LOGIN_INTEGRATION.md`](https://github.com/Dylan5237/prototype-manager/blob/main/docs/TIANGONG_LOGIN_INTEGRATION.md)。

已移除（2026-11-04）：`/api/entry-policies`、`/api/integration/fuxi-test/config`、`/integration/fuxi-test`、widget / portal-parent / 消息桥、`tiangong-*` 门户静态候选及相关测试。保留 `PLAZA_HTTPS_ORIGIN` 受控 HTTPS 入口。

## 受控 HTTPS 入口

`PLAZA_HTTPS_ORIGIN` 仍为可选能力（见 [#90](https://github.com/Dylan5237/ai-app-plaza/issues/90)）：必须是 `PUBLIC_ORIGIN` 同一私网 IPv4、HTTPS、独立端口；只接受来自回环网关且 Host/Origin 精确匹配的连接，网关须覆盖 `X-Real-IP`；规范发布地址、MCP 和回执继续使用 `PUBLIC_ORIGIN`。未配置时行为完全不变。

回退：恢复本文件对应提交即可恢复旧桥接源码。门户服务器上已发布的旧静态文件不由本仓库管理。
