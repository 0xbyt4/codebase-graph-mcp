import { readdir, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, extname, sep } from "node:path";
import { parseImports, readFileContent, isSupportedFile, clearParserCaches } from "./parser.js";
import {
  parseConfigDependencies,
  type ConfigDependency,
} from "./config-parser.js";
import {
  parseCargoDependencies,
  type CargoDependency,
} from "./cargo-parser.js";
import {
  buildClassHierarchy,
  type ClassHierarchy,
} from "./class-analyzer.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "site-packages",
  "vendor",
  "third_party",
  "Pods",
  "dist",
  "build",
  "out",
  "target",
  ".turbo",
  "coverage",
  ".cache",
]);

// Hard ceiling on scanned files; beyond this the graph is too large to be
// useful in a tool response and the scan would block the server for minutes.
export const MAX_FILES = 50_000;

export interface GraphData {
  // file -> files it depends on
  dependencies: Map<string, Set<string>>;
  // file -> files that depend on it
  dependents: Map<string, Set<string>>;
  // "from\0to" for edges that only exist for the type checker
  // (TS `import type`, Python `if TYPE_CHECKING:`); excluded from cycles
  typeOnlyEdges: Set<string>;
  // "from\0to" for Rust `mod name;` declarations; excluded from cycles
  declarationEdges: Set<string>;
  // all tracked files
  files: Set<string>;
  // true when collectFiles hit MAX_FILES and stopped early
  truncated: boolean;
  // config -> Python module edges
  configDependencies: ConfigDependency[];
  // Cargo.toml cross-crate edges (Rust workspaces)
  cargoDependencies: CargoDependency[];
  // class hierarchy (Python only)
  classHierarchy: ClassHierarchy;
}

export interface ImpactResult {
  target: string;
  directlyAffected: string[];
  indirectlyAffected: string[];
  totalAffectedFiles: number;
}

export interface ProjectOverview {
  totalFiles: number;
  totalEdges: number;
  entryPoints: string[];
  mostImported: { file: string; count: number }[];
  orphanFiles: string[];
  filesByType: Record<string, number>;
}

export interface MultiFileImpactResult {
  changedFiles: string[];
  directlyAffected: string[];
  indirectlyAffected: string[];
  totalAffectedFiles: number;
  perFileBreakdown: { file: string; totalImpact: number }[];
}

export interface CycleResult {
  // shortest cycle of each strongly connected component (first 20)
  cycles: string[][];
  totalCycles: number;
  // size of the strongly connected group each reported cycle was taken from;
  // a 2-file loop can be the shortest path through hundreds of entangled files
  groupSizes: number[];
  // number of files that belong to any cycle group
  filesInCycles: number;
}

export interface PackageEdge {
  from: string;
  to: string;
  connections: number;
}

export interface PackageInfo {
  name: string;
  fileCount: number;
  internalEdges: number;
  dependsOn: { pkg: string; connections: number }[];
  dependedOnBy: { pkg: string; connections: number }[];
}

export interface PackageDependencyResult {
  packages: PackageInfo[];
  edges: PackageEdge[];
  totalPackages: number;
  totalCrossPackageEdges: number;
}

export function edgeKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

export function isTypeOnlyEdge(graph: GraphData, from: string, to: string): boolean {
  return graph.typeOnlyEdges.has(edgeKey(from, to));
}

/** True when `from` imports `to` in a way that exists at runtime (not type-only, not a Rust mod declaration). */
export function isRuntimeEdge(graph: GraphData, from: string, to: string): boolean {
  if (!graph.dependencies.get(from)?.has(to)) return false;
  const key = edgeKey(from, to);
  return !graph.typeOnlyEdges.has(key) && !graph.declarationEdges.has(key);
}

