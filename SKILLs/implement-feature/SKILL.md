---
name: implement-feature
description: Implement repository features end to end. Use when the user asks to add, build, create, integrate, or change software behavior and expects working code, focused tests, validation, and a concise handoff.
---

# Implement Feature

Deliver the requested behavior in sympathy with the existing codebase.

## Workflow

1. Read applicable repository instructions and inspect the current worktree before editing.
2. Translate the request into observable behavior, edge cases, affected modules, and acceptance checks. Ask only about decisions that cannot be discovered locally.
3. Trace the existing workflow and identify the smallest coherent change. Reuse local abstractions, dependencies, and naming patterns.
4. Implement the complete path, including validation, failure states, persistence or IPC boundaries, and user-visible strings where relevant.
5. Add focused regression tests for the changed behavior. Avoid broad refactors unless they are required for correctness.
6. Run targeted checks while iterating, then the repository's relevant type, lint, test, build, or UI verification commands.
7. Review the final diff for accidental churn, incomplete states, unsafe operations, and unrelated user changes.
8. Report the outcome first, followed by validation and any untested limitation.

If Plan Mode is active, produce a decision-complete plan and do not edit.
