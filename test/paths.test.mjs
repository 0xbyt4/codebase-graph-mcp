import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRoot, resolveInsideRoot } from "../build/paths.js";
import { tempDir } from "./helpers.mjs";

test("normalizeRoot strips trailing slashes and dot segments", () => {
  const root = tempDir("cg-root-");
  assert.equal(normalizeRoot(root + "/"), root);
  assert.equal(normalizeRoot(join(root, "sub", "..")), root);
});

test("resolveInsideRoot rejects escapes, prefix look-alikes and symlinks out of the root", () => {
  const base = tempDir("cg-inside-");
  const root = join(base, "proj");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(base, "proj-evil"));
  mkdirSync(join(base, "outside"));
  writeFileSync(join(root, "src", "a.ts"), "");
  symlinkSync(join(base, "outside"), join(root, "link"));

  assert.equal(resolveInsideRoot("src/a.ts", root), join(root, "src", "a.ts"));
  assert.equal(resolveInsideRoot("./src/../src/a.ts", root), join(root, "src", "a.ts"));
  assert.equal(resolveInsideRoot("new/graph.html", root), join(root, "new", "graph.html"), "missing output path stays inside");
  assert.equal(resolveInsideRoot("..weird.ts", root), join(root, "..weird.ts"), "a name starting with .. is not an escape");

  assert.throws(() => resolveInsideRoot("../proj-evil/x.html", root), /outside project root/);
  assert.throws(() => resolveInsideRoot(join(base, "proj-evil", "x.html"), root), /outside project root/);
  assert.throws(() => resolveInsideRoot("link/x.html", root), /outside project root/);
  assert.throws(() => resolveInsideRoot("/etc/passwd", root), /outside project root/);
  assert.throws(() => resolveInsideRoot(".", root), /outside project root/);
});
