Read root `AGENTS.md` before changing repository state. APO 已停用：不加载、调用或恢复 `.agent-project-ops/` 或历史 APO 流程。

GitHub `origin` 是唯一写入权威；主题分支只推 `origin`，通过 PR 合入 `main`。未知远端先核对用途，不绕过 GitHub 权威流程。

首次 push 前确认 `core.hooksPath=.githooks`。`.githooks/pre-push` 是项目自有安全检查，不依赖 APO。
