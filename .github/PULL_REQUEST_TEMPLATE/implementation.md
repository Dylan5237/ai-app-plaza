## 本项目审查规则

本仓库已停用 Bugbot。下方 APO 原版清单中的 Bugbot 两项不适用：不发送 `bugbot run`，不等待其结果，也不将其状态作为复审或合并条件。其余代码审查、验证、合并授权和 Phase Accept 规则继续适用。

## Summary

<!-- What changed in product/library/docs **code**. One Phase / one task. -->

- Issue: #
- Phase: #
- Freeze ACK comment:

## Type

- [ ] `feat`
- [ ] `fix`
- [ ] `docs` (no behavior change)

## Worktree

`{repo}/.worktrees/{issue-or-phase}-{owner}-{slug}`

Branch: `feat|fix|docs/{issue}-{slug}` → target `main` via **origin only**

## Contract

- In-scope items touched:
- NON-GOALS respected:
- Frozen interfaces unchanged? **yes / no** (if no → stop; open Architecture Exception)

## Test plan (implementation)

<!-- Automated/manual tests that **are code** belong here. Proof artifacts belong on an evidence PR. -->

-

## Evidence

This PR must **not** be the evidence pack. Link evidence PR or Issue proofs:

-

## Merge ≠ PASS

Merging this PR does not close the Phase. Disposer still records `PHASE ACCEPT` on the Phase issue.

## Checklist

- [ ] One task, one branch, one worktree
- [ ] No `evidence/`-only files mixed in
- [ ] No push to `main`
- [ ] Secrets not committed
- [ ] **CC §1 updated** (or GitHub `BLOCKED:` if Command Center could not be edited)
- [ ] Commented `bugbot run` on this PR (body exactly that text) before asking merge
- [ ] Prompted disposer to wait for Bugbot review results before merge judgment
