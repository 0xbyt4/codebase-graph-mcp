---
name: codebase-graph
description: Check file dependencies, blast radius and circular imports with the codebase-graph tools before editing, deleting or moving a file, and when asked what depends on what, what a change would break, how a project is structured, or which files change together.
---

The codebase-graph MCP server keeps a file-level import graph of the current project (TypeScript/JavaScript, Python, Rust). Use its tools instead of grepping for imports.

## Before changing a file

1. Run `impact_analysis` on the file. Read the direct dependents first; they are ranked by how many files depend on them.
2. For several files, or a branch, run `multi_file_impact` with `files` or with `diff_ref` (for example `main`).
3. When a list is long, narrow it with `limit` instead of paging through everything.

## Answering structure questions

- "What does X import?" is `get_dependencies`; "who imports X?" is `get_dependents`.
- "How is this project organised?" is `project_overview`, then `package_dependencies` for the directory-level view.
- "Are there circular imports?" is `detect_cycles`. Report the group sizes it prints: one large group is usually a single architectural knot, not many separate bugs.
- "Which files change together?" is `co_change` and `file_churn`; both need git history.
- Python class questions (subclasses, overrides) are `class_hierarchy`.

## Keeping the graph fresh

The graph is cached for five minutes per project. After creating, deleting or moving files, call `refresh_graph` before relying on the results.

## Limits to state when they matter

The graph is file level and static: it does not see dynamic imports or function-level calls. Say so whenever a "no dependents" result is used to justify deleting a file.

## Visualising

`visualize_graph` writes an interactive HTML page inside the project, or a whole atlas with `atlas=true`. Offer it when the user wants to see the structure rather than read a list.
