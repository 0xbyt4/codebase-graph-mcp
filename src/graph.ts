import { readdir, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { parseImports, readFileContent, isSupportedFile } from "./parser.js";
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
  "dist",
  "build",
  "target",
  ".turbo",
  "coverage",
  ".cache",
]);

export interface GraphData {
  // file -> files it depends on
  dependencies: Map<string, Set<string>>;
  // file -> files that depend on it
  dependents: Map<string, Set<string>>;
  // all tracked files
  files: Set<string>;
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
  cycles: string[][];
  totalCycles: number;
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

export async function buildGraph(projectRoot: string): Promise<GraphData> {
  const graph: GraphData = {
    dependencies: new Map(),
    dependents: new Map(),
    files: new Set(),
    configDependencies: [],
    cargoDependencies: [],
    classHierarchy: { classes: new Map(), subclasses: new Map(), fileClasses: new Map() },
  };

  const allFiles = await collectFiles(projectRoot);

  for (const filePath of allFiles) {
    graph.files.add(filePath);
    const content = readFileContent(filePath);
    if (!content) continue;

    const imports = parseImports(filePath, content, projectRoot);
    const deps = new Set<string>();

    for (const imp of imports) {
      if (!imp.resolved) continue;

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

/**
 * Detect circular dependencies using Tarjan's SCC algorithm.
 * Returns SCCs with size > 1 (which contain cycles).
 */
export function detectCycles(graph: GraphData): CycleResult {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const deps = graph.dependencies.get(v);
    if (deps) {
      for (const w of deps) {
        if (!graph.files.has(w)) continue; // skip external
        if (!indices.has(w)) {
          strongConnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }
    }

    // Root of SCC
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
      } else if (scc.length === 1) {
        // Check for self-loop (file imports itself)
        const file = scc[0];
        const deps = graph.dependencies.get(file);
        if (deps?.has(file)) {
          sccs.push(scc);
        }
      }
    }
  }

  for (const file of graph.files) {
    if (!indices.has(file)) {
      strongConnect(file);
    }
  }

  // Extract shortest cycle from each SCC (limit to 20)
  const cycles: string[][] = [];
  for (const scc of sccs.slice(0, 20)) {
    if (scc.length === 1) {
      // Self-loop: report as [file, file]
      cycles.push([scc[0], scc[0]]);
    } else {
      const cycle = extractShortestCycle(graph, scc);
      if (cycle) {
        cycles.push(cycle);
      }
    }
  }

  return { cycles, totalCycles: sccs.length };
}

/**
 * Extract the shortest cycle from an SCC by doing BFS from each node.
 */
function extractShortestCycle(
  graph: GraphData,
  scc: string[],
): string[] | null {
  const sccSet = new Set(scc);
  let shortest: string[] | null = null;

  // Limit BFS search to first 100 nodes to avoid O(V*E) on huge SCCs
  const searchNodes = scc.length > 100 ? scc.slice(0, 100) : scc;

  for (const start of searchNodes) {
    const deps = graph.dependencies.get(start);
    if (!deps) continue;

    for (const next of deps) {
      if (!sccSet.has(next)) continue;

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

function bfsPath(
  graph: GraphData,
  from: string,
  to: string,
  within: Set<string>,
): string[] | null {
  if (from === to) return [to];

  const queue: { node: string; path: string[] }[] = [
    { node: from, path: [from] },
  ];
  const visited = new Set<string>([from]);

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    const deps = graph.dependencies.get(node);
    if (!deps) continue;

    for (const next of deps) {
      if (!within.has(next)) continue;
      if (next === to) return [...path, to];
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push({ node: next, path: [...path, next] });
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

async function collectFiles(dir: string, depth: number = 0): Promise<string[]> {
  if (depth > MAX_DIR_DEPTH) return [];

  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORE_DIRS.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await collectFiles(fullPath, depth + 1);
      files.push(...subFiles);
    } else if (entry.isFile() && isSupportedFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}
