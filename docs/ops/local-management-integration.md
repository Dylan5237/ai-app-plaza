# 后台本地集成与内网管理

本地集成复用 [#65](https://github.com/Dylan5237/ai-app-plaza/issues/65) 的集中后台入口，并按 [#66](https://github.com/Dylan5237/ai-app-plaza/issues/66) 补齐上下架、回收恢复和手动修改详情。详情、更新提示词及预览确认/重试继续共用原有组件与服务。本页也说明如何在受信任的 RFC1918 内网部署启用这些管理接口；代码交付、线上部署和业务验收分别记录。

## 本机试用

构建后启动独立的本地试用服务：

```powershell
npm run build
npm run dev:management-local
```

打开 `http://127.0.0.1:9442/admin`。可通过 `npm run dev:management-local -- --port 9443` 使用其他空闲端口；不会停止占用端口的进程。

启动脚本只使用内存 PGlite 和回环 GitLab 协议 fixture，不读取真实 `.env`，不连接公司 GitLab。关闭再启动会重新生成合成资料：

- 已收录文档助手 1.0.0，以及经本地托管上传得到的 1.1.0 更新预览。
- 经本地托管上传、等待首次收录的应用。
- 已收录的 Web 示例，使用地址为 example.invalid。
- 一条固定的合成 prepared 占位，用于检查未就绪展示；没有任务继续推进它，不会自动完成。

首次发布和更新可在“待收录与更新”打开原预览并确认。确认实际修改本地数据库，广场刷新后展示新内容。占位缺少完整资料时不能确认收录。Web 示例不代表真实部署，Agent 说明不代表安装已执行。

## 复用与接口

`ToolDirectory.vue` 同时承载前台和后台的详情、来源、完整资料、Agent 说明、更新提示词和发布预览；管理列表只调用同一组件的入口。确认与重试委托同一个 service 核心，继续校验发布 revision/digest、固定来源、版本和目录竞争，不生成或返回作者 ticket。原作者专属链接仍兼容。

待确认查询复用原只读管理 reader；后台可包含已确认但失败的可重试记录，不将目录 revision 当作 publication revision。未形成 publication 的托管占位只查询安全字段。返回列表会保留视图、搜索、筛选和页码；过期预览只可读，快速切换忽略旧请求。

新增接口：`GET /api/management/publications`，对应详情和 `POST .../confirm` / `POST .../retry`，以及 `GET /api/management/uploads`。旧 `/private-previews` 跳转 `/admin`；广场保留首次分享和使用，移除作者更新入口。

## 管理模式

本地试用使用显式 `PLAZA_LOCAL_MANAGEMENT=1`，同时 `PLAZA_LOCAL=1`，HOST/PUBLIC_ORIGIN 必须是同端口 `127.0.0.1`。本地模式仍禁止在 `NODE_ENV=production` 启用。

内网部署须显式设置 `PLAZA_INTRANET_MANAGEMENT=1`，移除 `PLAZA_LOCAL=1`，并将 `PUBLIC_ORIGIN` 设置为同端口的 RFC1918 IPv4 字面地址（10/8、172.16/12 或 192.168/16）。例如：

```dotenv
PLAZA_INTRANET_MANAGEMENT=1
HOST=0.0.0.0
PORT=16090
PUBLIC_ORIGIN=http://192.168.2.145:16090
ALLOW_INSECURE_PORTAL=1
DATABASE_URL=postgresql://<部署配置的数据库连接>
PLAZA_SECRET=<至少 32 字符的持久随机密钥>
```

使用 HTTPS 时，`PUBLIC_ORIGIN` 可为私网 IPv4 的 HTTPS 地址；端口仍须与 `PORT` 的有效端口一致，HTTP 才需要 `ALLOW_INSECURE_PORTAL=1`。非本地服务仍须配置外部 PostgreSQL、持久密钥、GitLab 地址，以及启用托管发布时所需的固定群组和服务端授权。

内网模式不要求账号、密码、IP 白名单或审批。所有能访问门户的人都能使用后台管理应用和发布记录，因此网络部署必须限制在受信任的内网范围。管理 API 默认不注册；启用时继续执行 Host、Origin 和跨站请求校验，复用现有服务与托管 GitLab 授权。不得同时启用 `PLAZA_LOCAL_MANAGEMENT` 与 `PLAZA_INTRANET_MANAGEMENT`。

数据库增加独立的应用状态表及托管发布 operation_kind 字段。试用脚本自动使用隔离内存库，不操作真实应用或公司 GitLab。

## 基础管理

- 新增应用复用原首次发布提示词，资料就绪后进入原收录预览。
- 下架后，广场列表、标签、详情、说明和发布规范的公开地址均不可访问；后台可查看、修改或发布新版本。确认内容更新会保留下架状态。
- 删除移入回收站，保留源码、版本和发布记录；恢复后保持下架，需另行上架。删除期间不允许内容更新确认。
- 状态 revision 与已收录内容 revision 分开检查，过时列表的操作被拒绝；状态变化不伪装成源码版本变化。
- “修改”预填现有资料，可编辑名称、简介、标签、作者、能力、示例、条件限制、入口信息和原共享 Markdown。应用身份、源码项目及文档路径保持原值。
- 保存资料会以当前已收录固定 commit 为父，仅修订 manifest 与现有声明文档，保留其余文件，创建更高版本的 commit/tag/Release 后打开原预览。确认前已收录详情保持原版；确认后同一应用更新。
- 仅统一托管且受服务器群组授权覆盖的来源可直接编辑；其余来源明确显示原因，可继续用原发布新版本流程。服务器令牌和作者发布凭证不会返回网页。
- 保存响应不确定时锁定草稿，使用原 UUID 和原内容恢复；同键重放不重复写 GitLab。

管理 API 增加 `GET /api/management/apps?status=all|published|offline|deleted`、应用详情/说明/发布规范、`POST /api/management/apps/:id/lifecycle` 及 `GET/POST /api/management/apps/:id/editor`。`status=all` 指应用管理中的上架与下架记录；删除记录仅由回收站的 `status=deleted` 查询返回。生命周期请求包含 action、expectedAppRevision 和 expectedLifecycleRevision；编辑请求包含 expectedAppRevision、manifest、documents，使用 Idempotency-Key。所有管理 API 仍受上述本地门禁限制。

## 验证边界

本地试用只操作隔离的 GitLab 协议 fixture 和本地数据库。任何真实 GitLab/Host 操作、内网部署和业务验收均须分别记录，不由本地验证自动代表。

执行 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`、`npm run test:docs`。浏览器用合成 GitLab/PGlite 检查流程复用、首次收录、失败重试、旧版保持、过期禁用、预览竞态、上下架与回收恢复、资料写回与源码保留、丢失响应恢复和移动端。测试通过不代表生产或业务验收完成。
