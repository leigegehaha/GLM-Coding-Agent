---
name: codebase-onboarding
description: Map an unfamiliar repository before coding. Use when starting work in a new codebase, explaining what a project does, locating implementation paths, or determining repository rules, architecture, commands, tests, and ownership boundaries.
---

# Codebase Onboarding

Build an evidence-backed map of the repository before proposing changes.

## Workflow

1. Confirm the working directory and inspect the worktree state without modifying it.
2. Read the nearest repository instructions, then the README and relevant architecture or contribution docs.
3. Inspect manifests, lockfiles, workspace definitions, build configuration, and top-level directories.
4. Locate source, tests, assets, generated output, runtime entry points, and cross-process or package boundaries.
5. Trace the specific user workflow from entry point to its important dependencies. Prefer symbol and text search over reading large files wholesale.
6. Derive commands from checked-in scripts and CI configuration. Do not invent commands from framework conventions alone.
7. Report the project purpose, architecture, relevant files, validated commands, constraints, and remaining unknowns.

Do not edit files unless the user also asks for implementation.
