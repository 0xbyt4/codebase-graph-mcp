import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, basename, extname, join, isAbsolute } from "node:path";
import JSON5 from "json5";
const TS_JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const PYTHON_EXTENSIONS = [".py"];
const RUST_EXTENSIONS = [".rs"];
const CONFIG_EXTENSIONS = [".json5", ".json"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs"];
// Files above this size are almost always generated or vendored bundles;
// parsing them with regexes is slow and produces nothing useful.
export const MAX_PARSE_BYTES = 1024 * 1024;
// A single line longer than this is a minified bundle, not source.
const MAX_LINE_LENGTH = 5000;
// TS/JS import patterns. All are global so a line with several statements
// yields every specifier, and none of them can cross a quote or semicolon,
// which keeps backtracking linear on long lines.
// `statement` patterns are only valid at the start of a statement (line
// start or after `;`), which keeps string literals from producing edges.
const TS_LINE_PATTERNS = [
    // import X from './p' | import { X } from './p' | import * as X from './p' | import type { X } from './p'
    { pattern: /\bimport\s+(type\s+)?[^'"`;]*?\bfrom\s+['"]([^'"\n]+)['"]/g, typeGroup: 1, specGroup: 2, statement: true },
    // export { X } from './p' | export * from './p' | export type { X } from './p'
    { pattern: /\bexport\s+(type\s+)?[^'"`;]*?\bfrom\s+['"]([^'"\n]+)['"]/g, typeGroup: 1, specGroup: 2, statement: true },
    // import './p' (side-effect only)
    { pattern: /\bimport\s+['"]([^'"\n]+)['"]/g, specGroup: 1, statement: true },
    // require('./p')
    { pattern: /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, specGroup: 1 },
    // import('./p')
    { pattern: /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, specGroup: 1 },
];
// Python: `from X import a, b as c` and `import a.b, c`
const PYTHON_FROM_PATTERN = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/;
const PYTHON_IMPORT_PATTERN = /^import\s+(.+)$/;
const PYTHON_TYPE_CHECKING_PATTERN = /^if\s+(?:typing\.)?TYPE_CHECKING\s*:/;
// Rust: `use a::b::{c, d};`, `pub(crate) use a::*;`, `mod name;`
const RUST_USE_PATTERN = /^(?:pub(?:\([^)]*\))?\s+)?use\s+(.+?)\s*;/;
const RUST_MOD_PATTERN = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/;
export function detectFileType(filePath) {
    const ext = extname(filePath).toLowerCase();
    if (TS_JS_EXTENSIONS.includes(ext))
        return "typescript";
    if (PYTHON_EXTENSIONS.includes(ext))
        return "python";
    if (RUST_EXTENSIONS.includes(ext))
        return "rust";
    if (CONFIG_EXTENSIONS.includes(ext))
        return "config";
    return "unknown";
}
export function parseImports(filePath, content, projectRoot) {
    const fileType = detectFileType(filePath);
    if (fileType === "unknown" || fileType === "config")
        return [];
    if (content.length > MAX_PARSE_BYTES)
        return [];
    switch (fileType) {
        case "typescript":
            return parseTypeScript(filePath, content, projectRoot);
        case "python":
            return parsePython(filePath, content, projectRoot);
        case "rust":
            return parseRust(filePath, content, projectRoot);
    }
}
// Collects imports so that a specifier imported both as a type and as a
// value is reported once, as a value import.
class ImportCollector {
    byKey = new Map();
    add(raw, resolved, typeOnly, declaration = false) {
        const existing = this.byKey.get(raw);
        if (existing) {
            if (existing.typeOnly && !typeOnly)
                existing.typeOnly = false;
            return;
        }
        const entry = { raw, resolved, typeOnly };
        if (declaration)
            entry.declaration = true;
        this.byKey.set(raw, entry);
    }
    list() {
        return [...this.byKey.values()];
    }
}
function startsStatement(line, index) {
    const before = line.slice(0, index).trim();
    return before === "" || before.endsWith(";") || before.endsWith("}");
}
function isCommentLine(trimmed) {
    return (!trimmed ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*"));
}
// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------
function parseTypeScript(filePath, content, projectRoot) {
    const out = new ImportCollector();
    const lines = collapseMultiLineImports(content).split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (isCommentLine(trimmed) || trimmed.length > MAX_LINE_LENGTH)
            continue;
        for (const { pattern, typeGroup, specGroup, statement } of TS_LINE_PATTERNS) {
            for (const match of trimmed.matchAll(pattern)) {
                if (statement && !startsStatement(trimmed, match.index ?? 0))
                    continue;
                const raw = match[specGroup];
                const typeOnly = typeGroup !== undefined && Boolean(match[typeGroup]);
                out.add(raw, resolveTypeScriptImport(raw, filePath, projectRoot), typeOnly);
            }
        }
    }
    return out.list();
}
// Joins multi-line `import { ... } from`, `import type { ... } from`,
// `import Default, { ... } from` and `export { ... } from` into one line.
function collapseMultiLineImports(content) {
    return content.replace(/^([ \t]*(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?)\{([^}]*)\}(\s*from\s*['"][^'"\n]+['"])/gm, (_match, prefix, names, suffix) => {
        const collapsed = names.replace(/\s+/g, " ").trim();
        return `${prefix}{ ${collapsed} }${suffix}`;
    });
}
function resolveTypeScriptImport(importPath, fromFile, projectRoot) {
    if (importPath.startsWith(".") || importPath.startsWith("/")) {
        return resolveTypeScriptFile(resolve(dirname(fromFile), importPath));
    }
    // Bare specifier: try tsconfig/jsconfig `paths` and `baseUrl` before giving
    // up as an external package.
    const aliases = findAliasConfig(dirname(fromFile), projectRoot);
    if (!aliases)
        return null;
    for (const candidate of aliasCandidates(importPath, aliases)) {
        const found = resolveTypeScriptFile(candidate);
        if (found)
            return found;
    }
    return null;
}
// Resolves a path with the same rules the TypeScript module resolver uses:
// exact file, `.js` -> `.ts` ESM rewrite, appended extensions, index files.
function resolveTypeScriptFile(base) {
    if (isFile(base))
        return base;
    const ext = extname(base);
    const rewrites = {
        ".js": [".ts", ".tsx"],
        ".jsx": [".tsx", ".ts"],
        ".mjs": [".mts"],
        ".cjs": [".cts"],
    };
    if (rewrites[ext]) {
        const stripped = base.slice(0, -ext.length);
        for (const tsExt of rewrites[ext]) {
            if (isFile(stripped + tsExt))
                return stripped + tsExt;
        }
    }
    for (const tryExt of TS_JS_EXTENSIONS) {
        if (isFile(base + tryExt))
            return base + tryExt;
    }
    for (const indexFile of INDEX_FILES) {
        const withIndex = join(base, indexFile);
        if (isFile(withIndex))
            return withIndex;
    }
    return null;
}
// Cache: directory -> alias config that applies to files in it (or null).
const aliasCache = new Map();
function findAliasConfig(dir, projectRoot) {
    if (aliasCache.has(dir))
        return aliasCache.get(dir);
    let result = null;
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const candidate = join(dir, name);
        if (isFile(candidate)) {
            result = loadAliasConfig(candidate, new Set());
            break;
        }
    }
    if (!result) {
        const parent = dirname(dir);
        const atRoot = projectRoot ? dir === projectRoot || !dir.startsWith(projectRoot) : false;
        if (parent !== dir && !atRoot)
            result = findAliasConfig(parent, projectRoot);
    }
    aliasCache.set(dir, result);
    return result;
}
function loadAliasConfig(configPath, seen) {
    if (seen.has(configPath))
        return null;
    seen.add(configPath);
    let parsed;
    try {
        parsed = JSON5.parse(readFileSync(configPath, "utf-8"));
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object")
        return null;
    const config = parsed;
    const configDir = dirname(configPath);
    // tsc merges `extends` entries per compiler option, later entries winning.
    const base = { baseDir: configDir, baseUrl: null, paths: {} };
    let inherited = false;
    const parents = Array.isArray(config.extends) ? config.extends : [config.extends];
    for (const parent of parents) {
        // Only relative `extends` are followed; package presets never carry project aliases.
        if (typeof parent !== "string" || (!parent.startsWith(".") && !isAbsolute(parent)))
            continue;
        let parentPath = resolve(configDir, parent);
        if (!isFile(parentPath) && isFile(parentPath + ".json"))
            parentPath += ".json";
        const loaded = loadAliasConfig(parentPath, seen);
        if (!loaded)
            continue;
        inherited = true;
        if (loaded.baseUrl !== null)
            base.baseUrl = loaded.baseUrl;
        if (Object.keys(loaded.paths).length > 0) {
            base.paths = loaded.paths;
            base.baseDir = loaded.baseDir;
        }
    }
    const options = (config.compilerOptions && typeof config.compilerOptions === "object" ? config.compilerOptions : {});
    const ownBaseUrl = typeof options.baseUrl === "string" ? resolve(configDir, options.baseUrl) : null;
    const ownPaths = options.paths && typeof options.paths === "object" ? sanitizePaths(options.paths) : null;
    const baseUrl = ownBaseUrl ?? base.baseUrl;
    const paths = ownPaths ?? base.paths;
    // `paths` are relative to baseUrl when set, else to the config that declares them
    const baseDir = ownPaths ? (baseUrl ?? configDir) : ownBaseUrl && !inherited ? ownBaseUrl : base.baseDir;
    if (!baseUrl && Object.keys(paths).length === 0)
        return null;
    return { baseDir, baseUrl, paths };
}
function sanitizePaths(raw) {
    const out = {};
    for (const [pattern, targets] of Object.entries(raw)) {
        if (Array.isArray(targets))
            out[pattern] = targets.filter((t) => typeof t === "string");
    }
    return out;
}
// Expands `paths` patterns for a specifier, most specific pattern first,
// then falls back to `baseUrl` lookup.
function aliasCandidates(importPath, config) {
    const candidates = [];
    const matches = [];
    for (const [pattern, targets] of Object.entries(config.paths)) {
        const starIndex = pattern.indexOf("*");
        if (starIndex < 0) {
            if (pattern === importPath)
                matches.push({ prefixLength: pattern.length + 1, targets, star: "" });
            continue;
        }
        const prefix = pattern.slice(0, starIndex);
        const suffix = pattern.slice(starIndex + 1);
        if (importPath.length >= prefix.length + suffix.length &&
            importPath.startsWith(prefix) &&
            importPath.endsWith(suffix)) {
            matches.push({
                prefixLength: prefix.length,
                targets,
                star: importPath.slice(prefix.length, importPath.length - suffix.length),
            });
        }
    }
    matches.sort((a, b) => b.prefixLength - a.prefixLength);
    for (const { targets, star } of matches) {
        for (const target of targets) {
            candidates.push(resolve(config.baseDir, target.replace("*", star)));
        }
    }
    if (config.baseUrl)
        candidates.push(resolve(config.baseUrl, importPath));
    return candidates;
}
// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------
function parsePython(filePath, content, projectRoot) {
    const out = new ImportCollector();
    const lines = collapsePythonParenImports(content).split("\n");
    let inTripleQuote = false;
    let tripleQuoteChar = "";
    // Indentation of an enclosing `if TYPE_CHECKING:`; -1 when outside one.
    let typeCheckingIndent = -1;
    for (const line of lines) {
        const trimmed = line.trim();
        for (const tq of ['"""', "'''"]) {
            const count = trimmed.split(tq).length - 1;
            if (count > 0) {
                if (!inTripleQuote) {
                    inTripleQuote = true;
                    tripleQuoteChar = tq;
                    if (count % 2 === 0)
                        inTripleQuote = false;
                }
                else if (tq === tripleQuoteChar) {
                    inTripleQuote = false;
                }
            }
        }
        if (inTripleQuote || !trimmed || trimmed.startsWith("#"))
            continue;
        const indent = line.length - line.trimStart().length;
        if (typeCheckingIndent >= 0 && indent <= typeCheckingIndent)
            typeCheckingIndent = -1;
        let statement = trimmed;
        let typeOnly = typeCheckingIndent >= 0;
        const guard = PYTHON_TYPE_CHECKING_PATTERN.exec(trimmed);
        if (guard) {
            // `if TYPE_CHECKING: import x` on one line, or the start of a block
            statement = trimmed.slice(guard[0].length).trim();
            typeOnly = true;
            if (!statement) {
                typeCheckingIndent = indent;
                continue;
            }
        }
        const fromMatch = PYTHON_FROM_PATTERN.exec(statement);
        if (fromMatch) {
            const modulePath = fromMatch[1];
            const names = fromMatch[2] === "*" ? [] : parsePythonNames(fromMatch[2]);
            for (const target of resolvePythonFromImport(modulePath, names, filePath, projectRoot)) {
                out.add(target.raw, target.resolved, typeOnly);
            }
            continue;
        }
        const importMatch = PYTHON_IMPORT_PATTERN.exec(statement);
        if (importMatch) {
            for (const name of parsePythonNames(importMatch[1])) {
                out.add(name, resolvePythonModule(name, filePath, projectRoot), typeOnly);
            }
        }
    }
    return out.list();
}
// Joins `from x import (\n a,  # noqa\n b,\n)` into one line, dropping comments.
function collapsePythonParenImports(content) {
    return content.replace(/^([ \t]*from\s+\S+\s+import\s*)\(([^)]*)\)/gm, (_match, prefix, names) => `${prefix}${names.replace(/#[^\n]*/g, "").replace(/\s+/g, " ").trim()}`);
}
// "a, b as c, d" -> ["a", "b", "d"]; strips a trailing comment.
function parsePythonNames(list) {
    return list
        .split("#")[0]
        .split(",")
        .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
        .filter((n) => /^[\w.]+$/.test(n));
}
// `from M import a, b`: an edge to each name that is a submodule of M,
// otherwise one edge to M itself.
function resolvePythonFromImport(modulePath, names, fromFile, projectRoot) {
    const moduleFile = modulePath ? resolvePythonModule(modulePath, fromFile, projectRoot) : null;
    const packageDir = pythonPackageDir(modulePath, moduleFile, fromFile, projectRoot);
    const results = [];
    let attributeNames = names.length === 0; // `import *` or nothing parsed
    if (packageDir) {
        const prefix = modulePath.endsWith(".") ? modulePath : `${modulePath}.`;
        for (const name of names) {
            const sub = resolvePythonModulePath(name, packageDir);
            if (sub)
                results.push({ raw: `${prefix}${name}`, resolved: sub });
            else
                attributeNames = true; // defined in the package's __init__.py
        }
    }
    else {
        attributeNames = true;
    }
    if (attributeNames || results.length === 0)
        results.push({ raw: modulePath || ".", resolved: moduleFile });
    return results;
}
// Directory whose submodules `from M import name` may refer to: M's package
// directory when M is a package (with or without __init__.py), or the
// directory `from . import` points at.
function pythonPackageDir(modulePath, moduleFile, fromFile, projectRoot) {
    if (moduleFile) {
        return basename(moduleFile) === "__init__.py" ? dirname(moduleFile) : null;
    }
    const dotMatch = modulePath.match(/^(\.+)(.*)$/);
    if (dotMatch) {
        const baseDir = pythonRelativeBase(dotMatch[1].length, fromFile);
        if (!dotMatch[2])
            return baseDir;
        const dir = join(baseDir, ...dotMatch[2].split("."));
        return isDirectory(dir) ? dir : null;
    }
    for (const rootDir of pythonSearchRoots(fromFile, projectRoot)) {
        const dir = join(rootDir, ...modulePath.split("."));
        if (isDirectory(dir))
            return dir;
    }
    return null;
}
// Conventional source roots first, then every ancestor of the importing
// file up to the project root (monorepos, nested packages).
function pythonSearchRoots(fromFile, projectRoot) {
    if (!projectRoot)
        return [];
    const roots = [];
    for (const sourceRoot of ["src", "lib", "app", "."]) {
        roots.push(sourceRoot === "." ? projectRoot : join(projectRoot, sourceRoot));
    }
    let dir = dirname(fromFile);
    while (dir.startsWith(projectRoot) && dir !== projectRoot) {
        roots.push(dir);
        dir = dirname(dir);
    }
    return roots;
}
function pythonRelativeBase(dots, fromFile) {
    let baseDir = dirname(fromFile);
    for (let i = 1; i < dots; i++)
        baseDir = dirname(baseDir);
    return baseDir;
}
function resolvePythonModule(modulePath, fromFile, projectRoot) {
    const dotMatch = modulePath.match(/^(\.+)(.*)$/);
    if (dotMatch) {
        const baseDir = pythonRelativeBase(dotMatch[1].length, fromFile);
        if (!dotMatch[2]) {
            const initFile = join(baseDir, "__init__.py");
            return isFile(initFile) ? initFile : null;
        }
        return resolvePythonModulePath(dotMatch[2], baseDir);
    }
    for (const rootDir of pythonSearchRoots(fromFile, projectRoot)) {
        const result = resolvePythonModulePath(modulePath, rootDir);
        if (result)
            return result;
    }
    return null;
}
function resolvePythonModulePath(modulePath, baseDir) {
    const resolved = join(baseDir, ...modulePath.split("."));
    const asFile = resolved + ".py";
    if (isFile(asFile))
        return asFile;
    const asPackage = join(resolved, "__init__.py");
    if (isFile(asPackage))
        return asPackage;
    return null;
}
// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------
const RUST_INLINE_MOD_PATTERN = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/;
function parseRust(filePath, content, projectRoot) {
    const out = new ImportCollector();
    const lines = collapseRustMultiLineUse(content).split("\n");
    // Inline `mod tests { use super::*; }` blocks: `super` there is this file,
    // not the parent module. Track brace depth to know how many such blocks
    // enclose a `use`.
    let depth = 0;
    const inlineModDepths = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (isCommentLine(trimmed) || trimmed.length > MAX_LINE_LENGTH)
            continue;
        if (RUST_INLINE_MOD_PATTERN.test(trimmed))
            inlineModDepths.push(depth + 1);
        if (!inlineModDepths.length) {
            const modMatch = RUST_MOD_PATTERN.exec(trimmed);
            if (modMatch) {
                out.add(modMatch[1], resolveRustModDeclaration(modMatch[1], filePath), false, true);
                continue;
            }
        }
        const useMatch = RUST_USE_PATTERN.exec(trimmed);
        if (useMatch) {
            for (const usePath of expandRustUseTree(useMatch[1])) {
                const resolved = resolveRustUsePath(usePath, filePath, projectRoot, inlineModDepths.length);
                out.add(usePath, resolved === filePath ? null : resolved, false);
            }
        }
        depth += countBraces(trimmed);
        while (inlineModDepths.length && depth < inlineModDepths[inlineModDepths.length - 1])
            inlineModDepths.pop();
    }
    return out.list();
}
// Net brace count of a line, ignoring string literals and trailing comments.
function countBraces(line) {
    const code = line.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/\/\/.*$/, "");
    let n = 0;
    for (const ch of code) {
        if (ch === "{")
            n++;
        else if (ch === "}")
            n--;
    }
    return n;
}
function collapseRustMultiLineUse(content) {
    return content.replace(/(?:pub(?:\([^)]*\))?\s+)?use\s+[^;{]*\{[^;]*?\}\s*;/g, (match) => match.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " "));
}
// `a::b::{c, d::e, self}` -> ["a::b::c", "a::b::d::e", "a::b"]; `a::*` -> ["a"].
function expandRustUseTree(tree) {
    const cleaned = tree.replace(/\s+as\s+\w+/g, "").replace(/\s+/g, "");
    const braceIndex = cleaned.indexOf("{");
    if (braceIndex < 0) {
        return [cleaned.endsWith("::*") ? cleaned.slice(0, -3) : cleaned];
    }
    const prefix = cleaned.slice(0, braceIndex).replace(/::$/, "");
    const inner = cleaned.slice(braceIndex + 1, cleaned.lastIndexOf("}"));
    const results = [];
    for (const item of splitTopLevel(inner)) {
        if (!item)
            continue;
        if (item === "self")
            results.push(prefix);
        else
            results.push(...expandRustUseTree(item).map((p) => (prefix ? `${prefix}::${p}` : p)));
    }
    return results;
}
function splitTopLevel(list) {
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of list) {
        if (ch === "{")
            depth++;
        if (ch === "}")
            depth--;
        if (ch === "," && depth === 0) {
            parts.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return parts;
}
function resolveRustUsePath(usePath, fromFile, projectRoot, inlineModLevels = 0) {
    const parts = usePath.split("::");
    let dir;
    if (parts[0] === "crate") {
        const crateSrc = findCrateSrcDir(fromFile, projectRoot);
        if (!crateSrc)
            return null;
        dir = crateSrc;
        parts.shift();
    }
    else if (parts[0] === "self") {
        // Inside an inline mod, `self` is that inline module: nothing to resolve.
        if (inlineModLevels > 0)
            return null;
        dir = getRustModuleDir(fromFile);
        parts.shift();
    }
    else if (parts[0] === "super") {
        // Each enclosing inline mod absorbs one `super`; if they are all
        // absorbed the path refers to this very file.
        let remainingInline = inlineModLevels;
        while (parts[0] === "super" && remainingInline > 0) {
            parts.shift();
            remainingInline--;
        }
        if (parts[0] !== "super")
            return fromFile;
        dir = getRustModuleDir(fromFile);
        while (parts[0] === "super") {
            dir = dirname(dir);
            parts.shift();
        }
    }
    else {
        // Bare path: a sibling module declared in this file, else an external crate.
        if (inlineModLevels > 0 || parts.length === 1)
            return null;
        dir = getRustModuleDir(fromFile);
        const sibling = resolveRustModulePath(parts, dir);
        return sibling;
    }
    // Items that live directly in the module file (`use super::Item`) resolve
    // to that file rather than to nothing.
    return resolveRustModulePath(parts, dir) ?? rustModuleFileForDir(dir);
}
// The file that owns a module directory: `dir/mod.rs`, the sibling
// `<dir>.rs`, or the crate root for `src/`.
function rustModuleFileForDir(dir) {
    const asMod = join(dir, "mod.rs");
    if (isFile(asMod))
        return asMod;
    const sibling = join(dirname(dir), basename(dir) + ".rs");
    if (isFile(sibling))
        return sibling;
    for (const root of ["lib.rs", "main.rs"]) {
        const candidate = join(dir, root);
        if (isFile(candidate))
            return candidate;
    }
    return null;
}
// Nearest Cargo.toml above the file decides which crate `crate::` means.
function findCrateSrcDir(fromFile, projectRoot) {
    let dir = dirname(fromFile);
    while (true) {
        if (isFile(join(dir, "Cargo.toml")) && existsSync(join(dir, "src")))
            return join(dir, "src");
        const parent = dirname(dir);
        if (parent === dir || (projectRoot && !parent.startsWith(projectRoot)))
            break;
        dir = parent;
    }
    return projectRoot && existsSync(join(projectRoot, "src")) ? join(projectRoot, "src") : null;
}
function getRustModuleDir(filePath) {
    const dir = dirname(filePath);
    const base = basename(filePath, ".rs");
    if (base === "mod" || base === "lib" || base === "main")
        return dir;
    return join(dir, base);
}
function resolveRustModDeclaration(name, fromFile) {
    const moduleDir = getRustModuleDir(fromFile);
    const asFile = join(moduleDir, name + ".rs");
    if (isFile(asFile))
        return asFile;
    const asMod = join(moduleDir, name, "mod.rs");
    if (isFile(asMod))
        return asMod;
    return null;
}
// Longest prefix of `parts` that is a module file; trailing segments are items.
function resolveRustModulePath(parts, baseDir) {
    for (let i = parts.length; i > 0; i--) {
        const resolved = join(baseDir, ...parts.slice(0, i));
        const asFile = resolved + ".rs";
        if (isFile(asFile))
            return asFile;
        const asMod = join(resolved, "mod.rs");
        if (isFile(asMod))
            return asMod;
    }
    return null;
}
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function isFile(p) {
    try {
        return existsSync(p) && statSync(p).isFile();
    }
    catch {
        return false;
    }
}
function isDirectory(p) {
    try {
        return existsSync(p) && statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
export function readFileContent(filePath) {
    try {
        return readFileSync(filePath, "utf-8");
    }
    catch {
        return null;
    }
}
export function isSupportedFile(filePath) {
    const ft = detectFileType(filePath);
    return ft !== "unknown" && ft !== "config";
}
export function isConfigFile(filePath) {
    return detectFileType(filePath) === "config";
}
// Test hook: alias lookups are cached per directory for the process lifetime.
export function clearParserCaches() {
    aliasCache.clear();
}
