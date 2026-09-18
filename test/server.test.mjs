import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, callTool, listTools, makeRepo, resultText, tempDir } from "./helpers.mjs";

test("server lists the 12 tools", async () => {
  const tools = await listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "class_hierarchy",
      "co_change",
      "detect_cycles",
      "file_churn",
      "get_dependencies",
      "get_dependents",
      "impact_analysis",
      "multi_file_impact",
      "package_dependencies",
      "project_overview",
      "refresh_graph",
      "visualize_graph",
    ],
  );
});

test("get_dependencies marks type-only imports; unknown files are an error", async () => {
  const ok = await callTool("get_dependencies", { file: "src/b.ts", project_root: FIXTURES.ts });
  assert.equal(ok.isError, undefined);
  assert.match(resultText(ok), /src\/a\.ts \(type-only\)/);

  const missing = await callTool("get_dependents", { file: "src/typo.ts", project_root: FIXTURES.ts });
  assert.equal(missing.isError, true);
  assert.match(resultText(missing), /not in the dependency graph/);

  const outside = await callTool("get_dependents", { file: "../../../package.json", project_root: FIXTURES.ts });
  assert.equal(outside.isError, true);
  assert.match(resultText(outside), /outside project root/);
});

test("detect_cycles prints each file once and closes the loop", async () => {
  const result = await callTool("detect_cycles", { project_root: FIXTURES.ts });
  const text = resultText(result);
  assert.match(text, /Found 1 circular dependency/);
  assert.match(text, /Cycle 1 \(2 files\):\n  src\/(c|d)\.ts -> src\/(c|d)\.ts -> src\/(c|d)\.ts\n/);
});

test("multi_file_impact refuses a diff_ref that looks like a git option", async () => {
  const root = makeRepo();
  const target = join(root, "pwned.txt");
  const result = await callTool("multi_file_impact", { diff_ref: `--output=${target}`, project_root: root });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /Invalid git ref/);
  assert.equal(existsSync(target), false);

  const typo = await callTool("multi_file_impact", { files: ["pkg/nope.py"], project_root: root });
  assert.equal(typo.isError, true);
  assert.match(resultText(typo), /not in the dependency graph/);

  const good = await callTool("multi_file_impact", { diff_ref: "HEAD", project_root: root });
  assert.equal(good.isError, undefined);
  assert.match(resultText(good), /Changed files \(1\):\n  - pkg\/sub\/b\.py/);
  assert.match(resultText(good), /Directly affected \(1\):\n  - pkg\/a\.py/);
});

test("impact tools summarize a hub file instead of listing every affected file", async () => {
  // core/hub.py <- 120 importers in three directories <- 80 jobs that all import svc/a/m_000.py
  const root = tempDir("cg-hub-");
  const write = (rel, text) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const id = (i) => String(i).padStart(3, "0");
  write("core/hub.py", "X = 1\n");
  for (const dir of ["svc/a", "svc/b", "web/x"]) {
    for (let i = 0; i < 40; i++) write(`${dir}/m_${id(i)}.py`, "from core.hub import X\n");
  }
  for (let i = 0; i < 80; i++) write(`jobs/j_${id(i)}.py`, "from svc.a.m_000 import X\n");

  try {
    const text = resultText(await callTool("impact_analysis", { file: "core/hub.py", project_root: root }));
    assert.match(text, /Directly affected \(120\), by directory:\n  svc\/a\/  40\n  svc\/b\/  40\n  web\/x\/  40\n/);
    assert.match(text, /Showing 50 of 120, most depended-on first:\n  - svc\/a\/m_000\.py\n/);
    assert.match(text, /Indirectly affected \(80\), by directory:\n  jobs\/  80\nShowing 50 of 80, closest first:/);
    assert.match(text, /Total affected files: 200/);
    assert.match(text, /pass "limit" \(max 500\)/);
    assert.ok(text.split("\n").length < 120, "a capped answer stays short");

    const full = resultText(await callTool("impact_analysis", { file: "core/hub.py", limit: 500, project_root: root }));
    assert.match(full, /Directly affected \(120\):\n/);
    assert.match(full, /Indirectly affected \(80\):\n/);
    assert.doesNotMatch(full, /by directory|pass "limit"/);
    assert.equal(full.match(/^  - /gm).length, 200);

    const dependents = resultText(await callTool("get_dependents", { file: "core/hub.py", limit: 10, project_root: root }));
    assert.match(dependents, /Files that depend on core\/hub\.py \(120\), by directory:/);
    assert.equal(dependents.match(/^  - /gm).length, 10);

    const multi = resultText(await callTool("multi_file_impact", { files: ["core/hub.py"], limit: 10, project_root: root }));
    assert.match(multi, /Changed files \(1\):\n  - core\/hub\.py/);
    assert.match(multi, /Showing 10 of 120, most depended-on first:/);
    assert.equal(multi.match(/^  - /gm).length, 21);

    const tooMany = await callTool("impact_analysis", { file: "core/hub.py", limit: 501, project_root: root });
    assert.equal(tooMany.isError, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("visualize_graph keeps output inside the root, filters scope before ranking, pins vis-network", async () => {
  const escaped = await callTool("visualize_graph", {
    output: "../escaped.html",
    open_browser: false,
    project_root: FIXTURES.ts,
  });
  assert.equal(escaped.isError, true);
  assert.equal(existsSync(join(FIXTURES.ts, "..", "escaped.html")), false);

  // only .html outputs, and never over a file the tool did not generate
  const notHtml = await callTool("visualize_graph", { output: "tsconfig.json", open_browser: false, project_root: FIXTURES.ts });
  assert.equal(notHtml.isError, true);
  assert.match(readFileSync(join(FIXTURES.ts, "tsconfig.json"), "utf-8"), /extends/);
  const foreign = await callTool("visualize_graph", { output: "keep.html", open_browser: false, project_root: FIXTURES.ts });
  assert.equal(foreign.isError, true);
  assert.match(resultText(foreign), /not generated by this tool/);
  assert.equal(readFileSync(join(FIXTURES.ts, "keep.html"), "utf-8"), "<p>not generated by the tool</p>\n");

  const out = join(FIXTURES.ts, "graph-test.html");
  try {
    const result = await callTool("visualize_graph", {
      output: "graph-test.html",
      scope: "src/lib",
      top: 2,
      open_browser: false,
      project_root: FIXTURES.ts,
    });
    assert.equal(result.isError, undefined);
    assert.match(resultText(result), /Not opened in browser/);
    const html = readFileSync(out, "utf-8");
    assert.match(html, /generated by codebase-graph-mcp/);
    assert.match(html, /vis-network@10\.1\.2/);
    assert.match(html, /integrity="sha384-/);
    assert.match(html, /"id": "src\/lib\/helper\.ts"/);
    assert.doesNotMatch(html, /"id": "src\/util\.ts"/, "scope filter applied before top-N");

    // a second run may overwrite the tool's own output
    const again = await callTool("visualize_graph", { output: "graph-test.html", open_browser: false, project_root: FIXTURES.ts });
    assert.equal(again.isError, undefined);
  } finally {
    rmSync(out, { force: true });
  }
});
