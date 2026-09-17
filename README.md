<img width="842" height="653" alt="Screenshot 2026-04-11 at 01 55 02" src="https://github.com/user-attachments/assets/f4e8d55e-2121-46b1-912d-9133090a3086" />
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

- **TypeScript / JavaScript** (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`) — static, side-effect, dynamic and `require()` imports, multi-line and `import type` forms, `.js` -> `.ts` ESM rewrites, index files, `tsconfig.json`/`jsconfig.json` `paths` and `baseUrl` (including `extends`)
- **Python** (`.py`) — absolute and relative imports, `from pkg import submodule`, parenthesized multi-line imports, namespace packages, imports under `if TYPE_CHECKING:` (tracked as type-only)
- **Rust** (`.rs`) — `use crate::`, `use super::`, `use self::`, `mod`/`pub mod` declarations, glob and brace-group imports, items defined in the parent module file, nearest `Cargo.toml` decides what `crate::` means
- **Cargo.toml** — workspace cross-crate dependency parsing (resolves `[workspace.dependencies]` path mappings)
- **Config files** (`.json`, `.json5` under `config/`) — module references in the [OpenMind OM1](https://github.com/OpenmindAGI/OM1) config layout only; other projects get no config edges

Type-only imports (TS `import type`, Python `TYPE_CHECKING`) and Rust `mod` declarations are kept as dependencies but never count as circular dependencies, since they are the standard ways to break a runtime cycle.

## Installation

### 1. Build from source (required)

```bash
git clone https://github.com/0xbyt4/codebase-graph-mcp.git
cd codebase-graph-mcp
npm install
npm run build
npm test   # optional: fixture-based tests, needs git on PATH
```

Requires Node.js 18+. `git` is used for the history tools and, inside a repository, for the file list (so `.gitignore` is honoured). Outside a repository the tree is walked with a built-in ignore list (`node_modules`, `.git`, `dist`, `build`, `target`, `venv`, `env`, `vendor`, ...).

### 2. Connect to your AI assistant

#### Claude Code (CLI)

```bash
claude mcp add -s user codebase-graph -- node /path/to/codebase-graph-mcp/build/index.js
```

#### Claude Code (manual config)

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

File arguments must stay inside the project root; anything that resolves outside it (including through a symlink) is rejected. A file the scan never saw is reported as an error rather than as "unused". `visualize_graph` only writes `.html` files and never overwrites a file it did not generate. Scans stop at 50,000 files and say so in the output.

Note that `project_root` itself is chosen by the caller: the server will read (and, for `visualize_graph`, write one HTML file into) any directory the process user can access. Set `PROJECT_ROOT` and drop the parameter if the assistant should be limited to one project.

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

Each file is listed once; the trailing entry closes the loop. A cycle that only exists through `import type` / `TYPE_CHECKING` imports is not reported.

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

File                                                     Commits      First       Last
──────────────────────────────────────────────────────── ─────── ────────── ──────────
src/providers/io_provider.py                                  18 2025-12-02 2026-02-15
src/actions/move/connector/ros2.py                            14 2025-12-14 2026-02-10
src/runtime/config.py                                         12 2026-01-05 2026-02-18
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

Generates an interactive HTML graph and opens it in the browser. Nodes are colored by top-level directory, sized by import count. Drag, zoom, hover for details. The page loads a pinned vis-network build from jsDelivr with an integrity hash, so it needs network access when opened.

```
# All files (top 50)
visualize_graph(top=50)

# Only files under gateway/, ranked within that scope
visualize_graph(scope="gateway", top=30)

# Custom output path (must be inside the project root); skip the browser
visualize_graph(output="docs/graph.html", open_browser=false)
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

1. Lists source files: `git ls-files` inside a repository (honours `.gitignore`), otherwise a directory walk with a built-in ignore list. Symlinks are never followed; unreadable directories are skipped; files over 1 MB and lines over 5,000 characters are treated as generated and not parsed.
2. Parses import/export statements using regex (zero external parser dependencies)
3. Resolves relative and absolute imports to actual files
   - TypeScript: `.js` -> `.ts` ESM convention, index files, `tsconfig`/`jsconfig` `paths` and `baseUrl`
   - Python: relative imports, absolute project imports from `src/`, `lib/`, `app/`, the root, or any ancestor of the importing file; `from pkg import name` resolves `name` as a submodule when it is one
   - Rust: `crate::` (nearest `Cargo.toml`), `super::`, `self::`, `mod` declarations, `mod.rs`/`lib.rs`/`main.rs`; items that live in the parent module file resolve to that file
4. Builds an adjacency list graph (dependencies + reverse dependencies), flagging type-only edges and Rust `mod` declarations
5. Parses OM1-style config files for module references
6. Parses `Cargo.toml` workspace for cross-crate dependency edges (maps `[workspace.dependencies]` path entries to crate entry points)
7. Builds class inheritance hierarchy from Python files
8. Caches the graph in memory per project root for 5 minutes, refresh with `refresh_graph`

## Design Principles

- **Minimal runtime dependencies**: the MCP SDK, zod and json5
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
  git-history.ts     -> Git log analysis (churn + co-change), git ref validation
  paths.ts           -> Project root normalization and path containment checks
test/
  fixtures/          -> Small TypeScript, Python and Rust projects the tests run against
  *.test.mjs         -> node:test suites (parser, graph, git, paths, end-to-end server)
```

## License

MIT
