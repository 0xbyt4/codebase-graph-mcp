# codebase-graph-mcp

An MCP server that builds a dependency graph of your codebase, enabling AI coding assistants to understand project structure and make safer changes.

## Problem

AI coding assistants read files one at a time. They don't know which files depend on each other. When they change a file, they can't predict what breaks. This wastes tokens and causes bugs.

## Solution

This MCP server scans your project, builds a dependency graph, and exposes it through 12 tools covering dependency analysis, impact prediction, architecture visualization, interactive graph generation, and git history insights.

## Tools

### Dependency Analysis

| Tool | Description |
|------|-------------|
| `get_dependencies` | What does this file import? |
| `get_dependents` | What files import this file? |
| `impact_analysis` | If I change this file, what else is affected? (recursive BFS) |
| `multi_file_impact` | Combined impact of multiple changed files. Accepts file list or git diff ref. |
| `project_overview` | High-level view: file counts, most imported files, entry points, orphans |
| `refresh_graph` | Force re-scan after file changes |

### Architecture

| Tool | Description |
|------|-------------|
| `detect_cycles` | Find circular dependencies using Tarjan's SCC algorithm |
| `package_dependencies` | Package/module level dependency view with configurable depth |
| `class_hierarchy` | Python class inheritance tree, methods, and subclass overrides |
| `visualize_graph` | Generate interactive HTML dependency graph, opens in browser |

### Git History

| Tool | Description |
|------|-------------|
| `file_churn` | Most frequently changed files in git history (hotspot detection) |
| `co_change` | Files that frequently change together (hidden coupling detection) |

## Supported Languages

- **TypeScript / JavaScript** (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`)
- **Python** (`.py`)
- **Rust** (`.rs`) — `use crate::`, `use super::`, `use self::`, `mod`/`pub mod` declarations, glob imports, multi-line `use` with braces
- **Cargo.toml** — workspace cross-crate dependency parsing (resolves `[workspace.dependencies]` path mappings)
- **Config files** (`.json`, `.json5`) — parsed for module references

## Installation

### Claude Code (CLI)

```bash
claude mcp add -s user codebase-graph -- node /path/to/codebase-graph-mcp/build/index.js
```

### Claude Code (manual config)

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "codebase-graph": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/codebase-graph-mcp/build/index.js"],
      "env": {
        "PROJECT_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

### Project Root Resolution

All tools accept an optional `project_root` parameter. Resolution order:

1. `project_root` parameter in tool call (if provided)
2. `PROJECT_ROOT` environment variable (if set)
3. Current working directory (default)

## Example Output

### impact_analysis

```
Impact analysis for src/providers/singleton.py:

Directly affected (46):
  - src/providers/asr_provider.py
  - src/providers/config_provider.py
  - src/providers/io_provider.py
  ...

Indirectly affected (3):
  - src/providers/avatar_llm_state_provider.py
  - src/providers/__init__.py
  - src/providers/llm_history_manager.py

Total affected files: 49
```

### detect_cycles

```
Found 2 circular dependencies:

Cycle 1 (3 files):
  src/a.py -> src/b.py -> src/c.py -> src/a.py

Cycle 2 (2 files):
  src/utils/x.py -> src/utils/y.py -> src/utils/x.py
```

### class_hierarchy

```
Class: OdomProviderBase
File: src/providers/odom_provider_base.py
Bases: SingletonProvider

Methods (5):
  - get_odom
  - reset
  - start
  - stop
  - update

Subclasses (4):
  TronOdomProvider (src/providers/tron_odom_provider.py)
    overrides: start, stop, update
  Turtlebot4OdomProvider (src/providers/turtlebot4_odom_provider.py)
    overrides: start, stop, update
  UnitreeG1OdomProvider (src/providers/unitree_g1_odom_provider.py)
    overrides: start, stop
  UnitreeGo2OdomProvider (src/providers/unitree_go2_odom_provider.py)
    overrides: start, stop, update
```

### file_churn

```
File churn (last 90 days, 234 commits):

File                                                         Commits  Last Changed
──────────────────────────────────────────────────────────── ──────── ────────────
src/providers/io_provider.py                                       18   2026-02-15
src/actions/move/connector/ros2.py                                 14   2026-02-10
src/runtime/config.py                                              12   2026-02-18
```

### co_change

```
Co-change analysis for src/providers/singleton.py (12 changes in 90 days):

File                                                    Together     Total  Corr
─────────────────────────────────────────────────────── ───────── ────── ─────
src/providers/io_provider.py                                   8     18  0.67
src/providers/config_provider.py                               6     10  0.60
src/runtime/config.py                                          5     12  0.42
```

### visualize_graph

Generates an interactive HTML graph and opens it in the browser. Nodes are colored by directory, sized by import count. Drag, zoom, hover for details.

```
# All files (top 50)
visualize_graph(top=50)

# Only gateway-related files
visualize_graph(scope="gateway", top=30)

# Custom output path
visualize_graph(output="/tmp/my_graph.html")
```

Output:
```
Graph saved to /path/to/project/codebase_graph.html

Nodes: 50
Edges: 224

Top 10 most imported:
  128 <- gateway/config.py
  103 <- hermes_constants.py
   91 <- hermes_cli/config.py
   81 <- gateway/platforms/base.py
   53 <- gateway/session.py

Opened in browser.
```

### package_dependencies

```
Package Dependencies (depth=2, 8 packages, 45 cross-package edges):

src/providers (47 files)
  -> src/zenoh_msgs, src/runtime
  <- src/actions, src/inputs, src/fuser

src/actions (82 files)
  -> src/providers, src/inputs, src/llm
  <- src/runtime
```

## How It Works

1. Scans all supported files in the project (skips `node_modules`, `.git`, `build`, `target`, `__pycache__`, etc.)
2. Parses import/export statements using regex (zero external parser dependencies)
3. Resolves relative and absolute imports to actual files
   - TypeScript: handles `.js` -> `.ts` ESM convention, index files, path aliases
   - Python: handles relative imports (`from .module`) and absolute project imports (`from runtime.config`)
   - Rust: handles `crate::`, `super::`, `self::` paths, `mod`/`pub mod` declarations, `mod.rs`/`lib.rs`/`main.rs` module resolution
4. Builds an adjacency list graph (dependencies + reverse dependencies)
5. Parses config files for module references (e.g., JSON configs pointing to Python modules)
6. Parses `Cargo.toml` workspace for cross-crate dependency edges (maps `[workspace.dependencies]` path entries to crate entry points)
7. Builds class inheritance hierarchy from Python files
8. Caches the graph in memory per project root, refresh with `refresh_graph`

## Design Principles

- **Zero runtime dependencies** beyond the MCP SDK
- **Regex-based parsing** — no AST parsers, no native binaries, instant startup
- **Works offline** — no API calls, no cloud services
- **Multi-project support** — cache per project root, switch between projects freely
- **Language agnostic architecture** — easy to add new language support

## Project Structure

```
src/
  index.ts           -> MCP server + 12 tool definitions
  parser.ts          -> Regex-based import parser (TS/JS + Python + Rust)
  graph.ts           -> Dependency graph engine + cycle detection + package analysis
  class-analyzer.ts  -> Python class hierarchy extraction
  config-parser.ts   -> Config file module reference parser
  cargo-parser.ts    -> Cargo.toml workspace cross-crate dependency parser
  git-history.ts     -> Git log analysis (churn + co-change)
```

## License

MIT
