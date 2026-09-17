import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph, detectCycles, isTypeOnlyEdge, collectFiles, getProjectOverview } from "../build/graph.js";
import { FIXTURES, tempDir } from "./helpers.mjs";

const rel = (root, files) => files.map((f) => f.slice(root.length + 1)).sort();

test("TypeScript fixture: one runtime cycle, type-only edge does not count", async () => {
  const root = FIXTURES.ts;
  const graph = await buildGraph(root);
  const src = (p) => join(root, "src", p);

  assert.equal(isTypeOnlyEdge(graph, src("b.ts"), src("a.ts")), true);
  assert.equal(isTypeOnlyEdge(graph, src("a.ts"), src("b.ts")), false);

  const { cycles, totalCycles } = detectCycles(graph);
  assert.equal(totalCycles, 1);
  assert.deepEqual(rel(root, cycles[0]).sort(), ["src/c.ts", "src/d.ts"]);
  // each file appears exactly once in a reported cycle
  assert.equal(cycles[0].length, 2);
});

test("Python fixture: submodule edges, TYPE_CHECKING excluded from cycles, package __init__ not inflated", async () => {
  const root = FIXTURES.py;
  const graph = await buildGraph(root);
  const pkg = (p) => join(root, "pkg", p);

  assert.deepEqual(rel(root, [...graph.dependencies.get(pkg("sub.py"))]), [
    "pkg/classes.py",
    "pkg/core.py",
    "pkg/other.py",
    "pkg/version.py",
  ]);
  assert.equal(isTypeOnlyEdge(graph, pkg("sub.py"), pkg("core.py")), true);
  // only core.py (via CONST) depends on the package __init__; submodule imports do not inflate it
  assert.deepEqual(rel(root, [...graph.dependents.get(pkg("__init__.py"))]), ["pkg/core.py"]);

  const { cycles, totalCycles } = detectCycles(graph);
  assert.equal(totalCycles, 1);
  assert.deepEqual(rel(root, cycles[0]), ["pkg/other.py", "pkg/sub.py"]);
});

test("Python fixture: class methods are found with tab and 2-space indentation, nested functions are not", async () => {
  const graph = await buildGraph(FIXTURES.py);
  const classes = graph.classHierarchy.fileClasses.get(join(FIXTURES.py, "pkg/classes.py"));
  const byName = Object.fromEntries(classes.map((c) => [c.name, c]));
  assert.deepEqual(byName.Base.methods, ["run", "stop"]);
  assert.deepEqual(byName.Child.methods, ["run"]);
  assert.deepEqual(byName.Child.bases, ["Base"]);
});

test("Rust fixture: mod declarations are edges but never cycles", async () => {
  const root = FIXTURES.rs;
  const graph = await buildGraph(root);
  const src = (p) => join(root, "src", p);

  assert.deepEqual(rel(root, [...graph.dependencies.get(src("lib.rs"))]), ["src/a.rs", "src/b.rs"]);
  assert.ok(graph.dependencies.get(src("a.rs")).has(src("lib.rs")), "child refers back to its parent");

  const { cycles, totalCycles } = detectCycles(graph);
  assert.equal(totalCycles, 1, "only a <-> b, not lib <-> a");
  assert.deepEqual(rel(root, cycles[0]), ["src/a.rs", "src/b.rs"]);
});

test("collectFiles: an unreadable directory is skipped, not fatal", async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root ignores permissions");
  const root = tempDir("cg-eacces-");
  writeFileSync(join(root, "ok.py"), "x = 1\n");
  mkdirSync(join(root, "locked"));
  writeFileSync(join(root, "locked", "hidden.py"), "y = 1\n");
  chmodSync(join(root, "locked"), 0o000);
  try {
    const { files } = await collectFiles(root);
    assert.deepEqual(rel(root, files), ["ok.py"]);
  } finally {
    chmodSync(join(root, "locked"), 0o755);
  }
});

test("collectFiles: .gitignore is honoured inside a repository", async () => {
  const root = tempDir("cg-ignore-");
  const { git } = await import("./helpers.mjs");
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), "generated/\n");
  writeFileSync(join(root, "keep.ts"), "export const a = 1;\n");
  mkdirSync(join(root, "generated"));
  writeFileSync(join(root, "generated", "skip.ts"), "export const b = 1;\n");
  mkdirSync(join(root, "env"));
  writeFileSync(join(root, "env", "site.py"), "z = 1\n");

  const { files } = await collectFiles(root);
  assert.deepEqual(rel(root, files), ["keep.ts"]);
});

test("collectFiles: nested repositories, submodules and tracked env/out directories are included", async () => {
  const { git } = await import("./helpers.mjs");
  const base = tempDir("cg-nested-");
  const root = join(base, "main");
  const lib = join(base, "lib");
  mkdirSync(root);
  mkdirSync(lib);

  git(lib, "init", "-q");
  writeFileSync(join(lib, "s.ts"), "export const s = 1;\n");
  git(lib, "add", ".");
  git(lib, "commit", "-q", "-m", "lib");

  git(root, "init", "-q");
  mkdirSync(join(root, "src", "config", "env"), { recursive: true });
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "src", "config", "env", "prod.ts"), "export const p = 1;\n");
  writeFileSync(join(root, "out", "gen.ts"), "export const g = 1;\n");
  git(root, "add", ".");
  git(root, "-c", "protocol.file.allow=always", "submodule", "-q", "add", lib, "submod");
  git(root, "commit", "-q", "-m", "main");

  mkdirSync(join(root, "nested"));
  git(join(root, "nested"), "init", "-q");
  writeFileSync(join(root, "nested", "inner.ts"), "export const i = 1;\n");

  const { files } = await collectFiles(root);
  assert.deepEqual(rel(root, files), ["nested/inner.ts", "out/gen.ts", "src/config/env/prod.ts", "submod/s.ts"]);
});

test("detectCycles: a 20,000-file chain and ring do not overflow the stack", () => {
  const graph = {
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
  const n = 20_000;
  for (let i = 0; i < n; i++) {
    const file = `/chain/${i}.ts`;
    graph.files.add(file);
    graph.dependencies.set(file, new Set(i + 1 < n ? [`/chain/${i + 1}.ts`] : []));
  }
  assert.equal(detectCycles(graph).totalCycles, 0);

  // close the ring
  graph.dependencies.get(`/chain/${n - 1}.ts`).add("/chain/0.ts");
  const { totalCycles, cycles } = detectCycles(graph);
  assert.equal(totalCycles, 1);
  assert.equal(cycles[0].length, n);
});

test("project overview on the TypeScript fixture", async () => {
  const root = FIXTURES.ts;
  const overview = getProjectOverview(await buildGraph(root), root);
  assert.equal(overview.filesByType[".ts"], overview.totalFiles);
  assert.ok(overview.entryPoints.includes("src/app.ts"));
  assert.ok(overview.mostImported.some((m) => m.file === "src/lib/helper.ts" && m.count === 1));
});