export async function buildGraph(projectRoot: string): Promise<GraphData> {
  const graph: GraphData = {
    dependencies: new Map(),
    dependents: new Map(),
    typeOnlyEdges: new Set(),
    declarationEdges: new Set(),
    files: new Set(),
    truncated: false,
    configDependencies: [],
    cargoDependencies: [],
    classHierarchy: { classes: new Map(), subclasses: new Map(), fileClasses: new Map() },
  };

  // tsconfig aliases may have changed since the last build
  clearParserCaches();

  const { files: allFiles, truncated } = await collectFiles(projectRoot);
  graph.truncated = truncated;

  for (const filePath of allFiles) {
    graph.files.add(filePath);
    const content = readFileContent(filePath);
    if (!content) continue;

    const imports = parseImports(filePath, content, projectRoot);
    const deps = new Set<string>();

    for (const imp of imports) {
      if (!imp.resolved || imp.resolved === filePath) continue;

      // An edge is type-only unless at least one value import targets it.
      const key = edgeKey(filePath, imp.resolved);
      if (!imp.typeOnly) graph.typeOnlyEdges.delete(key);
      else if (!deps.has(imp.resolved)) graph.typeOnlyEdges.add(key);
      if (imp.declaration) graph.declarationEdges.add(key);
      deps.add(imp.resolved);

      // Build reverse index
      if (!graph.dependents.has(imp.resolved)) {
        graph.dependents.set(imp.resolved, new Set());
      }
      graph.dependents.get(imp.resolved)!.add(filePath);
    }

    graph.dependencies.set(filePath, deps);
  }

  // Parse config files and add config -> module edges
  const configDeps = parseConfigDependencies(projectRoot);
  graph.configDependencies = configDeps;

  for (const dep of configDeps) {
    // Add config file to files set
    graph.files.add(dep.configFile);

    // Add dependency edge: config -> target module
    if (!graph.dependencies.has(dep.configFile)) {
      graph.dependencies.set(dep.configFile, new Set());
    }
    graph.dependencies.get(dep.configFile)!.add(dep.targetFile);

    // Add reverse edge: target module -> config depends on it
    if (!graph.dependents.has(dep.targetFile)) {
      graph.dependents.set(dep.targetFile, new Set());
    }
    graph.dependents.get(dep.targetFile)!.add(dep.configFile);
  }

  // Parse Cargo.toml workspace for cross-crate dependency edges
  const cargoDeps = parseCargoDependencies(projectRoot);
  graph.cargoDependencies = cargoDeps;

  for (const dep of cargoDeps) {
    graph.files.add(dep.sourceFile);
    graph.files.add(dep.targetFile);

    if (!graph.dependencies.has(dep.sourceFile)) {
      graph.dependencies.set(dep.sourceFile, new Set());
    }
    graph.dependencies.get(dep.sourceFile)!.add(dep.targetFile);

    if (!graph.dependents.has(dep.targetFile)) {
      graph.dependents.set(dep.targetFile, new Set());
    }
    graph.dependents.get(dep.targetFile)!.add(dep.sourceFile);
  }

  // Build class hierarchy from Python files
  graph.classHierarchy = buildClassHierarchy(graph.files);

  return graph;
}

export function getDependencies(
  graph: GraphData,
  filePath: string,
): string[] {
  const deps = graph.dependencies.get(filePath);
  return deps ? Array.from(deps) : [];
}

export function getDependents(graph: GraphData, filePath: string): string[] {
  const deps = graph.dependents.get(filePath);
  return deps ? Array.from(deps) : [];
}

export function getImpactAnalysis(
  graph: GraphData,
  filePath: string,
): ImpactResult {
  const directlyAffected = getDependents(graph, filePath);
  const indirectlyAffected = new Set<string>();
  const visited = new Set<string>([filePath]);

  // BFS to find all transitive dependents
  const queue = [...directlyAffected];
  for (const dep of directlyAffected) {
    visited.add(dep);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextDeps = getDependents(graph, current);

    for (const dep of nextDeps) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      indirectlyAffected.add(dep);
      queue.push(dep);
    }
  }

  return {
    target: filePath,
    directlyAffected,
    indirectlyAffected: Array.from(indirectlyAffected),
    totalAffectedFiles: directlyAffected.length + indirectlyAffected.size,
  };
}

export function getMultiFileImpact(
  graph: GraphData,
  filePaths: string[],
): MultiFileImpactResult {
  const changedSet = new Set(filePaths);
  const directlyAffected = new Set<string>();
  const allVisited = new Set<string>(filePaths);

  // Collect direct dependents of all changed files
  for (const filePath of filePaths) {
    const deps = getDependents(graph, filePath);
    for (const dep of deps) {
      if (!changedSet.has(dep)) {
        directlyAffected.add(dep);
      }
      allVisited.add(dep);
    }
  }

  // BFS from direct dependents to find indirect
  const indirectlyAffected = new Set<string>();
  const queue = [...directlyAffected];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextDeps = getDependents(graph, current);
    for (const dep of nextDeps) {
      if (allVisited.has(dep)) continue;
      allVisited.add(dep);
      indirectlyAffected.add(dep);
      queue.push(dep);
    }
  }

  // Per-file breakdown: impact count for each changed file
  const perFileBreakdown: { file: string; totalImpact: number }[] = [];
  for (const filePath of filePaths) {
    const impact = getImpactAnalysis(graph, filePath);
    perFileBreakdown.push({
      file: filePath,
      totalImpact: impact.totalAffectedFiles,
    });
  }
  perFileBreakdown.sort((a, b) => b.totalImpact - a.totalImpact);

  return {
    changedFiles: filePaths,
    directlyAffected: Array.from(directlyAffected),
    indirectlyAffected: Array.from(indirectlyAffected),
    totalAffectedFiles: directlyAffected.size + indirectlyAffected.size,
    perFileBreakdown,
  };
}

