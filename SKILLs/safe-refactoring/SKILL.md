---
name: safe-refactoring
description: Improve code structure while preserving observable behavior. Use when extracting modules, reducing duplication, renaming, reorganizing, simplifying complex code, or paying down technical debt without intentionally changing product behavior.
---

# Safe Refactoring

Make structural improvements under an explicit behavior-preservation contract.

## Workflow

1. Define the behavior, APIs, data formats, side effects, and platform paths that must remain unchanged.
2. Read repository rules and inspect existing tests. Add characterization coverage when important behavior is not protected.
3. Establish a clean baseline with targeted tests or other observable evidence.
4. Split the refactor into small mechanical steps. Keep feature changes separate from structural changes.
5. Preserve public names, serialization, error semantics, timing, and ownership boundaries unless the user approved a change.
6. Run focused checks after each risky step and the relevant broader suite at the end.
7. Review the diff for accidental behavior changes, unnecessary abstractions, and unrelated formatting churn.

Stop and explain the tradeoff if safe preservation requires a migration or product decision.
