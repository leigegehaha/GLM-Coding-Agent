---
name: engineering-retrospective
description: Turn completed engineering work, repeated failures, test evidence, and user corrections into safe improvement proposals. Use after a significant task, after recovery from repeated mistakes, when the user requests a retrospective, or when improving the agent's coding workflow or Skills.
---

# Engineering Retrospective

Improve future execution from observable outcomes without silently rewriting the agent.

## Workflow

1. Gather evidence from the request, diffs, commands, test results, failures, and explicit user feedback. Do not infer hidden reasoning.
2. Separate what worked, what failed, root causes, and lessons that generalize beyond this task.
3. Rank lessons by recurrence, impact, confidence, and implementation cost.
4. Turn each accepted lesson into one of:
   - a durable project fact for `coding-memory-curator`;
   - a repository test or guardrail;
   - a proposed system prompt change;
   - a proposed Skill creation or revision.
5. Require user approval before changing system prompts, Skills, recurring automation, or broad engineering policy.
6. For Skill changes, use `skill-creator` to define realistic evaluations, compare against a baseline, validate structure, and version the accepted result.
7. Keep the report concise: evidence, lesson, proposed action, expected benefit, and rollback or evaluation method.

Do not store secrets, manufacture lessons from one ambiguous event, or claim autonomous self-improvement without a persisted and evaluated change.
