#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, relative } from "node:path";
import {
  buildGraph,
  getDependencies,
  getDependents,
  getImpactAnalysis,
  getMultiFileImpact,
  getProjectOverview,
  getPackageDependencies,
  detectCycles,
  type GraphData,
} from "./graph.js";
import { getClassInfo, getFileClasses, getMethodOverriders } from "./class-analyzer.js";
import { getFileChurn, getCoChanges } from "./git-history.js";
import { execSync } from "node:child_process";

const server = new McpServer({
  name: "codebase-graph",
  version: "0.1.0",
});

// Cache: supports multiple project roots
const graphCache = new Map<string, GraphData>();

function getDefaultRoot(): string {
  return process.env.PROJECT_ROOT || process.cwd();
}

function resolveRoot(override?: string): string {
  if (override) {
    return override.startsWith("/") ? override : resolve(getDefaultRoot(), override);
  }
  return getDefaultRoot();
}

async function getGraph(root: string): Promise<GraphData> {
  const cached = graphCache.get(root);
  if (cached) return cached;
  const graph = await buildGraph(root);
  graphCache.set(root, graph);
  return graph;
}

function resolveFilePath(file: string, root: string): string {
  if (file.startsWith("/")) return file;
  return resolve(root, file);
}

function formatPath(absPath: string, root: string): string {
  return relative(root, absPath);
}

const projectRootParam = z
  .string()
  .optional()
  .describe("Absolute path to project root. Defaults to PROJECT_ROOT env or cwd.");

