---
name: code-review
description: Review code changes for concrete defects and regressions. Use when reviewing a diff, pull request, patch, commit, or implementation for correctness, security, performance, compatibility, maintainability, and missing tests.
---

# Code Review

Prioritize actionable defects over summaries and style preferences.

## Workflow

1. Read repository instructions, the requested scope, and the complete relevant diff.
2. Inspect surrounding callers, contracts, tests, migrations, configuration, and platform-specific paths needed to validate each concern.
3. Look for incorrect behavior, data loss, security exposure, race conditions, stale state, compatibility breaks, missing error handling, and untested regressions.
4. Verify every finding against source evidence. Do not report hypothetical concerns without a plausible triggering path.
5. Present findings first, ordered by severity. Include the file and line, the triggering scenario, impact, and a concrete direction for correction.
6. Then list open questions or assumptions and a short change summary. If no findings exist, say so and identify remaining test gaps.

Do not modify code unless the user explicitly asks for fixes.
