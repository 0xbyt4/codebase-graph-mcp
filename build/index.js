#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, relative, join } from "node:path";
import { writeFile, readFile, mkdir, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildGraph, getDependencies, getDependents, getImpactAnalysis, getMultiFileImpact, getProjectOverview, getPackageDependencies, detectCycles, isTypeOnlyEdge, MAX_FILES, } from "./graph.js";
import { getClassInfo, getFileClasses, getMethodOverriders } from "./class-analyzer.js";
import { getFileChurn, getCoChanges, changedFilesSince } from "./git-history.js";
import { normalizeRoot, resolveInsideRoot } from "./paths.js";
import { GENERATED_MARKER, buildGraphPage, buildAtlasIndex, pickAtlasScopes, atlasFileName, } from "./visualize.js";
// One version for the npm package, the plugin manifest and the server. A
// deployment that ships build/ without package.json still starts.
function readVersion() {
    try {
        return createRequire(import.meta.url)("../package.json").version;
    }
    catch {
        return "unknown";
    }
}
const VERSION = readVersion();
const server = new McpServer({
    name: "codebase-graph",
    version: VERSION,
});
// Cache: supports multiple project roots
const graphCache = new Map();
// PROJECT_ROOT is an explicit operator choice; CLAUDE_PROJECT_DIR is what
// Claude Code sets for a plugin-provided server; cwd is the last resort.
function getDefaultRoot() {
    return normalizeRoot(process.env.PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}
function resolveRoot(override) {
    if (!override)
        return getDefaultRoot();
    return normalizeRoot(resolve(getDefaultRoot(), override));
}
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// MCP tool annotations: every tool only reads the project, except
// visualize_graph, which writes HTML pages inside it (never over foreign files)
// and opens a browser tab on each call, so it is not idempotent.
const READ_ONLY_TOOL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES_PAGES_TOOL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
async function getGraph(root) {
    const cached = graphCache.get(root);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS)
        return cached.data;
    const graph = await buildGraph(root);
    graphCache.set(root, { data: graph, createdAt: Date.now() });
    return graph;
}
function resolveFilePath(file, root) {
    return resolveInsideRoot(file, root);
}
// A file the scan never saw gets an error, not "no dependencies": a typo or
// an unsupported extension must not read as "safe to delete".
function requireInGraph(graph, absPath, file) {
    if (!graph.files.has(absPath)) {
        throw new Error(`${file} is not in the dependency graph (not found, ignored, or an unsupported file type). Check the path or call refresh_graph.`);
    }
}
function formatPath(absPath, root) {
    return relative(root, absPath);
}
function textResult(text) {
    return { content: [{ type: "text", text }] };
}
function errorResult(error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
function truncationNote(graph) {
    return graph.truncated
        ? `\n\nNote: scan stopped at ${MAX_FILES} files; results are partial.`
        : "";
}
const projectRootParam = z
    .string()
    .optional()
    .describe("Absolute path to project root. Defaults to PROJECT_ROOT env, then CLAUDE_PROJECT_DIR, then cwd.");
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const MAX_SUMMARY_DIRS = 12;
const limitParam = z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_LIMIT)
    .optional()
    .describe(`Maximum files listed per section (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}). A longer section is summarized by directory and shows its first entries.`);
