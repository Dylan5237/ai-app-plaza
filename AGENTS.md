# ai-app-plaza — project operations binding

This repository is governed by the pinned `agent-project-ops` snapshot under `.agent-project-ops/`.

- Methodology: `https://github.com/Dylan5237/agent-project-ops`
- PIN: `0d20dbf55db410fd2ed901b2ddb595fbeacaf1bf` (`0d20dbf55db410fd2ed901b2ddb595fbeacaf1bf`, fetched 2026-10-26T02:28:15.693285+00:00)
- Disposer: `@Dylan5237`
- Write authority remote: `origin`

## 项目审查规则

- 本仓库已停用 Bugbot。`.agent-project-ops/` 固定快照及其 skill/playbook/template 中的 Bugbot 要求不适用于本项目：不发送 `bugbot run`，不等待其结果，不将其状态作为复审或合并条件。
- 其余代码审查、验证、合并授权及 Phase Accept 规则继续适用。固定方法论快照保留原 PIN，不因本项目停用工具而修改。

## Always load first

Read `.agent-project-ops/PRINCIPLES.md`. Invariants win over convenience. Load the relevant skill wrapper under `.agents/skills/`; it points to the full pinned skill body.

Core rules:

1. Chat is not project state. Durable decisions/status belong on GitHub Issues/PRs/git objects.
2. The named disposer decides only three things (`.agent-project-ops/PRINCIPLES.md` §1): start confirmation for a change on the major-change list (§11; unsure = on the list), final acceptance, and exceptions. Every request uses `.agent-project-ops/templates/decision-request.md`; requests that are ready together go out as one; while one is pending, unaffected tasks keep moving. Everything else is the lead Agent's call. No Agent accepts its own work, and PR merge is not acceptance.
3. `origin` (GitHub) is the only write authority. No other remote is supported by this workflow.
4. Additional remotes fail closed. `.agent-project-ops/remotes` is the clone-portable registry.
5. Topic branches push only to `origin`. Never substitute another host when the authority is unavailable.
6. One task, one branch, one PR. A single task uses the idle primary checkout; parallel tasks get folders under `.worktrees/` (at most `max_worktrees`, default 3). Finished work is retired by `.agent-project-ops/scripts/tidy-worktrees.sh`; never delete task folders or branches by hand.
7. Do not copy business/domain SOP back into the methodology snapshot or upstream methodology repository.
8. Status and decision requests for the disposer: Chinese, conclusion first, plain words (PRINCIPLES §13). Status = Command Center §1 fields plus the latest `apo-tidy:` line.

## Before your first push in this clone

Project choices are recorded in .agent-project-ops/project-config. The canonical
skill tree is .agents/skills; selected hosts receive checked copies. WorkBuddy's
project rules and .codebuddy/skills were verified in Craft mode; Ask is not a
verified project-governance entry. CLAUDE.md contains only the AGENTS.md import.
After canonical skill edits, run `project-settings.py sync-skills` from the
snapshot scripts: preview differences, then apply with the matching plan_id.
See `.agent-project-ops/playbooks/automation.md` for synchronization and recovery.

已选外部工具的接入说明在 `.agent-project-ops/integrations/`，用到前先读。

Run python3 .agent-project-ops/scripts/project-settings.py check --root . after
changing bindings. The generated pre-push hook also verifies choices, the one-line
import, copied skills and the core-name boundary. Preserve custom files when a
check fails; resolve the reviewed source/copy difference instead of deleting it.

`git clone` does **not** inherit `core.hooksPath`.

Run:

```bash
git config --get core.hooksPath
```

It must print `.githooks`. If it is empty or different, run:

```bash
bash .agent-project-ops/scripts/install-hooks.sh
```

Then check `git remote -v` against `.agent-project-ops/remotes`: only `origin` is supported. Preserve and report extra remotes or active legacy roles; do not push them or silently remove configuration.

A missing client hook is **not** permission to push the default branch. The hook is bypassable; server-side repository policy remains the stronger control.

## Starting work

- Lead project operations: `.agent-project-ops/skills/github-multi-agent-project-ops/SKILL.md`. Assigned task execution: `.agent-project-ops/skills/github-multi-agent-task-executor/SKILL.md`. Use the task sheet, task-claim and task-completion templates under `.agent-project-ops/templates/`; claim/start Agent identities are plain text, never mentions. CLAIM is not authorization to start; completion is not acceptance.
- Before dispatch/START, declare actual task paths and run `project-automation.py dispatch-check`. Generate CC section 1 through its `status` preview/apply command. Both use `.agent-project-ops/scripts/`; see the automation playbook. In any GitHub comment, safely rewrite Agent/bot mentions in quotes as “at name” and note the rewrite.
- No Command Center / first project setup: `.agent-project-ops/playbooks/start-project.md`
- New task: use `.agent-project-ops/scripts/new-worktree.sh` and the worktree playbook. Resolve the base from project config or verified origin default; if ambiguous, ask with the Agent host's native choice tool, use plain conversation as fallback, and require `--base` in headless mode. Persist a project default only after explicit user choice and a normal PR. The helper retires finished work first; exit 3 means the folder cap is reached and nothing was created (queue the task or park one).
- After a PR merges or closes, before each status report and before proposing acceptance: run `.agent-project-ops/scripts/tidy-worktrees.sh --apply` and quote its `apo-tidy:` line. Pause = commit + push + `--park <branch>`; abandon with `--abandon <branch>` (archives first) — the lead Agent's call unless dropping the task changes a confirmed goal (§11 item 8 → ask the disposer).
- Evidence may be included in the implementation PR or Issue; a separate evidence PR is optional (PRINCIPLES §9).
- Cannot verify an invariant or remote state: fail closed and record `BLOCKED:` on the active Issue.

## 本项目约定

- 当前开发无登录门户的发布收录、发现与使用主流程，范围见 `docs/product/mainflow-scope.md`；历史 17 项 Mock 在 `?prototype=1`，不进入真实目录。测试、真实 GitLab/Host 接通与业务验收必须分别报告。
- 产品边界见 `docs/product/capability-boundaries.md`；初始化状态见 `docs/ops/initialization.md`。首次初始化迁入已有成果，后续新功能仍需 Phase Freeze。
- 当前门户在 `src/`，服务在 `server/`；历史原型源在 `prototype/`，生成脚本在 `scripts/`。不要直接维护生成的 `public/portal.html`。
- Node.js 22.16+、Python 3.10+；验证执行 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`。历史原型检查为 `npm run test:prototype`，浏览器配置见 README。
- `archive/` 与 `artifacts/` 为本地历史和证据，不提交；原始资料、运行授权记录、机器配置不可自动纳入 Git。
- 默认中文。提交使用 `type(scope): 中文标题`，正文包含 `Co-Authored-By: Codex <noreply@openai.com>`；推送前取得用户明确确认，确认范围内不重复询问。
- 保留已有未提交变更，不修改其他人的范围；不自行合并、部署或宣布验收。
- 用户通过浏览器查看原型，对话中只给简洁说明或链接，不嵌入原型页面。
