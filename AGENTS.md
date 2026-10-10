# ai-app-plaza — project operations binding

This repository is governed by the pinned `agent-project-ops` snapshot under `.agent-project-ops/`.

- Methodology: `https://github.com/Dylan5237/agent-project-ops`
- PIN: `21983f17eccae3beb844fa0fec3f7e7e1e10746e` (`main`, fetched 2026-10-10T06:01:18Z)
- Disposer: `@Dylan5237`
- Write authority remote: `origin`
- Projection remote: `(none)` (same-history FF only; not colleague GitLab)
- Colleague GitLab: `export=` remote or share-export snapshot via `.agent-project-ops/scripts/export-sync.sh` / `share-export.sh` — never `git push --mirror` from this clone; not a second write authority

## Always load first

Read `.agent-project-ops/PRINCIPLES.md`. Invariants win over convenience. Load the relevant skill wrapper under `.agents/skills/`; it points to the full pinned skill body.

Core rules:

1. Chat is not project state. Durable decisions/status belong on GitHub Issues/PRs/git objects.
2. Agent proposes; the named disposer freezes/Accepts/exceptions. PR merge is not Phase PASS.
3. `origin` (GitHub) is the only write authority. Projection remotes are same-history mirror/FF only. Colleague GitLab is export (`authority − strip list`) or share-export, not a projection and not a second SoT.
4. Unknown remotes fail closed. `.agent-project-ops/remotes` is the clone-portable registry.
5. Topic branches push to `origin` only. Never use a projection as a fallback when `origin` is unavailable. Never push this bound clone to colleague GitLab (export remotes are not on the auto-push whitelist).
6. One task, one worktree under `.worktrees/`; keep the primary checkout clean for sync/control work.
7. Do not copy business/domain SOP back into the methodology snapshot or upstream methodology repository.

## Before your first push in this clone

`git clone` does **not** inherit `core.hooksPath`.

Run:

```bash
git config --get core.hooksPath
```

It must print `.githooks`. If it is empty or different, run:

```bash
bash .agent-project-ops/scripts/install-hooks.sh
```

Then check `git remote -v` against `.agent-project-ops/remotes`. If an extra remote is unregistered, stop. If the registry names a projection that is not configured locally, restore/confirm it from the recorded project control plane before any projection operation.

A missing client hook is **not** permission to push `main`. The hook is bypassable; server-side repository policy remains the stronger control.

## Starting work

- No Command Center / first project setup: `.agent-project-ops/playbooks/start-project.md`
- New task: use `.agent-project-ops/scripts/new-worktree.sh` and the worktree playbook.
- Multiple remotes / same-history mirror / divergence: load `git-authority-and-projection` before any non-`origin` push.
- Colleague GitLab / business-files-only share: load `export-remote` or `share-export`; do not register that host as projection.
- Cannot verify an invariant or remote state: fail closed and record `BLOCKED:` on the active Issue.

## 本项目约定

- 当前为 AI应用广场桌面交互原型，17 项应用资料与流程为 Mock；不能把构建通过、模拟发布或接入提示词当作真实服务可用证据。
- 产品边界见 `docs/product/capability-boundaries.md`；初始化状态见 `docs/ops/initialization.md`。首次初始化迁入已有成果，后续新功能仍需 Phase Freeze。
- 可编辑原型源在 `prototype/`，Vue 承载在 `src/`，数据合成在 `scripts/`。不要直接维护生成的 `public/portal.html`。
- Node.js 20+、Python 3.10+；`npm ci` 后执行 `npm run build`。相关交互验证为 `npm test`，浏览器配置见 README。
- `archive/` 与 `artifacts/` 为本地历史和证据，不提交；原始资料、运行授权记录、机器配置不可自动纳入 Git。
- 默认中文。提交使用 `type(scope): 中文标题`，正文包含 `Co-Authored-By: Codex <noreply@openai.com>`；推送前取得用户明确确认，确认范围内不重复询问。
- 保留已有未提交变更，不修改其他人的范围；不自行合并、部署或宣布验收。
- 用户通过浏览器查看原型，对话中只给简洁说明或链接，不嵌入原型页面。