// Edges that can form a real cycle: tracked files, excluding type-only
// imports and Rust module declarations.
function runtimeDeps(graph: GraphData, file: string): string[] {
  const deps = graph.dependencies.get(file);
  if (!deps) return [];
  const out: string[] = [];
  for (const dep of deps) {
    const key = edgeKey(file, dep);
    if (graph.files.has(dep) && !graph.typeOnlyEdges.has(key) && !graph.declarationEdges.has(key)) out.push(dep);
  }
  return out;
}

/**
 * Detect circular dependencies using Tarjan's SCC algorithm (iterative, so
 * deep import chains cannot overflow the call stack). Type-only imports are
 * ignored: they are the standard way to break a runtime cycle.
 * Each reported cycle lists every file once, in import order.
 */
export function detectCycles(graph: GraphData): CycleResult {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongConnect(root: string): void {
    // Explicit DFS stack: node plus its position in its dependency list.
    const work: { v: string; deps: string[]; i: number }[] = [];
    const push = (v: string) => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      work.push({ v, deps: runtimeDeps(graph, v), i: 0 });
    };
    push(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.i < frame.deps.length) {
        const w = frame.deps[frame.i++];
        if (!indices.has(w)) {
          push(w);
        } else if (onStack.has(w)) {
          lowlinks.set(frame.v, Math.min(lowlinks.get(frame.v)!, indices.get(w)!));
        }
        continue;
      }

      work.pop();
      const { v } = frame;
      if (work.length > 0) {
        const parent = work[work.length - 1].v;
        lowlinks.set(parent, Math.min(lowlinks.get(parent)!, lowlinks.get(v)!));
      }

      if (lowlinks.get(v) === indices.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);

        if (scc.length > 1) {
          sccs.push(scc.reverse());
        } else if (frame.deps.includes(v)) {
          // A file that imports itself
          sccs.push(scc);
        }
      }
    }
  }

  for (const file of graph.files) {
    if (!indices.has(file)) strongConnect(file);
  }

  // Largest groups first: they are the ones that matter
  sccs.sort((a, b) => b.length - a.length);

  // Extract shortest cycle from each SCC (limit to 20)
  const cycles: string[][] = [];
  const groupSizes: number[] = [];
  for (const scc of sccs.slice(0, 20)) {
    const cycle = scc.length === 1 ? [scc[0]] : extractShortestCycle(graph, scc);
    if (!cycle) continue;
    cycles.push(cycle);
    groupSizes.push(scc.length);
  }

  return {
    cycles,
    totalCycles: sccs.length,
    groupSizes,
    filesInCycles: sccs.reduce((sum, scc) => sum + scc.length, 0),
  };
}

/**
 * Extract the shortest cycle from an SCC by doing BFS from each node.
 * The result contains each file once; the last file imports the first.
 */
function extractShortestCycle(
  graph: GraphData,
  scc: string[],
): string[] | null {
  const sccSet = new Set(scc);
  let shortest: string[] | null = null;

  // Limit BFS starts on huge SCCs to avoid O(V*E)
  const starts = scc.length > 1000 ? 5 : scc.length > 100 ? 20 : scc.length;
  const searchNodes = scc.slice(0, starts);

  for (const start of searchNodes) {
    for (const next of runtimeDeps(graph, start)) {
      if (!sccSet.has(next) || next === start) continue;

      // BFS from next back to start within the SCC
      const path = bfsPath(graph, next, start, sccSet);
      if (path) {
        const cycle = [start, ...path];
        if (!shortest || cycle.length < shortest.length) {
          shortest = cycle;
        }
      }
    }

    // Early exit if we found a 2-node cycle
    if (shortest && shortest.length === 2) break;
  }

  return shortest;
}

// Shortest path from `from` to a direct importer of `to`, so the returned
// list ends right before `to` and can be appended to a cycle head.
function bfsPath(
  graph: GraphData,
  from: string,
  to: string,
  within: Set<string>,
): string[] | null {
  const parent = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  let head = 0;

  while (head < queue.length) {
    const node = queue[head++];
    for (const next of runtimeDeps(graph, node)) {
      if (!within.has(next)) continue;
      if (next === to) {
        const path: string[] = [];
        for (let cur: string | null = node; cur !== null; cur = parent.get(cur) ?? null) path.push(cur);
        return path.reverse();
      }
      if (parent.has(next)) continue;
      parent.set(next, node);
      queue.push(next);
    }
  }

  return null;
}

