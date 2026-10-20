# 后台本地集成

本候选按 [#65](https://github.com/Dylan5237/ai-app-plaza/issues/65) 将管理和更新入口集中到 `/admin`，复用现有详情、更新提示词、预览及确认/重试。它不代表线上更新或完整后台验收。

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

## 启用范围

管理写入要求显式 `PLAZA_LOCAL_MANAGEMENT=1`，同时 `PLAZA_LOCAL=1`，HOST/PUBLIC_ORIGIN 必须是同端口 `127.0.0.1`。生产或非本地配置拒绝启用。默认不注册 `/api/management/*`，Host/Origin 及跨站校验继续生效。这是本地候选边界，不是生产管理员身份方案。

不改数据库 schema，不执行应用代码，不操作真实应用或公司 GitLab。试用脚本自动使用上述隔离配置。

## 尚未实现与验证

现有服务没有手动编辑详情后回写 GitLab、删除和上下架的接口。这些需求没有用直接改已收录快照或模拟成功代替，本轮不宣称完整增删改查已交付。真实 GitLab/Host、生产管理员策略、部署和业务验收均未完成。

执行 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`、`npm run test:docs`。浏览器用合成 GitLab/PGlite 检查流程复用、首次收录、失败重试、旧版保持、过期禁用、预览竞态和移动端。测试通过不代表生产或业务验收完成。
