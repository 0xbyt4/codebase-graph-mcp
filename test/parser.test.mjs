import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseImports, clearParserCaches } from "../build/parser.js";
import { FIXTURES } from "./helpers.mjs";

function parse(root, rel) {
  clearParserCaches();
  const file = join(root, rel);
  return parseImports(file, readFileSync(file, "utf-8"), root);
}

const byRaw = (imports) => Object.fromEntries(imports.map((i) => [i.raw, i]));

test("TypeScript: every import form in app.ts resolves to the right file", () => {
  const root = FIXTURES.ts;
  const imports = byRaw(parse(root, "src/app.ts"));
  const src = (p) => join(root, "src", p);

  // multi-line `import type {` is found and marked type-only
  assert.equal(imports["./types"].resolved, src("types.ts"));
  assert.equal(imports["./types"].typeOnly, true);
  // multi-line `import Default, {` is found and is a value import
  assert.equal(imports["./util"].resolved, src("util.ts"));
  assert.equal(imports["./util"].typeOnly, false);
  // tsconfig paths: wildcard and exact alias, through `extends`
  assert.equal(imports["@/lib/helper"].resolved, src("lib/helper.ts"));
  assert.equal(imports["#helper"].resolved, src("lib/helper.ts"));
  // two statements on one line: both found; .js maps to .ts
  assert.equal(imports["./a.js"].resolved, src("a.ts"));
  assert.equal(imports["./b.js"].resolved, src("b.ts"));
  // side-effect import, re-export, type re-export, require, dynamic import, index file
  assert.equal(imports["./side-effect"].resolved, src("side-effect.ts"));
  assert.equal(imports["./re"].resolved, src("re.ts"));
  assert.equal(imports["./type-re"].typeOnly, true);
  assert.equal(imports["./cjs"].resolved, src("cjs.ts"));
  assert.equal(imports["./dyn"].resolved, src("dyn/index.ts"));
  // bare package without alias: kept but unresolved
  assert.equal(imports["some-package"].resolved, null);
  // comment and string contents are not imports
  assert.equal(imports["./commented"], undefined);
  assert.equal(imports["./fake"], undefined);
});

test("TypeScript: files over the size limit are skipped instead of parsed", () => {
  const content = "import { x } from './x';\n" + "x".repeat(2 * 1024 * 1024);
  assert.deepEqual(parseImports(join(FIXTURES.ts, "src/big.ts"), content, FIXTURES.ts), []);
});

test("TypeScript: a minified single line does not stall the parser", () => {
  const line = "import ".repeat(2000) + "z".repeat(4000);
  const started = Date.now();
  parseImports(join(FIXTURES.ts, "src/min.js"), line, FIXTURES.ts);
  assert.ok(Date.now() - started < 500, "parse took too long");
});

test("Python: `from . import x` and `from pkg import mod` resolve to the submodule", () => {
  const root = FIXTURES.py;
  const pkg = (p) => join(root, "pkg", p);

  const init = byRaw(parse(root, "pkg/__init__.py"));
  assert.equal(init[".sub"].resolved, pkg("sub.py"));
  assert.equal(init[".other"].resolved, pkg("other.py"));

  const sub = byRaw(parse(root, "pkg/sub.py"));
  assert.equal(sub["pkg.other"].resolved, pkg("other.py"));
  assert.equal(sub["pkg.version"].resolved, pkg("version.py"));
  // `import pkg.classes, os`
  assert.equal(sub["pkg.classes"].resolved, pkg("classes.py"));
  assert.equal(sub["pkg.classes"].typeOnly, false);
  assert.equal(sub["os"].resolved, null);
  // TYPE_CHECKING block
  assert.equal(sub["pkg.core"].resolved, pkg("core.py"));
  assert.equal(sub["pkg.core"].typeOnly, true);
  // no self edge, no edge to the package __init__ for submodule imports
  assert.equal(Object.values(sub).some((i) => i.resolved === pkg("__init__.py")), false);
});

test("Python: parenthesized multi-line imports, docstrings and comments", () => {
  const root = FIXTURES.py;
  const core = byRaw(parse(root, "pkg/core.py"));
  assert.equal(core["pkg.other"].resolved, join(root, "pkg/other.py"));

  const other = byRaw(parse(root, "pkg/other.py"));
  assert.equal(other[".sub"].resolved, join(root, "pkg/sub.py"));
  assert.equal(other["pkg.fake"], undefined, "import inside a docstring must be ignored");
  // one-line `if TYPE_CHECKING: from x import y`
  assert.equal(other["pkg.core"].resolved, join(root, "pkg/core.py"));
  assert.equal(other["pkg.core"].typeOnly, true);
});

test("Python: `from pkg import submodule, NAME` keeps both the submodule and the package edge", () => {
  const root = FIXTURES.py;
  const core = byRaw(parse(root, "pkg/core.py"));
  // names after a `# noqa` comment inside the parentheses are not lost
  assert.equal(core["pkg.version"].resolved, join(root, "pkg/version.py"));
  // CONST lives in pkg/__init__.py, so the package itself is a dependency too
  assert.equal(core["pkg"].resolved, join(root, "pkg/__init__.py"));
});

test("Rust: super/crate items fall back to the parent module file, glob and group imports expand", () => {
  const root = FIXTURES.rs;
  const src = (p) => join(root, "src", p);

  const a = byRaw(parse(root, "src/a.rs"));
  assert.equal(a["super::Item"].resolved, src("lib.rs"));
  assert.equal(a["crate::b::Thing"].resolved, src("b.rs"));
  assert.equal(a["inner"].resolved, src("a/inner.rs"));
  assert.equal(a["inner"].declaration, true);
  // inside `mod tests { ... }`, `super` is this file and `self` the inline module
  assert.equal(a["super"].resolved, null);
  assert.equal(a["super::f"].resolved, null);
  assert.equal(a["self::helper"].resolved, null);

  const b = byRaw(parse(root, "src/b.rs"));
  assert.equal(b["super"].resolved, src("lib.rs"), "use super::* points at the parent module");
  // brace group with a `//` comment inside
  assert.equal(b["crate::a"].resolved, src("a.rs"));
  assert.equal(b["crate::Item"].resolved, src("lib.rs"));
  assert.equal(Object.keys(b).some((k) => k.includes("//")), false);

  const inner = byRaw(parse(root, "src/a/inner.rs"));
  assert.equal(inner["super::super::Item"].resolved, src("lib.rs"));
  assert.equal(inner["std::collections::HashMap"].resolved, null);

  const lib = byRaw(parse(root, "src/lib.rs"));
  assert.equal(lib["a"].resolved, src("a.rs"));
  assert.equal(lib["b"].resolved, src("b.rs"));
});