/**
 * Get package-level dependency view by aggregating file-level edges.
 * depth controls how many directory segments form a "package".
 * e.g. depth=2 maps "src/actions/move/connector/ros2.py" → "src/actions"
 */
export function getPackageDependencies(
  graph: GraphData,
  projectRoot: string,
  depth: number = 2,
): PackageDependencyResult {
  // Map file to its package at given depth
  function getPackage(absPath: string): string {
    const rel = relative(projectRoot, absPath);
    const parts = rel.split("/");
    return parts.slice(0, depth).join("/");
  }

  // Count files per package
  const packageFiles = new Map<string, number>();
  for (const file of graph.files) {
    const pkg = getPackage(file);
    packageFiles.set(pkg, (packageFiles.get(pkg) || 0) + 1);
  }

  // Aggregate file edges into package edges
  const edgeMap = new Map<string, number>(); // "from|to" -> count
  const internalMap = new Map<string, number>(); // pkg -> internal edge count

  for (const [file, deps] of graph.dependencies.entries()) {
    const fromPkg = getPackage(file);
    for (const dep of deps) {
      if (!graph.files.has(dep)) continue;
      const toPkg = getPackage(dep);

      if (fromPkg === toPkg) {
        internalMap.set(fromPkg, (internalMap.get(fromPkg) || 0) + 1);
        continue;
      }

      const key = `${fromPkg}|${toPkg}`;
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }
  }

  // Build edges list
  const edges: PackageEdge[] = [];
  for (const [key, count] of edgeMap.entries()) {
    const [from, to] = key.split("|");
    edges.push({ from, to, connections: count });
  }
  edges.sort((a, b) => b.connections - a.connections);

  // Build per-package dependency info
  const dependsOnMap = new Map<string, Map<string, number>>();
  const dependedOnByMap = new Map<string, Map<string, number>>();

  for (const edge of edges) {
    if (!dependsOnMap.has(edge.from)) dependsOnMap.set(edge.from, new Map());
    dependsOnMap.get(edge.from)!.set(edge.to, edge.connections);

    if (!dependedOnByMap.has(edge.to)) dependedOnByMap.set(edge.to, new Map());
    dependedOnByMap.get(edge.to)!.set(edge.from, edge.connections);
  }

  const packages: PackageInfo[] = [];
  for (const [pkg, fileCount] of packageFiles.entries()) {
    const depsOn = dependsOnMap.get(pkg);
    const depsBy = dependedOnByMap.get(pkg);

    packages.push({
      name: pkg,
      fileCount,
      internalEdges: internalMap.get(pkg) || 0,
      dependsOn: depsOn
        ? Array.from(depsOn.entries())
            .map(([p, c]) => ({ pkg: p, connections: c }))
            .sort((a, b) => b.connections - a.connections)
        : [],
      dependedOnBy: depsBy
        ? Array.from(depsBy.entries())
            .map(([p, c]) => ({ pkg: p, connections: c }))
            .sort((a, b) => b.connections - a.connections)
        : [],
    });
  }

  // Sort: most connected packages first
  packages.sort(
    (a, b) =>
      b.dependsOn.length +
      b.dependedOnBy.length -
      (a.dependsOn.length + a.dependedOnBy.length),
  );

  return {
    packages,
    edges,
    totalPackages: packageFiles.size,
    totalCrossPackageEdges: edges.reduce((sum, e) => sum + e.connections, 0),
  };
}

