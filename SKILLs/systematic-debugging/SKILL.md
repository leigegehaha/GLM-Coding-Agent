---
name: systematic-debugging
description: Diagnose bugs, failing tests, broken builds, runtime errors, and unexpected behavior through reproduction and root-cause analysis. Use before proposing or implementing a fix whenever the cause is not already proven.
---

# Systematic Debugging

Find the cause before changing the code.

## Workflow

1. Capture the expected behavior, actual behavior, environment, and smallest reliable reproduction.
2. Read the exact error and inspect relevant logs, tests, recent diffs, configuration, and dependency boundaries.
3. Trace data and control flow backward from the failure. Separate observed facts from hypotheses.
4. Form one falsifiable hypothesis at a time and run the smallest read-only experiment that can disprove it.
5. Identify the root cause and explain why it produces the symptom. Do not treat a downstream exception as the cause without evidence.
6. Add or update a regression test that fails for the demonstrated bug when practical.
7. Implement the smallest durable fix at the owning boundary. Avoid retries, fallbacks, or broad guards that merely hide the defect.
8. Re-run the reproduction, targeted tests, and relevant broader checks. Inspect logs or UI behavior when automated tests cannot prove the result.

Report unresolved hypotheses explicitly. Never claim a fix from code inspection alone.
