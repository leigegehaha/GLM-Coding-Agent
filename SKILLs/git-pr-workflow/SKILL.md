---
name: git-pr-workflow
description: Prepare Git commits and pull request material from an existing worktree. Use when inspecting diffs, separating changes, writing Conventional Commit messages, creating a commit when explicitly authorized, or drafting an evidence-backed pull request description.
---

# Git And Pull Request Workflow

Keep repository history scoped, reviewable, and supported by validation evidence.

## Workflow

1. Read repository contribution rules and inspect status, diff, branch, and recent commit conventions.
2. Separate task changes from unrelated user work. Never discard, overwrite, or silently include unrelated changes.
3. Review the intended diff for secrets, generated output, debug code, formatting churn, and missing tests.
4. Run or confirm the validation appropriate to the change before describing it as ready.
5. Write an imperative Conventional Commit subject when local rules require it. Keep the body focused on why the behavior changed.
6. Commit only when the user explicitly asked. Use non-interactive commands and verify the resulting commit.
7. Draft pull requests with what changed, why, linked issues, validation commands, risks, platform notes, and screenshots for UI work.

Never rewrite published history or force push without explicit authorization.