export function getProjectOverview(
  graph: GraphData,
  projectRoot: string,
): ProjectOverview {
  // Count edges
  let totalEdges = 0;
  for (const deps of graph.dependencies.values()) {
    totalEdges += deps.size;
  }

  // Find entry points (files with no dependents)
  const entryPoints: string[] = [];
  for (const file of graph.files) {
    const deps = graph.dependents.get(file);
    if (!deps || deps.size === 0) {
      entryPoints.push(relative(projectRoot, file));
    }
  }

  // Find most imported files
  const importCounts: { file: string; count: number }[] = [];
  for (const [file, deps] of graph.dependents.entries()) {
    importCounts.push({ file: relative(projectRoot, file), count: deps.size });
  }
  importCounts.sort((a, b) => b.count - a.count);

  // Find orphan files (no dependencies and no dependents)
  const orphanFiles: string[] = [];
  for (const file of graph.files) {
    const deps = graph.dependencies.get(file);
    const revDeps = graph.dependents.get(file);
    const hasDeps = deps && deps.size > 0;
    const hasRevDeps = revDeps && revDeps.size > 0;
    if (!hasDeps && !hasRevDeps) {
      orphanFiles.push(relative(projectRoot, file));
    }
  }

  // Files by extension type
  const filesByType: Record<string, number> = {};
  for (const file of graph.files) {
    const ext = extname(file);
    filesByType[ext] = (filesByType[ext] || 0) + 1;
  }

  return {
    totalFiles: graph.files.size,
    totalEdges,
    entryPoints: entryPoints.slice(0, 20),
    mostImported: importCounts.slice(0, 10),
    orphanFiles: orphanFiles.slice(0, 20),
    filesByType,
  };
}

const MAX_DIR_DEPTH = 50;
const execFileAsync = promisify(execFile);

interface CollectResult {
  files: string[];
  truncated: boolean;
}

/**
 * Enumerate source files under the root. Inside a git repository the list
 * comes from `git ls-files`, so .gitignore is honoured (virtualenvs, vendored
 * bundles, generated code). Elsewhere the tree is walked with a fixed ignore
 * list. Symlinks are never followed.
 */
export async function collectFiles(root: string): Promise<CollectResult> {
  // An empty git listing means the root itself is ignored by an enclosing
  // repository; the walk is the better answer then.
  const fromGit = await collectFromGit(root);
  if (fromGit && fromGit.files.length > 0) return fromGit;

  const files: string[] = [];
  await walkDirectory(root, 0, files);
  return { files, truncated: files.length >= MAX_FILES };
}

// Git has already vetted tracked paths, so only directories that are never
// source are filtered out of its listing.
const GIT_IGNORE_DIRS = new Set(["node_modules", "__pycache__", ".git"]);

async function gitListFiles(root: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", ...args], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout.split("\0").filter(Boolean);
}

async function collectFromGit(root: string): Promise<CollectResult | null> {
  let tracked: string[];
  let others: string[];
  try {
    // Submodule contents are part of the project; fall back for git versions
    // or checkouts where recursion is not possible.
    tracked = await gitListFiles(root, ["--cached", "--recurse-submodules"]).catch(() =>
      gitListFiles(root, ["--cached"]),
    );
    others = await gitListFiles(root, ["--others", "--exclude-standard"]);
  } catch {
    return null; // not a repository, or git missing
  }

  const files: string[] = [];
  const seen = new Set<string>();
  // Tracked paths were vetted by whoever committed them; untracked ones get
  // the same ignore list as a plain directory walk (a stray venv, build dir).
  const add = async (rel: string, ignore: Set<string>) => {
    if (!isSupportedFile(rel)) return;
    if (rel.split("/").some((seg) => ignore.has(seg))) return;
    const fullPath = join(root, rel.split("/").join(sep));
    if (seen.has(fullPath)) return;
    seen.add(fullPath);
    try {
      const info = await lstat(fullPath);
      if (info.isFile()) files.push(fullPath);
    } catch {
      // listed but deleted in the working tree
    }
  };

  for (const rel of tracked) {
    if (files.length >= MAX_FILES) return { files, truncated: true };
    await add(rel, GIT_IGNORE_DIRS);
  }
  for (const rel of others) {
    if (files.length >= MAX_FILES) return { files, truncated: true };
    if (rel.endsWith("/")) {
      // An untracked nested repository is listed as a bare directory; walk it.
      if (rel.split("/").some((seg) => IGNORE_DIRS.has(seg))) continue;
      const nested = join(root, rel.slice(0, -1).split("/").join(sep));
      const nestedFiles: string[] = [];
      await walkDirectory(nested, 0, nestedFiles);
      for (const f of nestedFiles) {
        if (!seen.has(f)) {
          seen.add(f);
          files.push(f);
        }
      }
      continue;
    }
    await add(rel, IGNORE_DIRS);
  }
  return { files, truncated: files.length >= MAX_FILES };
}

async function walkDirectory(dir: string, depth: number, files: string[]): Promise<void> {
  if (depth > MAX_DIR_DEPTH || files.length >= MAX_FILES) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // Unreadable directory: skip it instead of failing the whole scan
    console.error(`codebase-graph: skipping ${dir}: ${(error as Error).message}`);
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") || IGNORE_DIRS.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(fullPath, depth + 1, files);
    } else if (entry.isFile() && isSupportedFile(fullPath)) {
      files.push(fullPath);
    }
  }
}
