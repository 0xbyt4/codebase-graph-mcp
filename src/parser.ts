import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, basename, extname, join } from "node:path";

const TS_JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const PYTHON_EXTENSIONS = [".py"];
const RUST_EXTENSIONS = [".rs"];
const CONFIG_EXTENSIONS = [".json5", ".json"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

// TS/JS import patterns (applied per-line to avoid cross-line false positives)
const TS_LINE_PATTERNS = [
  // import X from './path'  |  import { X } from './path'  |  import * as X from './path'
  /import\s+.+\s+from\s+['"](.+?)['"]/,
  // import './path' (side-effect)
  /import\s+['"](.+?)['"]/,
  // export { X } from './path'  |  export * from './path'
  /export\s+.+\s+from\s+['"](.+?)['"]/,
  // require('./path')
  /require\s*\(\s*['"](.+?)['"]\s*\)/,
  // import('./path') dynamic
  /import\s*\(\s*['"](.+?)['"]\s*\)/,
];

// Python import patterns (applied per-line)
const PYTHON_LINE_PATTERNS = [
  // from module import X  |  from .module import X  |  from ..module import X
  /^from\s+(\.{0,3}\S+)\s+import/,
  // import module  |  import module.sub
  /^import\s+([\w.]+)/,
];

// Rust import patterns (applied per-line)
const RUST_LINE_PATTERNS = [
  // use path::module;  |  use path::{items};  |  use path::*;  |  pub use ...
  /^(?:pub\s+)?use\s+([^;{]+?)(?:::\{[^}]*\}|::\*)?\s*;/,
  // mod name;  |  pub mod name;  (file module declaration, not inline mod {} blocks)
  /^(?:pub\s+)?mod\s+(\w+)\s*;/,
];

export interface ParsedImport {
  raw: string;
  resolved: string | null;
}

export type FileType = "typescript" | "python" | "rust" | "config" | "unknown";

export function detectFileType(filePath: string): FileType {
  const ext = extname(filePath).toLowerCase();
  if (TS_JS_EXTENSIONS.includes(ext)) return "typescript";
  if (PYTHON_EXTENSIONS.includes(ext)) return "python";
  if (RUST_EXTENSIONS.includes(ext)) return "rust";
  if (CONFIG_EXTENSIONS.includes(ext)) return "config";
  return "unknown";
}

export function parseImports(
  filePath: string,
  content: string,
  projectRoot?: string,
): ParsedImport[] {
  const fileType = detectFileType(filePath);
  if (fileType === "unknown" || fileType === "config") return [];

  const patterns =
    fileType === "typescript" ? TS_LINE_PATTERNS :
    fileType === "rust" ? RUST_LINE_PATTERNS :
    PYTHON_LINE_PATTERNS;
  const imports: ParsedImport[] = [];
  const seen = new Set<string>();

  // Normalize multi-line imports into single lines before parsing
  const normalized =
    fileType === "rust" ? collapseRustMultiLineUse(content) :
    collapseMultiLineImports(content);
  const lines = normalized.split("\n");

  let inTripleQuote = false;
  let tripleQuoteChar = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Track Python triple-quoted strings to skip false positive imports
    if (fileType === "python") {
      for (const tq of ['"""', "'''"]) {
        const count = (trimmed.split(tq).length - 1);
        if (count > 0) {
          if (!inTripleQuote) {
            inTripleQuote = true;
            tripleQuoteChar = tq;
            // If opens and closes on the same line (even count), stay outside
            if (count % 2 === 0) inTripleQuote = false;
          } else if (tq === tripleQuoteChar) {
            inTripleQuote = false;
          }
        }
      }
      if (inTripleQuote) continue;
    }

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("#")) {
      continue;
    }

    for (const pattern of patterns) {
      const match = pattern.exec(trimmed);
      if (!match) continue;

      const raw = match[1];
      if (seen.has(raw)) continue;
      seen.add(raw);

      const resolved =
        fileType === "typescript"
          ? resolveTypeScriptImport(raw, filePath)
          : fileType === "rust"
            ? resolveRustImport(raw, filePath, projectRoot)
            : resolvePythonImport(raw, filePath, projectRoot);

      imports.push({ raw, resolved });
    }
  }

  return imports;
}

function collapseMultiLineImports(content: string): string {
  // Collapse multi-line import/export statements into single lines
  // e.g. import {\n  foo,\n  bar\n} from './path' => import { foo, bar } from './path'
  return content.replace(
    /^((?:import|export)\s+)\{([^}]*)\}(\s+from\s+['"].*?['"])/gm,
    (_match, prefix: string, names: string, suffix: string) => {
      const collapsed = names.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
      return `${prefix}{ ${collapsed} }${suffix}`;
    },
  );
}

function collapseRustMultiLineUse(content: string): string {
  // Collapse multi-line use statements: use path::{  foo,  bar  };
  return content.replace(
    /(?:pub\s+)?use\s+[^;{]*\{[^}]*\}\s*;/g,
    (match) => match.replace(/\n/g, " ").replace(/\s+/g, " "),
  );
}

function resolveTypeScriptImport(
  importPath: string,
  fromFile: string,
): string | null {
  // Skip node_modules / bare specifiers
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
    return null;
  }

  const dir = dirname(fromFile);
  const base = resolve(dir, importPath);

  // Try exact path
  if (isFile(base)) return base;

  // Handle TypeScript ESM convention: imports use .js but actual files are .ts
  // e.g. import "./parser.js" -> actual file is ./parser.ts
  const ext = extname(base);
  if (ext === ".js" || ext === ".jsx") {
    const stripped = base.slice(0, -ext.length);
    const tsEquivalents =
      ext === ".js" ? [".ts", ".tsx"] : [".tsx", ".ts"];
    for (const tsExt of tsEquivalents) {
      if (isFile(stripped + tsExt)) return stripped + tsExt;
    }
  }
  if (ext === ".mjs") {
    const stripped = base.slice(0, -4);
    if (isFile(stripped + ".mts")) return stripped + ".mts";
  }
  if (ext === ".cjs") {
    const stripped = base.slice(0, -4);
    if (isFile(stripped + ".cts")) return stripped + ".cts";
  }

  // Try with extensions
  for (const tryExt of TS_JS_EXTENSIONS) {
    const withExt = base + tryExt;
    if (isFile(withExt)) return withExt;
  }

  // Try as directory with index file
  for (const indexFile of INDEX_FILES) {
    const withIndex = join(base, indexFile);
    if (isFile(withIndex)) return withIndex;
  }

  return null;
}

// Common Python source root directories
const PYTHON_SOURCE_ROOTS = ["src", "lib", "app", "."];

function resolvePythonImport(
  importPath: string,
  fromFile: string,
  projectRoot?: string,
): string | null {
  if (importPath.startsWith(".")) {
    return resolveRelativePythonImport(importPath, fromFile);
  }

  // Absolute import: try to resolve against project source roots
  if (projectRoot) {
    return resolveAbsolutePythonImport(importPath, projectRoot);
  }

  return null;
}

function resolveRelativePythonImport(
  importPath: string,
  fromFile: string,
): string | null {
  const dir = dirname(fromFile);

  // Count leading dots for relative imports
  const dotMatch = importPath.match(/^(\.+)/);
  if (!dotMatch) return null;

  const dots = dotMatch[1].length;
  const modulePart = importPath.slice(dots);

  // Go up directories based on dot count
  let baseDir = dir;
  for (let i = 1; i < dots; i++) {
    baseDir = dirname(baseDir);
  }

  if (!modulePart) {
    // from . import X -> look for __init__.py
    const initFile = join(baseDir, "__init__.py");
    if (isFile(initFile)) return initFile;
    return null;
  }

  return resolvePythonModulePath(modulePart, baseDir);
}

function resolveAbsolutePythonImport(
  importPath: string,
  projectRoot: string,
): string | null {
  for (const sourceRoot of PYTHON_SOURCE_ROOTS) {
    const rootDir = sourceRoot === "." ? projectRoot : join(projectRoot, sourceRoot);
    const result = resolvePythonModulePath(importPath, rootDir);
    if (result) return result;
  }
  return null;
}

function resolvePythonModulePath(
  modulePath: string,
  baseDir: string,
): string | null {
  // Convert module.path to file path
  const parts = modulePath.split(".");
  const resolved = join(baseDir, ...parts);

  // Try as file
  const asFile = resolved + ".py";
  if (isFile(asFile)) return asFile;

  // Try as package
  const asPackage = join(resolved, "__init__.py");
  if (isFile(asPackage)) return asPackage;

  return null;
}

function resolveRustImport(
  importPath: string,
  fromFile: string,
  projectRoot?: string,
): string | null {
  // mod declaration (no :: separator) - e.g., from `mod foo;`
  if (!importPath.includes("::")) {
    return resolveRustModDeclaration(importPath, fromFile);
  }

  // crate:: - resolve from project's src/ directory
  if (importPath.startsWith("crate::")) {
    if (!projectRoot) return null;
    const modulePath = importPath.slice("crate::".length);
    return resolveRustModulePath(modulePath, join(projectRoot, "src"));
  }

  // super:: - resolve from parent module(s)
  if (importPath.startsWith("super::")) {
    let remaining = importPath;
    let dir = getRustModuleDir(fromFile);
    while (remaining.startsWith("super::")) {
      remaining = remaining.slice("super::".length);
      dir = dirname(dir);
    }
    return remaining ? resolveRustModulePath(remaining, dir) : null;
  }

  // self:: - resolve from current module directory
  if (importPath.startsWith("self::")) {
    const modulePath = importPath.slice("self::".length);
    return resolveRustModulePath(modulePath, getRustModuleDir(fromFile));
  }

  // External crate (std::, serde::, etc.) - not in project
  return null;
}

function getRustModuleDir(filePath: string): string {
  const dir = dirname(filePath);
  const base = basename(filePath, ".rs");

  // mod.rs, lib.rs, main.rs -> module dir is the containing directory
  if (base === "mod" || base === "lib" || base === "main") {
    return dir;
  }

  // foo.rs -> submodules live in foo/ (sibling directory)
  return join(dir, base);
}

function resolveRustModDeclaration(
  name: string,
  fromFile: string,
): string | null {
  const moduleDir = getRustModuleDir(fromFile);

  // Try name.rs
  const asFile = join(moduleDir, name + ".rs");
  if (isFile(asFile)) return asFile;

  // Try name/mod.rs
  const asMod = join(moduleDir, name, "mod.rs");
  if (isFile(asMod)) return asMod;

  return null;
}

function resolveRustModulePath(
  modulePath: string,
  baseDir: string,
): string | null {
  const parts = modulePath.split("::");

  // Try progressively removing trailing segments (they might be items, not modules)
  for (let i = parts.length; i > 0; i--) {
    const pathParts = parts.slice(0, i);
    const resolved = join(baseDir, ...pathParts);

    // Try as file: foo/bar.rs
    const asFile = resolved + ".rs";
    if (isFile(asFile)) return asFile;

    // Try as directory module: foo/bar/mod.rs
    const asMod = join(resolved, "mod.rs");
    if (isFile(asMod)) return asMod;
  }

  return null;
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

export function readFileContent(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function isSupportedFile(filePath: string): boolean {
  const ft = detectFileType(filePath);
  return ft !== "unknown" && ft !== "config";
}

export function isConfigFile(filePath: string): boolean {
  return detectFileType(filePath) === "config";
}
