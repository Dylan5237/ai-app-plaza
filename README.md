# AI应用广场

从工作目标出发，发现可用的 AI 应用：平台应用直接打开，其它应用通过提示词接入自己的 Agent。作者也通过 Agent 整理和发布应用，无需逐项填写资料。

当前是桌面交互原型，包含 **17 项完整 Mock 应用**：6 项平台工作台演示、11 项 Agent 接入示例。支持需求查询、作者标签筛选、收藏、详情与使用说明，以及“分享我的AI应用”的发布提示词、只读预览和结果反馈流程。

**尚未接入真实 GitLab、AI 检索、发布服务或应用安装。** Mock 资料与状态用于设计评审，不代表真实项目交付。

架构提案见[架构设计](docs/architecture/architecture.md)与[资料契约](docs/architecture/data-contract.md)。它们用于评审正式系统的边界和流程，尚未冻结；其中的技术建议不代表服务已经接通。

## 本地运行

需要 Node.js 20+、Python 3.10+（命令名 `python`）。在仓库根目录执行：

```powershell
npm ci
npm run dev
```

终端会给出浏览器地址。构建与交付预览：

```powershell
npm run build
npm run preview
```

静态交付目录是 `dist/`，入口为 `dist/index.html`，支持相对路径部署。生成过程只读取本仓库，不依赖旧会话目录、全局 Skill 或在线 CDN。

## 目录

| 路径 | 用途 |
| --- | --- |
| `prototype/` | 原型模板、交互脚本、Mock 资料与原始研究数据 |
| `src/` | Vue + Element Plus 承载页面 |
| `scripts/` | 数据合成与静态入口生成 |
| `tests/` | 应用详情、接入、平台演示及发布流程检查 |
| `docs/product/` | 能力边界与现有交互设计说明 |
| `docs/architecture/` | 架构提案、资料契约、Schema 与虚构结构样例 |
| `docs/ops/` | 初始化事实、待发布的控制面草稿 |
| `.fuxi/` | 原有 AdminSpec 和编译来源记录 |
| `archive/` | 旧任务完整本地归档，不入 Git |
| `artifacts/` | 迁移清单、验证报告与截图，不入 Git |

修改页面时编辑 `prototype/` 下的源文件。`generated/`、`public/portal.html` 和 `public/assets/lucide.js` 由构建生成，不作为源码维护。原始研究记录与 Mock 补充资料分开保存，生成时不回写研究记录。

## 交互验证

先运行 `npm run build`，再安装一次 Playwright Chromium：

```powershell
npx playwright install chromium
npm test
```

也可使用已安装的 Chrome（PowerShell：`$env:PLAYWRIGHT_CHANNEL='chrome'`），或通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指定浏览器。测试覆盖 1280×720、1024×768 两种桌面尺寸、17 项应用、复制提示词、平台示例报告、发布成功及收录失败重试；报告输出到 `artifacts/`。测试阻止并记录外部网络请求。

## 项目治理与状态

- 代码权威仓库：[Dylan5237/ai-app-plaza](https://github.com/Dylan5237/ai-app-plaza)，唯一写入远端 `origin`。
- 使用 [agent-project-ops](https://github.com/Dylan5237/agent-project-ops)，固定版本见 `.agent-project-ops/PIN`；入口为 `AGENTS.md`。
- 本地初始化、历史迁移与后续产品阶段分开记录。当前 GitHub 控制面和 Fleet 登记状态见 [初始化记录](docs/ops/initialization.md)。
- 新克隆先通过 Git Bash 执行 `bash .agent-project-ops/scripts/install-hooks.sh`；新产品阶段需在 GitHub 完成 Freeze。已授权任务提交后直接推送 `origin` 主题分支，授权边界见 `AGENTS.md`，合并、部署与验收另行处理。
- [能力边界](docs/product/capability-boundaries.md) · [交互设计说明](docs/product/prototype-design.md)

此前发布的原型：[伏羲平台 v1.8.0](http://192.168.2.145:16088/api/s/tU22pwVr)。本次迁移不触发平台重新发布；在线状态以平台实际内容为准。
