# codebase-graph-mcp

An MCP server that builds a dependency graph of your codebase, enabling AI coding assistants to understand project structure and make safer changes.

## Problem

AI coding assistants read files one at a time. They don't know which files depend on each other. When they change a file, they can't predict what breaks. This wastes tokens and causes bugs.

## Solution

This MCP server scans your project, builds a dependency graph, and exposes it through 5 tools:

| Tool | Description |
|------|-------------|
| `get_dependencies` | What does this file import? |
| `get_dependents` | What files import this file? |
| `impact_analysis` | If I change this file, what else is affected? (recursive) |
| `project_overview` | High-level view: file counts, most imported files, entry points, orphans |
| `refresh_graph` | Force re-scan after file changes |

## Supported Languages

- TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`)
- Python (`.py`)

## Install

```bash
npm install -g codebase-graph-mcp
```

## Usage with Claude Code

Add to your Claude Code MCP config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "codebase-graph": {
      "command": "npx",
      "args": ["-y", "codebase-graph-mcp"],
      "env": {
        "PROJECT_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

If `PROJECT_ROOT` is not set, the server uses the current working directory.

## Example Output

### impact_analysis

```
Impact analysis for src/utils/auth.ts:

Directly affected (3):
  - src/pages/LoginPage.tsx
  - src/api/authApi.ts
  - src/middleware/authMiddleware.ts

Indirectly affected (2):
  - src/pages/Dashboard.tsx
  - src/App.tsx

Total affected files: 5
```

### project_overview

```
Project Overview:

Files: 47
Dependencies: 128

File types:
  .tsx: 22
  .ts: 18
  .py: 7

Most imported files:
  src/utils/helpers.ts (12 dependents)
  src/types/index.ts (9 dependents)

Entry points (no dependents):
  - src/index.ts
  - src/main.tsx
```

## How It Works

1. Scans all supported files in the project (skips `node_modules`, `.git`, `build`, etc.)
2. Parses import/export statements using regex (zero external parser dependencies)
3. Resolves relative paths to actual files (handles `.js` -> `.ts` ESM convention, index files, etc.)
4. Builds an adjacency list graph (dependencies + reverse dependencies)
5. Caches the graph in memory, refresh with `refresh_graph` tool

## Design Principles

- **Zero dependencies** beyond the MCP SDK
- **Regex-based parsing** — no AST parsers, no native binaries, instant startup
- **Works offline** — no API calls, no cloud services
- **Minimal footprint** — 3 source files, ~300 lines of code

## License

MIT