// First two directory levels, so monorepo layouts (apps/web, packages/core)
// stay apart in a summary.
function summaryDir(relPath) {
    const dirs = relPath.split(/[\\/]/).slice(0, -1);
    return dirs.length === 0 ? "(project root)" : `${dirs.slice(0, 2).join("/")}/`;
}
// A hub file in a large project affects thousands of files; listing them all
// floods the caller's context and exceeds client output limits. A section
// longer than `limit` is reduced to per-directory counts plus `limit` entries.
function fileSection(title, files, root, limit, { order, rank, suffix } = {}) {
    const line = (f) => `  - ${formatPath(f, root)}${suffix ? suffix(f) : ""}`;
    if (files.length <= limit) {
        return `${title} (${files.length}):\n${files.map(line).join("\n")}\n\n`;
    }
    const counts = new Map();
    for (const f of files) {
        const dir = summaryDir(formatPath(f, root));
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    const dirs = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shownDirs = dirs.slice(0, MAX_SUMMARY_DIRS);
    const restFiles = dirs.slice(MAX_SUMMARY_DIRS).reduce((sum, [, n]) => sum + n, 0);
    let text = `${title} (${files.length}), by directory:\n`;
    text += shownDirs.map(([dir, n]) => `  ${dir}  ${n}`).join("\n");
    if (restFiles > 0)
        text += `\n  (${dirs.length - MAX_SUMMARY_DIRS} other directories)  ${restFiles}`;
    const shown = (rank ? [...files].sort(rank) : files).slice(0, limit);
    text += `\nShowing ${shown.length} of ${files.length}${order ? `, ${order}` : ""}:\n`;
    text += shown.map(line).join("\n");
    return `${text}\n\n`;
}
function limitNote(limit, ...sections) {
    return sections.some((s) => s.length > limit)
        ? `\n\nLong sections are capped at ${limit} files; raise "limit" (max ${MAX_LIST_LIMIT}) to list more.`
        : "";
}
// Files that many others depend on come first: a break there spreads furthest.
function byDependentCount(graph) {
    const count = (f) => graph.dependents.get(f)?.size ?? 0;
    return (a, b) => count(b) - count(a) || a.localeCompare(b);
}
// Tool: get_dependencies
server.registerTool("get_dependencies", {
    annotations: { title: "Get dependencies", ...READ_ONLY_TOOL },
    description: "Get all files that a given file imports/depends on. Accepts a relative path from project root. Type-only imports (TS `import type`, Python TYPE_CHECKING) are marked.",
    inputSchema: {
        file: z.string().describe("Relative file path from project root (e.g. src/index.ts)"),
        project_root: projectRootParam,
    },
}, async ({ file, project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const graph = await getGraph(root);
        const absPath = resolveFilePath(file, root);
        requireInGraph(graph, absPath, file);
        const deps = getDependencies(graph, absPath);
        if (deps.length === 0) {
            return textResult(`${file} has no project dependencies.`);
        }
        const formatted = deps
            .map((d) => `  - ${formatPath(d, root)}${isTypeOnlyEdge(graph, absPath, d) ? " (type-only)" : ""}`)
            .join("\n");
        return textResult(`${file} depends on ${deps.length} file(s):\n${formatted}`);
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: get_dependents
server.registerTool("get_dependents", {
    annotations: { title: "Get dependents", ...READ_ONLY_TOOL },
    description: "Get all files that import/depend on a given file. Useful to know what breaks if you change this file. A long list is summarized by directory; raise `limit` to see more.",
    inputSchema: {
        file: z.string().describe("Relative file path from project root (e.g. src/utils/auth.ts)"),
        limit: limitParam,
        project_root: projectRootParam,
    },
}, async ({ file, limit = DEFAULT_LIST_LIMIT, project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const graph = await getGraph(root);
        const absPath = resolveFilePath(file, root);
        requireInGraph(graph, absPath, file);
        const deps = getDependents(graph, absPath);
        if (deps.length === 0) {
            return textResult(`No files depend on ${file}. It may be an entry point, or it is only referenced in ways the parser does not track (dynamic paths, config files, tests outside the scan).${truncationNote(graph)}`);
        }
        const section = fileSection(`Files that depend on ${file}`, deps, root, limit, {
            order: "most depended-on first",
            rank: byDependentCount(graph),
            suffix: (d) => (isTypeOnlyEdge(graph, d, absPath) ? " (type-only)" : ""),
        });
        return textResult(section.trimEnd() + limitNote(limit, deps) + truncationNote(graph));
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: impact_analysis
server.registerTool("impact_analysis", {
    annotations: { title: "Impact analysis", ...READ_ONLY_TOOL },
    description: "Analyze the full impact of changing a file. Shows directly and indirectly affected files through the dependency chain. Large results are summarized by directory with the closest files listed; raise `limit` to see more.",
    inputSchema: {
        file: z.string().describe("Relative file path from project root to analyze impact for"),
        limit: limitParam,
        project_root: projectRootParam,
    },
}, async ({ file, limit = DEFAULT_LIST_LIMIT, project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const graph = await getGraph(root);
        const absPath = resolveFilePath(file, root);
        requireInGraph(graph, absPath, file);
        const impact = getImpactAnalysis(graph, absPath);
        if (impact.totalAffectedFiles === 0) {
            return textResult(`Changing ${file} has no impact on other tracked files. It may be an entry point.${truncationNote(graph)}`);
        }
        let text = `Impact analysis for ${file}:\n\n`;
        if (impact.directlyAffected.length > 0) {
            text += fileSection("Directly affected", impact.directlyAffected, root, limit, {
                order: "most depended-on first",
                rank: byDependentCount(graph),
            });
        }
        if (impact.indirectlyAffected.length > 0) {
            // already in breadth-first order, so the head of the list is the closest
            text += fileSection("Indirectly affected", impact.indirectlyAffected, root, limit, {
                order: "closest first",
            });
        }
        text += `Total affected files: ${impact.totalAffectedFiles}`;
        text += limitNote(limit, impact.directlyAffected, impact.indirectlyAffected);
        return textResult(text + truncationNote(graph));
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: project_overview
server.registerTool("project_overview", {
    annotations: { title: "Project overview", ...READ_ONLY_TOOL },
    description: "Get a high-level overview of the project's dependency structure. Shows file counts, most imported files, entry points, and orphan files.",
    inputSchema: {
        project_root: projectRootParam,
    },
}, async ({ project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const graph = await getGraph(root);
        const overview = getProjectOverview(graph, root);
        let text = `Project Overview (${root}):\n\n`;
        text += `Files: ${overview.totalFiles}\n`;
        text += `Dependencies: ${overview.totalEdges}\n\n`;
        text += `File types:\n`;
        for (const [ext, count] of Object.entries(overview.filesByType).sort((a, b) => b[1] - a[1])) {
            text += `  ${ext}: ${count}\n`;
        }
        text += "\n";
        if (overview.mostImported.length > 0) {
            text += `Most imported files:\n`;
            for (const { file, count } of overview.mostImported) {
                text += `  ${file} (${count} dependents)\n`;
            }
            text += "\n";
        }
        if (overview.entryPoints.length > 0) {
            text += `Entry points (no dependents):\n`;
            for (const ep of overview.entryPoints)
                text += `  - ${ep}\n`;
            text += "\n";
        }
        if (overview.orphanFiles.length > 0) {
            text += `Orphan files (no dependencies, no dependents):\n`;
            for (const orphan of overview.orphanFiles)
                text += `  - ${orphan}\n`;
        }
        return textResult(text + truncationNote(graph));
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: refresh_graph
server.registerTool("refresh_graph", {
    annotations: { title: "Refresh graph", ...READ_ONLY_TOOL },
    description: "Force refresh the dependency graph cache. Use this after making file changes.",
    inputSchema: {
        project_root: projectRootParam,
    },
}, async ({ project_root }) => {
    try {
        const root = resolveRoot(project_root);
        graphCache.delete(root);
        const graph = await getGraph(root);
        return textResult(`Graph refreshed for ${root}. Tracking ${graph.files.size} files.${truncationNote(graph)}`);
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: multi_file_impact
server.registerTool("multi_file_impact", {
    annotations: { title: "Multi-file impact", ...READ_ONLY_TOOL },
    description: "Analyze the combined impact of multiple changed files. Accepts a list of files or a git diff ref to automatically detect changed files. Useful for PR reviews.",
    inputSchema: {
        files: z.array(z.string()).optional().describe("List of changed file paths (relative to project root)"),
        diff_ref: z
            .string()
            .optional()
            .describe('Git ref to diff against (e.g. "main", "HEAD~3"). Changed files are detected automatically.'),
        limit: limitParam,
        project_root: projectRootParam,
    },
}, async ({ files, diff_ref, limit = DEFAULT_LIST_LIMIT, project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const graph = await getGraph(root);
        let filePaths = [];
        if (diff_ref) {
            try {
                filePaths = changedFilesSince(diff_ref, root).map((f) => resolve(root, f));
            }
            catch (gitErr) {
                return errorResult(`Git error: ${gitErr instanceof Error ? gitErr.message : String(gitErr)}`);
            }
        }
        if (files) {
            for (const f of files) {
                const absPath = resolveFilePath(f, root);
                requireInGraph(graph, absPath, f);
                filePaths.push(absPath);
            }
        }
        if (filePaths.length === 0) {
            return errorResult(diff_ref
                ? `No changed files found between the working tree and "${diff_ref}".`
                : "No files specified. Provide either 'files' or 'diff_ref'.");
        }
        filePaths = [...new Set(filePaths)];
        const impact = getMultiFileImpact(graph, filePaths);
        let text = fileSection("Changed files", impact.changedFiles, root, limit);
        if (impact.directlyAffected.length > 0) {
            text += fileSection("Directly affected", impact.directlyAffected, root, limit, {
                order: "most depended-on first",
                rank: byDependentCount(graph),
            });
        }
        if (impact.indirectlyAffected.length > 0) {
            text += fileSection("Indirectly affected", impact.indirectlyAffected, root, limit, {
                order: "closest first",
            });
        }
        text += `Total affected files: ${impact.totalAffectedFiles}\n\n`;
        // sorted by impact, so a cut keeps the changes that matter most
        const breakdown = impact.perFileBreakdown.slice(0, limit);
        text += `Per-file breakdown${breakdown.length < impact.perFileBreakdown.length ? ` (top ${breakdown.length} of ${impact.perFileBreakdown.length})` : ""}:\n`;
        for (const { file, totalImpact } of breakdown) {
            text += `  ${formatPath(file, root)} -> ${totalImpact} total impact\n`;
        }
        text = text.trimEnd() + limitNote(limit, impact.changedFiles, impact.directlyAffected, impact.indirectlyAffected);
        return textResult(text + truncationNote(graph));
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: detect_cycles
server.registerTool("detect_cycles", {
    annotations: { title: "Detect cycles", ...READ_ONLY_TOOL },
    description: "Detect circular dependencies in the project. Uses Tarjan's SCC algorithm to find runtime dependency cycles; type-only imports are ignored.",
    inputSchema: {
        project_root: projectRootParam,
    },
}, async ({ project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const graph = await getGraph(root);
        const result = detectCycles(graph);
        if (result.totalCycles === 0) {
            return textResult(`No circular dependencies found.${truncationNote(graph)}`);
        }
        let text = `Found ${result.totalCycles} circular dependenc${result.totalCycles === 1 ? "y" : "ies"} involving ${result.filesInCycles} files:\n\n`;
        for (let i = 0; i < result.cycles.length; i++) {
            const cycle = result.cycles[i];
            const formatted = cycle.map((f) => formatPath(f, root));
            const group = result.groupSizes[i];
            text += `Cycle ${i + 1} (${cycle.length} file${cycle.length === 1 ? "" : "s"}`;
            if (group > cycle.length)
                text += `; shortest loop in a group of ${group} mutually dependent files`;
            text += `):\n  ${formatted.join(" -> ")} -> ${formatted[0]}\n\n`;
        }
        if (result.totalCycles > result.cycles.length) {
            text += `... and ${result.totalCycles - result.cycles.length} more cycles (showing first ${result.cycles.length}).\n`;
        }
        return textResult(text + truncationNote(graph));
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: class_hierarchy
server.registerTool("class_hierarchy", {
    annotations: { title: "Class hierarchy", ...READ_ONLY_TOOL },
    description: "Get Python class inheritance hierarchy, methods, and subclass overrides. Provide either a class name, a file path, or a method name to find all classes that define/override it.",
    inputSchema: {
        class_name: z.string().optional().describe("Class name to look up (e.g. 'BaseHandler', 'Connector')"),
        file: z
            .string()
            .optional()
            .describe("File path to get all classes defined in it (relative to project root)"),
        method_name: z
            .string()
            .optional()
            .describe("Method name to find all classes that define or override it (e.g. 'connect', 'render')"),
        project_root: projectRootParam,
    },
}, async ({ class_name, file, method_name, project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const graph = await getGraph(root);
        const hierarchy = graph.classHierarchy;
        if (method_name) {
            const overriders = getMethodOverriders(hierarchy, method_name, root);
            if (overriders.length === 0) {
                return textResult(`No classes found that define or override method "${method_name}".`);
            }
            const definers = overriders.filter((o) => o.relationship === "defines");
            const overrides = overriders.filter((o) => o.relationship === "overrides");
            let text = `Method "${method_name}" found in ${overriders.length} class(es):\n\n`;
            if (definers.length > 0) {
                text += `Defined in (${definers.length}):\n`;
                for (const d of definers)
                    text += `  ${d.className} (${d.file})\n`;
                text += "\n";
            }
            if (overrides.length > 0) {
                text += `Overridden in (${overrides.length}):\n`;
                for (const o of overrides)
                    text += `  ${o.className} (${o.file})\n`;
            }
            return textResult(text);
        }
        if (class_name) {
            const info = getClassInfo(hierarchy, class_name, root);
            if (!info)
                return textResult(`Class "${class_name}" not found in the project.`);
            let text = `Class: ${info.className}\n`;
            text += `File: ${info.file}\n`;
            if (info.bases.length > 0)
                text += `Bases: ${info.bases.join(", ")}\n`;
            if (info.ancestors.length > 0)
                text += `Ancestor chain: ${info.ancestors.join(" -> ")}\n`;
            if (info.methods.length > 0) {
                text += `\nMethods (${info.methods.length}):\n`;
                text += info.methods.map((m) => `  - ${m}`).join("\n");
                text += "\n";
            }
            if (info.subclasses.length > 0) {
                text += `\nSubclasses (${info.subclasses.length}):\n`;
                for (const sub of info.subclasses) {
                    text += `  ${sub.name} (${sub.file})\n`;
                    if (sub.overriddenMethods.length > 0)
                        text += `    overrides: ${sub.overriddenMethods.join(", ")}\n`;
                    if (sub.newMethods.length > 0)
                        text += `    new methods: ${sub.newMethods.join(", ")}\n`;
                }
            }
            return textResult(text);
        }
        if (file) {
            const absPath = resolveFilePath(file, root);
            requireInGraph(graph, absPath, file);
            const classes = getFileClasses(hierarchy, absPath, root);
            if (classes.length === 0)
                return textResult(`No classes found in ${file}.`);
            let text = `Classes in ${file}:\n\n`;
            for (const cls of classes) {
                text += `class ${cls.className}`;
                if (cls.bases.length > 0)
                    text += `(${cls.bases.join(", ")})`;
                text += "\n";
                if (cls.methods.length > 0)
                    text += `  methods: ${cls.methods.join(", ")}\n`;
                if (cls.subclasses.length > 0)
                    text += `  subclasses: ${cls.subclasses.map((s) => s.name).join(", ")}\n`;
                text += "\n";
            }
            return textResult(text);
        }
        return errorResult("Provide either 'class_name', 'file', or 'method_name' parameter.");
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: file_churn
server.registerTool("file_churn", {
    annotations: { title: "File churn", ...READ_ONLY_TOOL },
    description: "Analyze file change frequency from git history. Shows which files change most often - useful for identifying hotspots and assessing change risk.",
    inputSchema: {
        days: z.number().int().positive().max(365).optional().describe("Number of days to analyze (default: 90, max: 365)"),
        project_root: projectRootParam,
    },
}, async ({ days, project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const period = days || 90;
        const result = getFileChurn(root, period);
        if (result.files.length === 0) {
            return textResult(`No file changes found in the last ${period} days.`);
        }
        let text = `File churn (last ${result.period}, ${result.totalCommits} commits):\n\n`;
        text += `${"File".padEnd(56)} ${"Commits".padStart(7)} ${"First".padStart(10)} ${"Last".padStart(10)}\n`;
        text += `${"─".repeat(56)} ${"─".repeat(7)} ${"─".repeat(10)} ${"─".repeat(10)}\n`;
        for (const entry of result.files) {
            const name = entry.file.length > 54 ? "..." + entry.file.slice(-51) : entry.file;
            text += `${name.padEnd(56)} ${String(entry.commits).padStart(7)} ${entry.firstSeen.padStart(10)} ${entry.lastChanged.padStart(10)}\n`;
        }
        return textResult(text);
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: co_change
server.registerTool("co_change", {
    annotations: { title: "Co-change", ...READ_ONLY_TOOL },
    description: "Find files that frequently change together with a given file. Reveals hidden coupling not visible in import graph.",
    inputSchema: {
        file: z.string().describe("File to analyze co-changes for (relative to project root)"),
        days: z.number().int().positive().max(365).optional().describe("Number of days to analyze (default: 90, max: 365)"),
        project_root: projectRootParam,
    },
}, async ({ file, days, project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const period = days || 90;
        resolveFilePath(file, root); // rejects paths outside the root
        const result = getCoChanges(root, file, period);
        if (result.targetChanges === 0) {
            return textResult(`"${result.targetFile}" has no changes in the last ${period} days.`);
        }
        if (result.coChanges.length === 0) {
            return textResult(`"${result.targetFile}" changed ${result.targetChanges} times but always alone.`);
        }
        let text = `Co-change analysis for ${result.targetFile} (${result.targetChanges} changes in ${result.period}):\n\n`;
        text += `${"File".padEnd(55)} ${"Together".padStart(9)} ${"Total".padStart(6)} ${"Corr".padStart(5)}\n`;
        text += `${"─".repeat(55)} ${"─".repeat(9)} ${"─".repeat(6)} ${"─".repeat(5)}\n`;
        for (const entry of result.coChanges) {
            const name = entry.file.length > 53 ? "..." + entry.file.slice(-50) : entry.file;
            text += `${name.padEnd(55)} ${String(entry.coChangeCount).padStart(9)} ${String(entry.totalChanges).padStart(6)} ${entry.correlation.toFixed(2).padStart(5)}\n`;
        }
        text += `\nCorrelation = co-changes / min(target changes, file changes). Higher = stronger coupling.`;
        return textResult(text);
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: package_dependencies
server.registerTool("package_dependencies", {
    annotations: { title: "Package dependencies", ...READ_ONLY_TOOL },
    description: "Get package/module level dependency view. Aggregates file-level edges into package-level relationships to show architectural structure.",
    inputSchema: {
        depth: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe("Directory depth for package grouping (default: 2, max: 10). e.g. depth=2 groups 'src/actions/move/connector/ros2.py' as 'src/actions'"),
        package_name: z
            .string()
            .optional()
            .describe("Filter to show only a specific package and its relationships (e.g. 'src/actions')"),
        project_root: projectRootParam,
    },
}, async ({ depth, package_name, project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const graph = await getGraph(root);
        const result = getPackageDependencies(graph, root, depth || 2);
        if (package_name) {
            const pkg = result.packages.find((p) => p.name === package_name);
            if (!pkg) {
                return textResult(`Package "${package_name}" not found. Available packages:\n${result.packages.map((p) => `  ${p.name} (${p.fileCount} files)`).join("\n")}`);
            }
            let text = `Package: ${pkg.name} (${pkg.fileCount} files, ${pkg.internalEdges} internal edges)\n\n`;
            if (pkg.dependsOn.length > 0) {
                text += `Depends on (${pkg.dependsOn.length}):\n`;
                for (const dep of pkg.dependsOn)
                    text += `  -> ${dep.pkg} (${dep.connections} connections)\n`;
                text += "\n";
            }
            if (pkg.dependedOnBy.length > 0) {
                text += `Depended on by (${pkg.dependedOnBy.length}):\n`;
                for (const dep of pkg.dependedOnBy)
                    text += `  <- ${dep.pkg} (${dep.connections} connections)\n`;
            }
            if (pkg.dependsOn.length === 0 && pkg.dependedOnBy.length === 0) {
                text += "No cross-package dependencies (self-contained package).";
            }
            return textResult(text);
        }
        let text = `Package Dependencies (depth=${depth || 2}, ${result.totalPackages} packages, ${result.totalCrossPackageEdges} cross-package edges):\n\n`;
        for (const pkg of result.packages) {
            const deps = pkg.dependsOn.map((d) => d.pkg).join(", ");
            const revDeps = pkg.dependedOnBy.map((d) => d.pkg).join(", ");
            text += `${pkg.name} (${pkg.fileCount} files)\n`;
            if (deps)
                text += `  -> ${deps}\n`;
            if (revDeps)
                text += `  <- ${revDeps}\n`;
            text += "\n";
        }
        if (result.edges.length > 0) {
            text += `\nStrongest cross-package connections:\n`;
            for (const edge of result.edges.slice(0, 15)) {
                text += `  ${edge.from} -> ${edge.to} (${edge.connections})\n`;
            }
        }
        return textResult(text + truncationNote(graph));
    }
    catch (error) {
        return errorResult(error);
    }
});
// Tool: visualize_graph
server.registerTool("visualize_graph", {
    annotations: { title: "Visualize graph", ...WRITES_PAGES_TOOL },
    description: "Generate an interactive HTML dependency graph and try to open it in the browser. Files are nodes colored by directory, edges are dependency arrows, node size reflects how many files import it. With atlas=true it writes a whole folder instead: one graph for the project, one per major directory, and an index page with totals, hotspots and cycles.",
    inputSchema: {
        top: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe("Number of top most-imported files per graph (default: 40, max: 500). In atlas mode the whole-project graph shows twice as many."),
        scope: z
            .string()
            .optional()
            .describe("Directory to restrict the graph to (e.g. 'gateway', 'src/agent'). In atlas mode, the directory whose subdirectories get a graph each. Empty for the whole project."),
        atlas: z
            .boolean()
            .optional()
            .describe("Write an atlas: index.html plus one graph per major directory (default: false)"),
        max_scopes: z
            .number()
            .int()
            .positive()
            .max(20)
            .optional()
            .describe("Atlas mode: how many directories get their own graph, ranked by how often they are imported (default: 8, max: 20)"),
        output: z
            .string()
            .optional()
            .describe("Inside the project root: an .html file (default: codebase_graph.html), or in atlas mode a directory (default: codebase_atlas)"),
        open_browser: z
            .boolean()
            .optional()
            .describe("Open the generated page (the index in atlas mode) with the system browser (default: true)"),
        project_root: projectRootParam,
    },
}, async ({ top, scope, atlas, max_scopes, output, open_browser, project_root }) => {
    try {
        const root = resolveRoot(project_root);
        const graph = await getGraph(root);
        const topN = top || 40;
        const openNote = async (path) => open_browser === false
            ? "Not opened in browser."
            : (await openInBrowser(path))
                ? "Opened in browser."
                : "Could not open a browser; open the file manually.";
        if (atlas) {
            const outDir = resolveInsideRoot(output || "codebase_atlas", root);
            if (/\.html?$/i.test(outDir)) {
                return errorResult(`in atlas mode output is a directory, got ${outDir}`);
            }
            const scopes = pickAtlasScopes(graph, root, scope, max_scopes || 8);
            const overallTop = Math.min(500, topN * 2);
            const entries = [
                {
                    title: scope ? `${scope.replace(/\/+$/, "")}/ (everything)` : "Whole project",
                    href: "all.html",
                    scope,
                    page: buildGraphPage(graph, root, { scope, top: overallTop, backLink: "index.html" }),
                },
                ...scopes.map((s) => ({
                    title: `${s.scope}/`,
                    href: atlasFileName(s.scope),
                    scope: s.scope,
                    files: s.files,
                    importers: s.importers,
                    page: buildGraphPage(graph, root, { scope: s.scope, top: topN, backLink: "index.html" }),
                })),
            ];
            const pages = [
                ["index.html", buildAtlasIndex(graph, root, scope, entries)],
                ...entries.map((e) => [e.href, e.page.html]),
            ];
            // Check every target before writing any, so a refusal leaves nothing half done
            for (const [name] of pages)
                await assertOverwritable(join(outDir, name));
            await mkdir(outDir, { recursive: true });
            for (const [name, html] of pages)
                await writeFile(join(outDir, name), html, "utf-8");
            const indexPath = join(outDir, "index.html");
            const list = entries.map((e) => `  ${e.href.padEnd(28)} ${e.title} (${e.page.nodeCount} nodes, ${e.page.edgeCount} edges)`).join("\n");
            const pulseHint = `Live pulse (Python programs): run the program through the sampler and the pages light up where it executes.\n` +
                `  python ${PULSE_SCRIPT} --root ${root} --pages ${outDir} --open -m your.module\n` +
                `  (use -c package.module:function for a console-script entry point, or give a script path)`;
            return textResult(`Atlas saved to ${outDir}\n\n  index.html\n${list}\n\n${await openNote(indexPath)}${truncationNote(graph)}\n\n${pulseHint}`);
        }
        const outputPath = resolveInsideRoot(output || "codebase_graph.html", root);
        if (!/\.html?$/i.test(outputPath)) {
            return errorResult(`output must be an .html file, got ${outputPath}`);
        }
        await assertOverwritable(outputPath);
        const page = buildGraphPage(graph, root, { scope, top: topN });
        await writeFile(outputPath, page.html, "utf-8");
        const topList = page.topFiles
            .slice(0, 10)
            .map(([f, c]) => `  ${c} <- ${f}`)
            .join("\n");
        return textResult(`Graph saved to ${outputPath}\n\nNodes: ${page.nodeCount}\nEdges: ${page.edgeCount}\n\nTop 10 most imported:\n${topList}\n\n${await openNote(outputPath)}`);
    }
    catch (error) {
        return errorResult(error);
    }
});
// The sampler that feeds live "pulse" mode ships next to the build output.
const PULSE_SCRIPT = fileURLToPath(new URL("../pulse/codebase_pulse.py", import.meta.url));
// visualize_graph only ever replaces files it generated itself.
// Symlinks are refused outright: writeFile would follow one, and a dangling
// link is invisible to the containment check because it cannot be resolved.
async function assertOverwritable(path) {
    let stat;
    try {
        stat = await lstat(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    if (stat.isSymbolicLink())
        throw new Error(`refusing to write ${path}: it is a symbolic link`);
    if (!stat.isFile())
        throw new Error(`refusing to write ${path}: not a regular file`);
    const head = (await readFile(path, "utf-8")).slice(0, 200);
    if (!head.includes(GENERATED_MARKER)) {
        throw new Error(`refusing to overwrite ${path}: it was not generated by this tool`);
    }
}
function openInBrowser(path) {
    const platform = process.platform;
    const [cmd, args] = platform === "darwin" ? ["open", [path]] :
        platform === "win32" ? ["cmd", ["/c", "start", "", path]] :
            ["xdg-open", [path]];
    return new Promise((done) => {
        execFile(cmd, args, { timeout: 5000 }, (error) => done(!error));
    });
}
// ═══════════════════════════════════════════════════════════════════
// Resources
// ═══════════════════════════════════════════════════════════════════
server.registerResource("project-overview", "codebase://overview", {
    description: "High-level project dependency overview: file counts, most imported files, entry points, orphans.",
    mimeType: "application/json",
}, async (uri) => {
    const root = getDefaultRoot();
    const graph = await getGraph(root);
    const overview = getProjectOverview(graph, root);
    return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(overview, null, 2) }],
    };
});
server.registerResource("dependency-graph", "codebase://graph", {
    description: "Full dependency graph as JSON adjacency list. Each file maps to its dependencies and dependents.",
    mimeType: "application/json",
}, async (uri) => {
    const root = getDefaultRoot();
    const graph = await getGraph(root);
    const data = {};
    for (const file of graph.files) {
        data[relative(root, file)] = {
            dependencies: [...(graph.dependencies.get(file) || [])].map((f) => relative(root, f)),
            dependents: [...(graph.dependents.get(file) || [])].map((f) => relative(root, f)),
        };
    }
    return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
    };
});
server.registerResource("circular-dependencies", "codebase://cycles", {
    description: "Circular dependency cycles detected in the project.",
    mimeType: "application/json",
}, async (uri) => {
    const root = getDefaultRoot();
    const graph = await getGraph(root);
    const result = detectCycles(graph);
    const cycles = result.cycles.map((cycle) => cycle.map((f) => relative(root, f)));
    return {
        contents: [
            {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({ totalCycles: result.totalCycles, filesInCycles: result.filesInCycles, groupSizes: result.groupSizes, cycles }, null, 2),
            },
        ],
    };
});
// ═══════════════════════════════════════════════════════════════════
// Prompts
// ═══════════════════════════════════════════════════════════════════
server.registerPrompt("analyze-impact", {
    description: "Analyze the impact of changing a file. Returns a structured prompt for the AI to reason about risks.",
    argsSchema: { file: z.string().describe("File path relative to project root") },
}, async ({ file }) => {
    const root = getDefaultRoot();
    const graph = await getGraph(root);
    const absPath = resolveFilePath(file, root);
    requireInGraph(graph, absPath, file);
    const impact = getImpactAnalysis(graph, absPath);
    const deps = getDependencies(graph, absPath).map((d) => relative(root, d));
    const revDeps = getDependents(graph, absPath).map((d) => relative(root, d));
    return {
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Analyze the risk of changing \`${file}\`:

**Dependencies** (${deps.length} files this imports):
${deps.map((d) => `- ${d}`).join("\n") || "None"}

**Dependents** (${revDeps.length} files that import this):
${revDeps.map((d) => `- ${d}`).join("\n") || "None"}

**Total impact**: ${impact.totalAffectedFiles} files affected (${impact.directlyAffected.length} direct, ${impact.indirectlyAffected.length} indirect)

What are the risks? What tests should be run? What files should be reviewed?`,
                },
            },
        ],
    };
});
server.registerPrompt("find-hotspots", {
    description: "Identify the riskiest files in the codebase based on dependency count, churn, and coupling.",
}, async () => {
    const root = getDefaultRoot();
    const graph = await getGraph(root);
    const overview = getProjectOverview(graph, root);
    let churnData = "";
    try {
        const churn = getFileChurn(root, 90);
        churnData = churn.files
            .slice(0, 15)
            .map((f) => `- ${f.file} (${f.commits} commits)`)
            .join("\n");
    }
    catch {
        churnData = "(git history not available)";
    }
    return {
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Identify the riskiest files in this codebase.

**Most imported files** (high dependency = high blast radius):
${overview.mostImported.map((f) => `- ${f.file} (${f.count} dependents)`).join("\n")}

**Most frequently changed files** (high churn = unstable):
${churnData}

**Total**: ${overview.totalFiles} files, ${overview.totalEdges} dependency edges

Which files are the highest risk? Where should we add tests? What refactoring would reduce risk?`,
                },
            },
        ],
    };
});
server.registerPrompt("review-pr", {
    description: "Generate a dependency-aware PR review checklist for changed files.",
    argsSchema: { diff_ref: z.string().describe("Git ref to diff against (e.g. 'main', 'HEAD~3')") },
}, async ({ diff_ref }) => {
    const root = getDefaultRoot();
    const graph = await getGraph(root);
    let changedFiles;
    try {
        changedFiles = changedFilesSince(diff_ref, root);
    }
    catch (error) {
        return {
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Could not get diff against "${diff_ref}": ${error instanceof Error ? error.message : String(error)}`,
                    },
                },
            ],
        };
    }
    const impact = getMultiFileImpact(graph, changedFiles.map((f) => resolve(root, f)));
    return {
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: `Review this PR (diff against \`${diff_ref}\`):

**Changed files** (${changedFiles.length}):
${changedFiles.map((f) => `- ${f}`).join("\n")}

**Directly affected** (${impact.directlyAffected.length} files import the changed files):
${impact.directlyAffected.map((f) => `- ${relative(root, f)}`).join("\n") || "None"}

**Indirectly affected** (${impact.indirectlyAffected.length}):
${impact.indirectlyAffected.map((f) => `- ${relative(root, f)}`).join("\n") || "None"}

**Total blast radius**: ${impact.totalAffectedFiles} files

Review checklist:
1. Are the directly affected files likely to break?
2. Are there missing test updates for affected files?
3. Are there circular dependency risks?
4. What's the rollback plan if this breaks?`,
                },
            },
        ],
    };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("codebase-graph-mcp server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
