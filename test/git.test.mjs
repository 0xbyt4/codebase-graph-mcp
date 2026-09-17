import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertValidGitRef, changedFilesSince, getCoChanges, getFileChurn } from "../build/git-history.js";
import { createRequire } from "node:module";
import { git, makeRepo, tempDir } from "./helpers.mjs";

const require = createRequire(import.meta.url);

test("assertValidGitRef rejects option-looking and unknown refs", () => {
  const root = makeRepo();
  const target = join(root, "pwned.txt");
  assert.throws(() => assertValidGitRef(`--output=${target}`, root), /Invalid git ref/);
  assert.throws(() => assertValidGitRef("HEAD HEAD~1", root), /Invalid git ref/);
  assert.throws(() => assertValidGitRef("no-such-branch", root), /does not name a commit/);
  assert.equal(existsSync(target), false);
  assert.doesNotThrow(() => assertValidGitRef("HEAD~1", root));
  assert.doesNotThrow(() => assertValidGitRef("main", root));
});

test("changedFilesSince never lets a ref reach git as an option", () => {
  const root = makeRepo();
  const target = join(root, "pwned.txt");
  assert.throws(() => changedFilesSince(`--output=${target}`, root));
  assert.equal(existsSync(target), false, "git must not have written the file");
  assert.deepEqual(changedFilesSince("HEAD", root), ["pkg/sub/b.py"]);
});

test("changedFilesSince returns non-ASCII names unquoted", () => {
  const root = makeRepo();
  const { writeFileSync } = require("node:fs");
  writeFileSync(join(root, "pkg", "caf\u00e9.py"), "z = 1\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "unicode");
  writeFileSync(join(root, "pkg", "caf\u00e9.py"), "z = 2\n");
  assert.ok(changedFilesSince("HEAD", root).includes("pkg/caf\u00e9.py"));
});

test("changedFilesSince is relative to a subdirectory root", () => {
  const root = makeRepo();
  assert.deepEqual(changedFilesSince("HEAD", join(root, "pkg")), ["sub/b.py"]);
  assert.deepEqual(changedFilesSince("HEAD", join(root, "pkg", "sub")), ["b.py"]);
});

test("getFileChurn counts commits per file with first and last dates", () => {
  const root = makeRepo();
  const churn = getFileChurn(root, 30);
  assert.equal(churn.totalCommits, 3);
  const byFile = Object.fromEntries(churn.files.map((f) => [f.file, f]));
  assert.equal(byFile["pkg/a.py"].commits, 2);
  assert.equal(byFile["pkg/sub/c.py"].commits, 2);
  assert.equal(byFile["README.md"].commits, 1);
  assert.match(byFile["pkg/a.py"].firstSeen, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(byFile["pkg/a.py"].lastChanged, /^\d{4}-\d{2}-\d{2}$/);
});

test("getFileChurn throws outside a repository instead of reporting nothing", () => {
  assert.throws(() => getFileChurn(tempDir("cg-norepo-"), 30));
});

test("getCoChanges works from a subdirectory root and normalizes the target path", () => {
  const root = makeRepo();

  const fromRoot = getCoChanges(root, "./pkg/a.py", 30);
  assert.equal(fromRoot.targetFile, "pkg/a.py");
  assert.equal(fromRoot.targetChanges, 2);
  assert.ok(!fromRoot.coChanges.some((c) => c.file === "pkg/a.py"), "target is not its own co-change");
  const b = fromRoot.coChanges.find((c) => c.file === "pkg/sub/b.py");
  assert.equal(b.coChangeCount, 2);
  assert.equal(b.correlation, 1);

  const fromSub = getCoChanges(join(root, "pkg"), "a.py", 30);
  assert.equal(fromSub.targetFile, "a.py");
  assert.equal(fromSub.targetChanges, 2);
  assert.ok(fromSub.coChanges.some((c) => c.file === "sub/b.py"));
  assert.ok(!fromSub.coChanges.some((c) => c.file === "README.md"), "files outside the root are not listed");
});
