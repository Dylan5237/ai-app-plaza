## 本项目审查规则

本仓库已停用 Bugbot。下方 APO 原版清单中的 Bugbot 两项不适用：不发送 `bugbot run`，不等待其结果，也不将其状态作为复审或合并条件。其余代码审查、验证、合并授权和 Phase Accept 规则继续适用。

## Summary

Replayable **proofs** for frozen acceptance tests. **No feature/fix/docs product diff.**

- Issue / Phase: #
- Implementation PR:
- SHA under test:

## Branch

`evidence/{issue}-{slug}` — label `pr:evidence`

## Proof table

| Frozen acceptance test | Command / method | Artifact path or URL | Result |
| --- | --- | --- | --- |
| | cwd + command | | pass/fail |

## How to replay

1.
2.

## Redaction

- [ ] Secrets, tokens, PII removed
- [ ] Logs are excerpts, not entire production dumps

## Agent proposal

- [ ] `EVIDENCE READY` posted on the Phase issue
- [ ] Not commenting `PHASE ACCEPT` (disposer only)

## Checklist

- [ ] Diff is evidence-only
- [ ] Does not mix with `feat/`/`fix/` changes
- [ ] Merge of this PR still ≠ Phase PASS
- [ ] Commented `bugbot run` on this PR (body exactly that text) before asking merge
- [ ] Prompted disposer to wait for Bugbot review results before merge judgment
