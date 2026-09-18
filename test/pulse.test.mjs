import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { buildGraph } from "../build/graph.js";
import { buildGraphPage } from "../build/visualize.js";
import { REPO_ROOT, tempDir } from "./helpers.mjs";

const PULSE = join(REPO_ROOT, "pulse", "codebase_pulse.py");
const APP = join(REPO_ROOT, "test", "fixtures", "pulse-app");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

/** Start the fixture program under the sampler; resolves with { base, token, stop }. */
function startPulse(seconds, pages) {
  return new Promise((resolve, reject) => {
    const args = [PULSE, "--root", APP, "--port", "0"];
    if (pages) args.push("--pages", pages);
    args.push(join(APP, "main.py"), String(seconds));
    const proc = spawn("python3", args, { cwd: APP, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => reject(new Error("no banner: " + err)), 10_000);
    proc.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/live graph: (http:\/\/127\.0\.0\.1:\d+)\/\?token=(\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ base: m[1], token: m[2], stop: () => proc.kill() });
      }
    });
    proc.on("error", reject);
  });
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

/** Read the event stream for a while and return the parsed events. */
function collect(url, ms) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let raw = "";
      res.on("data", (d) => (raw += d));
      setTimeout(() => {
        req.destroy();
        const events = [];
        for (const block of raw.split("\n\n")) {
          const m = block.match(/^data: (.*)$/m);
          if (!m) continue;
          const parsed = JSON.parse(m[1]);
          events.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        }
        resolve({ status: res.statusCode, raw, events });
      }, ms);
    });
    req.on("error", reject);
  });
}

test("pulse: every request needs the token, the right Host and stays inside the pages folder", { skip: !hasPython }, async () => {
  const pages = tempDir("cg-pulse-pages-");
  writeFileSync(join(pages, "index.html"), "<!DOCTYPE html><p>atlas</p>");
  mkdirSync(join(pages, "sub"));
  writeFileSync(join(pages, "sub", "deep.html"), "<p>deep</p>");
  writeFileSync(join(pages, "notes.txt"), "not a page");
  const pulse = await startPulse(3, pages);
  try {
    const q = `?token=${pulse.token}`;
    assert.equal((await get(`${pulse.base}/pulse/info`)).status, 403, "no token");
    assert.equal((await get(`${pulse.base}/pulse/info?token=wrong`)).status, 403, "wrong token");
    assert.equal((await get(`${pulse.base}/pulse/info${q}`, { Host: "evil.example:80" })).status, 403, "DNS rebinding");

    const info = await get(`${pulse.base}/pulse/info${q}`);
    assert.equal(info.status, 200);
    assert.equal(JSON.parse(info.body).project, "pulse-app");
    assert.equal(info.headers["access-control-allow-origin"], undefined, "no cross-origin access");

    const page = await get(`${pulse.base}/page/index.html${q}`);
    assert.equal(page.status, 200);
    assert.match(page.headers["set-cookie"][0], /pulse_token=.*HttpOnly; SameSite=Strict/);
    const cookie = page.headers["set-cookie"][0].split(";")[0];
    assert.equal((await get(`${pulse.base}/pulse/info`, { Cookie: cookie })).status, 200, "cookie carries the token to linked pages");

    for (const path of ["/page/../main.py", "/page/%2e%2e/main.py", "/page/sub/deep.html", "/page/notes.txt", "/page/main.py", "/etc/passwd"]) {
      assert.equal((await get(`${pulse.base}${path}${q}`)).status, 404, path);
    }
  } finally {
    pulse.stop();
  }
});

test("pulse: streams active, parked and imported files as project-relative paths only", { skip: !hasPython }, async () => {
  const pulse = await startPulse(3);
  try {
    const { status, raw, events } = await collect(`${pulse.base}/pulse/events?token=${pulse.token}&replay=10`, 2800);
    assert.equal(status, 200);
    assert.ok(events.length > 10, `only ${events.length} events`);

    const chains = (key) => new Set(events.flatMap((e) => (e[key] || []).map((c) => c.join(">"))));
    assert.ok(chains("a").has("main.py>worker.py"), "busy loop in worker.py, called from main.py: " + [...chains("a")]);
    assert.ok(chains("h").has("main.py>worker.py"), "time.sleep in worker.py is parked, not active");
    assert.ok(chains("h").has("async_part.py"), "a suspended asyncio task is reported where it awaits");

    const imports = new Set(events.flatMap((e) => e.i || []));
    assert.ok(imports.has("late_module.py"), "import made while running");

    assert.ok(!raw.includes(REPO_ROOT), "absolute paths must never be streamed");
    assert.ok(!raw.includes("codebase_pulse"), "the sampler does not report itself");
    for (const e of events) {
      assert.deepEqual(Object.keys(e).filter((k) => !["t", "a", "h", "i"].includes(k)), [], "only time and file lists");
    }
  } finally {
    pulse.stop();
  }
});

test("graph pages carry the pulse client, idle unless served over http", async () => {
  const graph = await buildGraph(APP);
  const page = buildGraphPage(graph, APP, { top: 20 });
  assert.deepEqual(page.topFiles.map(([f]) => f).sort(), ["async_part.py", "late_module.py", "main.py", "worker.py"], "entry points are nodes too");
  assert.match(page.html, /<span id="pulse" class="pulse" hidden>/);
  assert.match(page.html, /\.pulse\[hidden\] \{ display: none; \}/, "the display rule must not defeat the hidden attribute");
  assert.match(page.html, /location\.protocol !== "http:"/);
  assert.match(page.html, /new EventSource\("\/pulse\/events\?replay=20"\)/);
  assert.doesNotMatch(page.html, /Access-Control|token=/, "pages never embed a token");
});
