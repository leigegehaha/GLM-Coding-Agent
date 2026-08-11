---
name: test-and-verify
description: Design and run focused software verification. Use when adding regression coverage, validating a feature or bug fix, selecting appropriate unit, integration, end-to-end, type, lint, or build checks, or investigating weak and flaky tests.
---

# Test And Verify

Produce evidence that matches the risk and observable behavior of the change.

## Workflow

1. Discover the repository's test framework, naming conventions, scripts, CI gates, and nearby examples.
2. Define the behavior contract and choose the lowest test layer that proves it without over-mocking.
3. Cover the primary success path, meaningful failure path, and regression boundary. Test public behavior rather than private implementation details.
4. For a bug fix, demonstrate that the test fails for the original defect when practical before relying on it.
5. Keep fixtures deterministic and local. Avoid network, time, ordering, or environment dependence unless that behavior is the subject of the test.
6. Run the narrowest relevant test during iteration, then the broader quality gates required by repository guidance.
7. Distinguish product failures from environment or pre-existing failures and report exact commands and results.

Do not weaken assertions, skip tests, or update snapshots merely to obtain a passing run.
