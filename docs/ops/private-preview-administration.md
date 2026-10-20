# 私有预览只读管理

按用户于2026-10-20的明确决定，管理预览改为直接启用、免密码查看，变更见 #64；#53 的原验收记录保留为历史。此页面不建立发布者身份与应用归属体系，#37 仍按原门禁推进。

## 访问

连续点击广场 Logo 三次（相邻两击间隔不超过1.5秒），或直接访问 `/private-previews`。打开后直接读取列表，无密码输入、登录、退出或会话有效期，也无需启用开关。所有能访问门户的人均可查看全部作者未确认快照；三击 Logo 只是入口，不能限制访问。

`PLAZA_PREVIEW_ADMIN_PASSWORD` 和 `ALLOW_INSECURE_PREVIEW_ADMIN` 已不再使用，旧配置不会建立密码保护。部署环境的网络范围及门户既有 HTTPS/显式可信内网 HTTP、Host、Origin 校验继续适用。

## 读取与限频

每条管理读取 API 按客户端每分钟最多120次限频，与公共默认桶分开。默认使用直连 socket IP，忽略客户端转发头。

若设置 `PLAZA_PREVIEW_ADMIN_PROXY_IP`，必须是代理的单一数值IP；该代理须覆盖客户端输入的 `X-Real-IP`。管理 API 只接受来自该代理连接、带单个有效IP头的请求，并按该IP限频；缺失、重复或伪造来源均拒绝。此配置只校验代理来源和限频身份，不是用户登录或员工访问白名单。

## 内容与只读边界

列表覆盖 `checking`、`preview_ready`、`failed` 且 `confirmed_at IS NULL` 的发布，包含所有作者；已收录、已取消及已经确认的记录不进入列表。过期状态单独显示，不延长作者原链接有效期。

可按应用名称、appKey、维护人搜索，按状态筛选，按上传时间倒序分页，每页20项。详情读取已有预览快照中的 manifest、共享文档与固定来源信息，不重新访问 GitLab，不清除过期授权。

管理 API 只执行 SELECT，不返回作者 ticket、确认摘要、actor/idempotency 信息或加密 GitLab 凭据。页面不提供确认、重试、恢复、取消、删除或批量操作。作者确认收录仍使用原有效私有链接及作者凭证。

## 接口与验证

- `GET /api/preview-admin/publications`：query、status、page；返回列表与计数。
- `GET /api/preview-admin/publications/:id`：未确认发布的完整只读预览。
- 原 `/api/preview-admin/session` 已移除；GET、POST、DELETE 均不再提供管理会话。

管理响应使用 no-store、same-origin 资源策略和 noindex。读取失败时页面清除失效列表、统计或详情，允许重新加载。

本地回归使用受控 GitLab 协议服务和 PGlite，不读取生产私有发布。验证免Cookie访问、移除会话端点、Host/Origin和代理来源、限频、分页筛选、字段投影与七张业务表前后相等；浏览器验证三击入口、直达查看、详情、返回、错误恢复及天宫蓝主按钮。真实部署和人工验收分别记录。
