# 能力标签整理与回滚

适用 [Phase #38](https://github.com/Dylan5237/ai-app-plaza/issues/38)。新发布和更新的 `ai-app.json` 最多含 3 个核心能力标签；生成资料前读取 `/api/tags` 或发布规范中的 `tagPolicy.existingTags`，优先复用已有名称。保留空数组的原有兼容行为，不要求凑足 3 个。同应用规范化后不能重复；与已有名称仅有大小写、全半角或空白差异时使用已有名称。

存量整理在 `catalog_tag_overrides` 中记录与固定快照绑定的目录标签、操作 ID、原因及时间。公开 API 的 `tags` 供列表、详情和筛选使用，`manifest.tags` 仍是作者在固定来源中的原文。原快照、文档、摘要、应用 ID、revision、软件版本、commit、tag 和发布记录不变；确认新版本后旧整理结果不覆盖新快照。其它消费目录的模块也应使用 `AppView.tags`。

## 操作计划

原公开目录、清洗计划和备份含实际应用资料，放在忽略的 `artifacts/` 或批准的备份目录，不提交到 Git。计划格式为：

```json
{
  "schemaVersion": 1,
  "operationId": "一次操作固定的 UUID",
  "audience": "已核对的目录可见范围",
  "entries": [{
    "appId": "已核对的应用 UUID",
    "appKey": "已核对的稳定应用标识",
    "expectedRevision": 1,
    "expectedCommitSha": "已核对的完整40位SHA",
    "expectedTags": ["当前有效标签"],
    "tags": ["目标核心能力标签"],
    "reason": "本应用的具体整理依据"
  }]
}
```

计划逐应用核对其真实用途，不能按原数组顺序截取前 3 个。工具按整批替换后的完整目录检查规范化名称，既校验批内应用，也校验未调整应用；可以整批合并已有变体，不能生成大小写、全半角或空白变体。执行与发布确认共用目录写锁，校验完成后才备份及写入。标签长度按 Unicode 码点计数，与资料契约及 Python 工具一致。含义不明确的映射先由负责人裁定；本工具不进行语义推测或扩展授权。

## 预览、执行与恢复

从服务相同的运行配置安全注入 `DATABASE_URL`，不把凭据放进参数、计划或输出。必须显式指定这一个环境变量或本地 `--database-path`，两者不能同时指定。

```bash
node --import tsx scripts/clean-catalog-tags.ts --plan <计划.json>
node --import tsx scripts/clean-catalog-tags.ts --plan <计划.json> --apply --backup <新的备份.json>
node --import tsx scripts/clean-catalog-tags.ts --rollback <原备份.json>
node --import tsx scripts/clean-catalog-tags.ts --rollback <原备份.json> --apply
```

默认只预览，不执行 schema 迁移或改数据；旧服务数据库也可以预览。实际清洗须先安装已验证服务版本的迁移，再取得本次对应环境和计划的执行授权。执行先锁定全部目标，核对 ID、appKey、revision、固定 commit 与原有效标签，保存带完整内容摘要的备份后再写入；任何目标漂移、备份失败或数据库错误都停止整批操作。保留原操作 ID 和备份重试，不能覆盖不同备份或把不确定结果当成全新操作。

回滚验证备份摘要、当前来源、清洗后的标签及操作身份。若出现后续更新或另一次整理，停止整批回滚；不覆盖后续数据。同一清洗或回滚重复执行返回已完成，保持原数据和回执。

执行后核对所有目标的公开标签、筛选结果和接入说明，并确认原始快照、版本与发布记录无变化。工具的 JSON 结果和进程退出码只是操作证据，服务上线和业务验收分别记录。