// Tool: get_dependencies
server.tool(
  "get_dependencies",
  "Get all files that a given file imports/depends on. Accepts a relative path from project root.",
  {
    file: z.string().describe("Relative file path from project root (e.g. src/index.ts)"),
    project_root: projectRootParam,
  },
  async ({ file, project_root }) => {
    try {
      const root = resolveRoot(project_root);
      const graph = await getGraph(root);
      const absPath = resolveFilePath(file, root);
      const deps = getDependencies(graph, absPath);

      if (deps.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${file} has no project dependencies.`,
            },
          ],
        };
      }

      const formatted = deps.map((d) => `  - ${formatPath(d, root)}`).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `${file} depends on ${deps.length} file(s):\n${formatted}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

// Tool: get_dependents
server.tool(
  "get_dependents",
  "Get all files that import/depend on a given file. Useful to know what breaks if you change this file.",
  {
    file: z.string().describe("Relative file path from project root (e.g. src/utils/auth.ts)"),
    project_root: projectRootParam,
  },
  async ({ file, project_root }) => {
    try {
      const root = resolveRoot(project_root);
      const graph = await getGraph(root);
      const absPath = resolveFilePath(file, root);
      const deps = getDependents(graph, absPath);

      if (deps.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No files depend on ${file}. It may be an entry point or unused.`,
            },
          ],
        };
      }

      const formatted = deps.map((d) => `  - ${formatPath(d, root)}`).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `${deps.length} file(s) depend on ${file}:\n${formatted}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

// Tool: impact_analysis
server.tool(
  "impact_analysis",
  "Analyze the full impact of changing a file. Shows directly and indirectly affected files through the dependency chain.",
  {
    file: z.string().describe("Relative file path from project root to analyze impact for"),
    project_root: projectRootParam,
  },
  async ({ file, project_root }) => {
    try {
      const root = resolveRoot(project_root);
      const graph = await getGraph(root);
      const absPath = resolveFilePath(file, root);
      const impact = getImpactAnalysis(graph, absPath);

      if (impact.totalAffectedFiles === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Changing ${file} has no impact on other files. It may be an entry point or unused.`,
            },
          ],
        };
      }

      let text = `Impact analysis for ${file}:\n\n`;

      if (impact.directlyAffected.length > 0) {
        text += `Directly affected (${impact.directlyAffected.length}):\n`;
        text += impact.directlyAffected
          .map((d) => `  - ${formatPath(d, root)}`)
          .join("\n");
        text += "\n\n";
      }

      if (impact.indirectlyAffected.length > 0) {
        text += `Indirectly affected (${impact.indirectlyAffected.length}):\n`;
        text += impact.indirectlyAffected
          .map((d) => `  - ${formatPath(d, root)}`)
          .join("\n");
        text += "\n\n";
      }

      text += `Total affected files: ${impact.totalAffectedFiles}`;

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

// Tool: project_overview
server.tool(
  "project_overview",
  "Get a high-level overview of the project's dependency structure. Shows file counts, most imported files, entry points, and orphan files.",
  {
    project_root: projectRootParam,
  },
  async ({ project_root }) => {
    try {
      const root = resolveRoot(project_root);
      const graph = await getGraph(root);
      const overview = getProjectOverview(graph, root);

      let text = `Project Overview (${root}):\n\n`;

      text += `Files: ${overview.totalFiles}\n`;
      text += `Dependencies: ${overview.totalEdges}\n\n`;

      // File types
      text += `File types:\n`;
      for (const [ext, count] of Object.entries(overview.filesByType).sort(
        (a, b) => b[1] - a[1],
      )) {
        text += `  ${ext}: ${count}\n`;
      }
      text += "\n";

      // Most imported
      if (overview.mostImported.length > 0) {
        text += `Most imported files:\n`;
        for (const { file, count } of overview.mostImported) {
          text += `  ${file} (${count} dependents)\n`;
        }
        text += "\n";
      }

      // Entry points
      if (overview.entryPoints.length > 0) {
        text += `Entry points (no dependents):\n`;
        for (const ep of overview.entryPoints) {
          text += `  - ${ep}\n`;
        }
        text += "\n";
      }

      // Orphan files
      if (overview.orphanFiles.length > 0) {
        text += `Orphan files (no dependencies, no dependents):\n`;
        for (const of_ of overview.orphanFiles) {
          text += `  - ${of_}\n`;
        }
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

// Tool: refresh_graph
server.tool(
  "refresh_graph",
  "Force refresh the dependency graph cache. Use this after making file changes.",
  {
    project_root: projectRootParam,
  },
  async ({ project_root }) => {
    try {
      const root = resolveRoot(project_root);
      graphCache.delete(root);
      const graph = await getGraph(root);
      return {
        content: [
          {
            type: "text",
            text: `Graph refreshed for ${root}. Tracking ${graph.files.size} files.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

// Tool: multi_file_impact
server.tool(
  "multi_file_impact",
  "Analyze the combined impact of multiple changed files. Accepts a list of files or a git diff ref to automatically detect changed files. Useful for PR reviews.",
  {
    files: z
      .array(z.string())
      .optional()
      .describe(
        "List of changed file paths (relative to project root)",
      ),
    diff_ref: z
      .string()
      .optional()
      .describe(
        'Git ref to diff against (e.g. "main", "HEAD~3"). Changed files are detected automatically.',
      ),
    project_root: projectRootParam,
  },
  async ({ files, diff_ref, project_root }) => {
    try {
      const root = resolveRoot(project_root);
      const graph = await getGraph(root);

      let filePaths: string[] = [];

      if (diff_ref) {
        try {
          const output = execSync(`git diff --name-only ${diff_ref}`, {
            cwd: root,
            encoding: "utf-8",
            timeout: 10000,
          }).trim();
          if (output) {
            filePaths = output
              .split("\n")
              .map((f) => resolve(root, f));
          }
        } catch (gitErr) {
          return {
            content: [
              {
                type: "text",
                text: `Git error: ${String(gitErr)}. Make sure the ref "${diff_ref}" exists.`,
              },
            ],
            isError: true,
          };
        }
      }

      if (files) {
        const resolved = files.map((f) => resolveFilePath(f, root));
        filePaths = [...filePaths, ...resolved];
      }

      if (filePaths.length === 0) {
        const msg = diff_ref
          ? `No changed files found between current branch and "${diff_ref}". Are you on the same branch?`
          : "No files specified. Provide either 'files' or 'diff_ref'.";
        return {
          content: [{ type: "text", text: msg }],
          isError: true,
        };
      }

      // Deduplicate
      filePaths = [...new Set(filePaths)];

      const impact = getMultiFileImpact(graph, filePaths);

      let text = `Changed files (${impact.changedFiles.length}):\n`;
      text += impact.changedFiles
        .map((f) => `  - ${formatPath(f, root)}`)
        .join("\n");
      text += "\n\n";

      if (impact.directlyAffected.length > 0) {
        text += `Directly affected (${impact.directlyAffected.length}):\n`;
        text += impact.directlyAffected
          .map((f) => `  - ${formatPath(f, root)}`)
          .join("\n");
        text += "\n\n";
      }

      if (impact.indirectlyAffected.length > 0) {
        text += `Indirectly affected (${impact.indirectlyAffected.length}):\n`;
        text += impact.indirectlyAffected
          .map((f) => `  - ${formatPath(f, root)}`)
          .join("\n");
        text += "\n\n";
      }

      text += `Total affected files: ${impact.totalAffectedFiles}\n\n`;

      text += `Per-file breakdown:\n`;
      for (const { file, totalImpact } of impact.perFileBreakdown) {
        text += `  ${formatPath(file, root)} -> ${totalImpact} total impact\n`;
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

// Tool: detect_cycles
server.tool(
  "detect_cycles",
  "Detect circular dependencies in the project. Uses Tarjan's SCC algorithm to find dependency cycles.",
  {
    project_root: projectRootParam,
  },
  async ({ project_root }) => {
    try {
      const root = resolveRoot(project_root);
      const graph = await getGraph(root);
      const result = detectCycles(graph);

      if (result.totalCycles === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No circular dependencies found.",
            },
          ],
        };
      }

      let text = `Found ${result.totalCycles} circular dependenc${result.totalCycles === 1 ? "y" : "ies"}:\n\n`;

      for (let i = 0; i < result.cycles.length; i++) {
        const cycle = result.cycles[i];
        text += `Cycle ${i + 1} (${cycle.length} files):\n`;
        const formatted = cycle.map((f) => formatPath(f, root));
        text += `  ${formatted.join(" -> ")} -> ${formatted[0]}\n\n`;
      }

      if (result.totalCycles > result.cycles.length) {
        text += `... and ${result.totalCycles - result.cycles.length} more cycles (showing first ${result.cycles.length}).\n`;
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

// Tool: class_hierarchy
server.tool(
  "class_hierarchy",
  "Get class inheritance hierarchy, methods, and subclass overrides. Provide either a class name, a file path, or a method name to find all classes that define/override it.",
  {
    class_name: z
      .string()
      .optional()
      .describe("Class name to look up (e.g. 'FuserInput', 'ActionConnector')"),
    file: z
      .string()
      .optional()
      .describe(
        "File path to get all classes defined in it (relative to project root)",
      ),
    method_name: z
      .string()
      .optional()
      .describe(
        "Method name to find all classes that define or override it (e.g. 'formatted_latest_buffer', 'connect')",
      ),
    project_root: projectRootParam,
  },
  async ({ class_name, file, method_name, project_root }) => {
    try {
      const root = resolveRoot(project_root);
      const graph = await getGraph(root);
      const hierarchy = graph.classHierarchy;

      if (method_name) {
        const overriders = getMethodOverriders(hierarchy, method_name, root);
        if (overriders.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No classes found that define or override method "${method_name}".`,
              },
            ],
          };
        }

        const definers = overriders.filter((o) => o.relationship === "defines");
        const overrides = overriders.filter(
          (o) => o.relationship === "overrides",
        );

        let text = `Method "${method_name}" found in ${overriders.length} class(es):\n\n`;

        if (definers.length > 0) {
          text += `Defined in (${definers.length}):\n`;
          for (const d of definers) {
            text += `  ${d.className} (${d.file})\n`;
          }
          text += "\n";
        }

        if (overrides.length > 0) {
          text += `Overridden in (${overrides.length}):\n`;
          for (const o of overrides) {
            text += `  ${o.className} (${o.file})\n`;
          }
        }

        return { content: [{ type: "text", text }] };
      }

      if (class_name) {
        const info = getClassInfo(hierarchy, class_name, root);
        if (!info) {
          return {
            content: [
              {
                type: "text",
                text: `Class "${class_name}" not found in the project.`,
              },
            ],
          };
        }

        let text = `Class: ${info.className}\n`;
        text += `File: ${info.file}\n`;

        if (info.bases.length > 0) {
          text += `Bases: ${info.bases.join(", ")}\n`;
        }

        if (info.ancestors.length > 0) {
          text += `Ancestor chain: ${info.ancestors.join(" -> ")}\n`;
        }

        if (info.methods.length > 0) {
          text += `\nMethods (${info.methods.length}):\n`;
          text += info.methods.map((m) => `  - ${m}`).join("\n");
          text += "\n";
        }

        if (info.subclasses.length > 0) {
          text += `\nSubclasses (${info.subclasses.length}):\n`;
          for (const sub of info.subclasses) {
            text += `  ${sub.name} (${sub.file})\n`;
            if (sub.overriddenMethods.length > 0) {
              text += `    overrides: ${sub.overriddenMethods.join(", ")}\n`;
            }
            if (sub.newMethods.length > 0) {
              text += `    new methods: ${sub.newMethods.join(", ")}\n`;
            }
          }
        }

        return { content: [{ type: "text", text }] };
      }

      if (file) {
        const absPath = resolveFilePath(file, root);
        const classes = getFileClasses(hierarchy, absPath, root);
        if (classes.length === 0) {
          return {
            content: [
              { type: "text", text: `No classes found in ${file}.` },
            ],
          };
        }

        let text = `Classes in ${file}:\n\n`;
        for (const cls of classes) {
          text += `class ${cls.className}`;
          if (cls.bases.length > 0) {
            text += `(${cls.bases.join(", ")})`;
          }
          text += "\n";

          if (cls.methods.length > 0) {
            text += `  methods: ${cls.methods.join(", ")}\n`;
          }
          if (cls.subclasses.length > 0) {
            text += `  subclasses: ${cls.subclasses.map((s) => s.name).join(", ")}\n`;
          }
          text += "\n";
        }

        return { content: [{ type: "text", text }] };
      }

      return {
        content: [
          {
            type: "text",
            text: "Provide either 'class_name', 'file', or 'method_name' parameter.",
          },
        ],
        isError: true,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

// Tool: file_churn
server.tool(
  "file_churn",
  "Analyze file change frequency from git history. Shows which files change most often - useful for identifying hotspots and assessing change risk.",
  {
    days: z
      .number()
      .optional()
      .describe("Number of days to analyze (default: 90)"),
    project_root: projectRootParam,
  },
  async ({ days, project_root }) => {
    try {
      const root = resolveRoot(project_root);
      const period = days || 90;
      const result = getFileChurn(root, period);

      if (result.files.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No file changes found in the last ${period} days.`,
            },
          ],
        };
      }

      let text = `File churn (last ${result.period}, ${result.totalCommits} commits):\n\n`;
      text += `${"File".padEnd(60)} ${"Commits".padStart(8)} ${"Last Changed".padStart(12)}\n`;
      text += `${"─".repeat(60)} ${"─".repeat(8)} ${"─".repeat(12)}\n`;

      for (const entry of result.files) {
        const name =
          entry.file.length > 58
            ? "..." + entry.file.slice(-55)
            : entry.file;
        text += `${name.padEnd(60)} ${String(entry.commits).padStart(8)} ${entry.lastChanged.padStart(12)}\n`;
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

// Tool: co_change
server.tool(
  "co_change",
  "Find files that frequently change together with a given file. Reveals hidden coupling not visible in import graph.",
  {
    file: z
      .string()
      .describe("File to analyze co-changes for (relative to project root)"),
    days: z
      .number()
      .optional()
      .describe("Number of days to analyze (default: 90)"),
    project_root: projectRootParam,
  },
  async ({ file, days, project_root }) => {
    try {
      const root = resolveRoot(project_root);
      const period = days || 90;
      const result = getCoChanges(root, file, period);

      if (result.targetChanges === 0) {
        return {
          content: [
            {
              type: "text",
              text: `"${file}" has no changes in the last ${period} days.`,
            },
          ],
        };
      }

      if (result.coChanges.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `"${file}" changed ${result.targetChanges} times but always alone.`,
            },
          ],
        };
      }

      let text = `Co-change analysis for ${result.targetFile} (${result.targetChanges} changes in ${result.period}):\n\n`;
      text += `${"File".padEnd(55)} ${"Together".padStart(9)} ${"Total".padStart(6)} ${"Corr".padStart(5)}\n`;
      text += `${"─".repeat(55)} ${"─".repeat(9)} ${"─".repeat(6)} ${"─".repeat(5)}\n`;

      for (const entry of result.coChanges) {
        const name =
          entry.file.length > 53
            ? "..." + entry.file.slice(-50)
            : entry.file;
        text += `${name.padEnd(55)} ${String(entry.coChangeCount).padStart(9)} ${String(entry.totalChanges).padStart(6)} ${entry.correlation.toFixed(2).padStart(5)}\n`;
      }

      text += `\nCorrelation = co-changes / min(target changes, file changes). Higher = stronger coupling.`;

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

// Tool: package_dependencies
server.tool(
  "package_dependencies",
  "Get package/module level dependency view. Aggregates file-level edges into package-level relationships to show architectural structure.",
  {
    depth: z
      .number()
      .optional()
      .describe(
        "Directory depth for package grouping (default: 2). e.g. depth=2 groups 'src/actions/move/connector/ros2.py' as 'src/actions'",
      ),
    package_name: z
      .string()
      .optional()
      .describe(
        "Filter to show only a specific package and its relationships (e.g. 'src/actions')",
      ),
    project_root: projectRootParam,
  },
  async ({ depth, package_name, project_root }) => {
    try {
      const root = resolveRoot(project_root);
      const graph = await getGraph(root);
      const result = getPackageDependencies(graph, root, depth || 2);

      if (package_name) {
        const pkg = result.packages.find((p) => p.name === package_name);
        if (!pkg) {
          return {
            content: [
              {
                type: "text",
                text: `Package "${package_name}" not found. Available packages:\n${result.packages.map((p) => `  ${p.name} (${p.fileCount} files)`).join("\n")}`,
              },
            ],
          };
        }

        let text = `Package: ${pkg.name} (${pkg.fileCount} files, ${pkg.internalEdges} internal edges)\n\n`;

        if (pkg.dependsOn.length > 0) {
          text += `Depends on (${pkg.dependsOn.length}):\n`;
          for (const dep of pkg.dependsOn) {
            text += `  -> ${dep.pkg} (${dep.connections} connections)\n`;
          }
          text += "\n";
        }

        if (pkg.dependedOnBy.length > 0) {
          text += `Depended on by (${pkg.dependedOnBy.length}):\n`;
          for (const dep of pkg.dependedOnBy) {
            text += `  <- ${dep.pkg} (${dep.connections} connections)\n`;
          }
        }

        if (pkg.dependsOn.length === 0 && pkg.dependedOnBy.length === 0) {
          text += "No cross-package dependencies (self-contained package).";
        }

        return { content: [{ type: "text", text }] };
      }

      // Full overview
      let text = `Package Dependencies (depth=${depth || 2}, ${result.totalPackages} packages, ${result.totalCrossPackageEdges} cross-package edges):\n\n`;

      for (const pkg of result.packages) {
        const deps = pkg.dependsOn.map((d) => d.pkg).join(", ");
        const revDeps = pkg.dependedOnBy.map((d) => d.pkg).join(", ");

        text += `${pkg.name} (${pkg.fileCount} files)\n`;
        if (deps) text += `  -> ${deps}\n`;
        if (revDeps) text += `  <- ${revDeps}\n`;
        text += "\n";
      }

      // Top cross-package edges
      if (result.edges.length > 0) {
        text += `\nStrongest cross-package connections:\n`;
        for (const edge of result.edges.slice(0, 15)) {
          text += `  ${edge.from} -> ${edge.to} (${edge.connections})\n`;
        }
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("codebase-graph-mcp server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
