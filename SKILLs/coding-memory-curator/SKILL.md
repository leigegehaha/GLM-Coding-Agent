---
name: coding-memory-curator
description: Curate durable engineering knowledge into the existing agent memory files. Use when the user asks to remember project context, after a verified reusable discovery, or when consolidating validated commands, conventions, architecture decisions, recurring failures, and engineering preferences.
---

# Coding Memory Curator

Store compact, verified engineering context without creating a second memory system.

## Workflow

1. Read the existing memory policy and relevant `MEMORY.md` or daily memory file before writing.
2. Classify the candidate:
   - Put task-local progress and newly observed facts in `memory/YYYY-MM-DD.md`.
   - Put stable conventions, validated commands, architecture decisions, recurring fixes, and explicit user preferences in `MEMORY.md`.
3. Require evidence from source, successful commands, repeated outcomes, or explicit user confirmation. Mark uncertain facts as candidates instead of durable truth.
4. Deduplicate and update the existing topic block rather than appending a near-duplicate.
5. Keep one self-contained fact per top-level bullet with short supporting details.
6. Write the file before claiming the information was remembered, then verify the written content.

Never store credentials, API keys, personal secrets, raw transcripts, temporary logs, chain of thought, speculative conclusions, or large code excerpts.
