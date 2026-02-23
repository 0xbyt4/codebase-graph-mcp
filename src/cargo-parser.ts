import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";

export interface CargoDependency {
  sourceFile: string;
  targetFile: string;
  depName: string;
  depType: "normal" | "dev" | "build";
}

/**
 * Parse Cargo.toml workspace to extract cross-crate dependency edges.
 * Returns edges from each crate's entry point (lib.rs/main.rs) to its
 * workspace dependency crate's entry point.
 */
export function parseCargoDependencies(
  projectRoot: string,
): CargoDependency[] {
  const rootToml = join(projectRoot, "Cargo.toml");
  if (!isFile(rootToml)) return [];

  const rootContent = readFileSync(rootToml, "utf-8");

  // Step 1: Build package name -> absolute entry point path mapping
  const workspaceDeps = parseWorkspaceDeps(rootContent, projectRoot);
  if (workspaceDeps.size === 0) return [];

  // Step 2: Find all workspace member Cargo.toml files
  const memberDirs = parseWorkspaceMembers(rootContent, projectRoot);
  if (memberDirs.length === 0) return [];

  // Step 3: For each member, extract workspace deps and create edges
  const result: CargoDependency[] = [];

  for (const memberDir of memberDirs) {
    const tomlPath = join(memberDir, "Cargo.toml");
    if (!isFile(tomlPath)) continue;

    const sourceFile = getCrateEntryPoint(memberDir);
    if (!sourceFile) continue;

    const content = readFileSync(tomlPath, "utf-8");
    const deps = extractCrateWorkspaceDeps(content);

    for (const { name, depType } of deps) {
      const targetFile = workspaceDeps.get(name);
      if (!targetFile) continue;
      if (targetFile === sourceFile) continue;

      result.push({ sourceFile, targetFile, depName: name, depType });
    }
  }

  return result;
}

/**
 * Parse [workspace.dependencies] from root Cargo.toml.
 * Extracts entries with `path = "..."` and maps package name -> entry point file.
 */
function parseWorkspaceDeps(
  content: string,
  projectRoot: string,
): Map<string, string> {
  const deps = new Map<string, string>();
  const lines = content.split("\n");
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track current TOML section
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      inSection = sectionMatch[1].trim() === "workspace.dependencies";
      continue;
    }

    if (!inSection) continue;
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Match: tempo-node = { path = "crates/node" }
    // Also: tempo-node = { path = "crates/node", default-features = false }
    const pathMatch = trimmed.match(
      /^([\w-]+)\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"[^}]*\}/,
    );
    if (!pathMatch) continue;

    const [, name, cratePath] = pathMatch;
    const absDir = join(projectRoot, cratePath);
    const entryPoint = getCrateEntryPoint(absDir);
    if (entryPoint) {
      deps.set(name, entryPoint);
    }
  }

  return deps;
}

/**
 * Parse [workspace] members list from root Cargo.toml.
 * Returns absolute paths to member directories.
 */
function parseWorkspaceMembers(
  content: string,
  projectRoot: string,
): string[] {
  // Extract members array (handles multi-line)
  const membersMatch = content.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!membersMatch) return [];

  const members: string[] = [];
  const quotedStrings = membersMatch[1].matchAll(/"([^"]+)"/g);
  for (const match of quotedStrings) {
    members.push(join(projectRoot, match[1]));
  }

  return members;
}

/**
 * Extract workspace dependency references from a crate's Cargo.toml.
 * Matches both syntaxes:
 *   - `tempo-node.workspace = true`
 *   - `tempo-node = { workspace = true, features = [...] }`
 */
function extractCrateWorkspaceDeps(
  content: string,
): { name: string; depType: "normal" | "dev" | "build" }[] {
  const deps: { name: string; depType: "normal" | "dev" | "build" }[] = [];
  const lines = content.split("\n");
  let depType: "normal" | "dev" | "build" = "normal";

  for (const line of lines) {
    const trimmed = line.trim();

    // Track dependency section
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      const section = sectionMatch[1].trim();
      if (section === "dependencies") {
        depType = "normal";
      } else if (section === "dev-dependencies") {
        depType = "dev";
      } else if (section === "build-dependencies") {
        depType = "build";
      } else {
        depType = "normal";
      }
      continue;
    }

    if (!trimmed || trimmed.startsWith("#")) continue;

    // Match: package.workspace = true
    const dotMatch = trimmed.match(/^([\w-]+)\.workspace\s*=\s*true/);
    if (dotMatch) {
      deps.push({ name: dotMatch[1], depType });
      continue;
    }

    // Match: package = { workspace = true, ... }
    const inlineMatch = trimmed.match(
      /^([\w-]+)\s*=\s*\{[^}]*workspace\s*=\s*true[^}]*\}/,
    );
    if (inlineMatch) {
      deps.push({ name: inlineMatch[1], depType });
    }
  }

  return deps;
}

function getCrateEntryPoint(crateDir: string): string | null {
  const libRs = join(crateDir, "src", "lib.rs");
  if (isFile(libRs)) return libRs;

  const mainRs = join(crateDir, "src", "main.rs");
  if (isFile(mainRs)) return mainRs;

  return null;
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}
