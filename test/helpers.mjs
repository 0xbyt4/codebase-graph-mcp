import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..");
export const SERVER = join(REPO_ROOT, "build", "index.js");

export const FIXTURES = {
  ts: join(here, "fixtures", "ts-alias"),
  py: join(here, "fixtures", "py-pkg"),
  rs: join(here, "fixtures", "rust-crate"),
};

export function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** A throw-away repository with a few commits touching files in two directories. */
export function makeRepo() {
  const root = tempDir("cg-repo-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "pkg", "sub"), { recursive: true });

  const write = (rel, text) => writeFileSync(join(root, rel), text);
  write("pkg/a.py", "from pkg.sub import b\n");
  write("pkg/sub/b.py", "x = 1\n");
  write("pkg/sub/c.py", "y = 1\n");
  write("README.md", "# fixture\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");

  write("pkg/a.py", "from pkg.sub import b\nz = 2\n");
  write("pkg/sub/b.py", "x = 2\n");
  git(root, "commit", "-q", "-am", "change a and b together");

  write("pkg/sub/c.py", "y = 3\n");
  git(root, "commit", "-q", "-am", "change c alone");

  // uncommitted change, so `git diff <ref>` has something to report
  write("pkg/sub/b.py", "x = 3\n");
  return root;
}

/**
 * Drive the built server over stdio: initialize, then one tools/call.
 * Resolves with the tool result object.
 */
export function callTool(name, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], { cwd: cwd || REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`timeout; stderr: ${stderr}`));
    }, 30_000);

    proc.stderr.on("data", (d) => (stderr += d));
    proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          proc.kill();
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
  });
}

export function listTools() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("timeout"));
    }, 30_000);
    proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          proc.kill();
          resolve(msg.result.tools);
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
  });
}

export const resultText = (result) => result.content.map((c) => c.text).join("\n");
