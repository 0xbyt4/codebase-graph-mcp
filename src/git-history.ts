import { execFileSync } from "node:child_process";
import { relative } from "node:path";

export interface FileChurnEntry {
  file: string;
  commits: number;
  firstSeen: string;
  lastChanged: string;
}

export interface FileChurnResult {
  period: string;
  files: FileChurnEntry[];
  totalCommits: number;
}

export interface CoChangeEntry {
  file: string;
  coChangeCount: number;
  totalChanges: number;
  correlation: number; // coChangeCount / min(targetChanges, fileChanges)
}

export interface CoChangeResult {
  targetFile: string;
  targetChanges: number;
  period: string;
  coChanges: CoChangeEntry[];
}

/**
 * Get file churn data: how often each file changed in the given period.
 */
export function getFileChurn(
  projectRoot: string,
  days: number = 90,
): FileChurnResult {
  const since = `${days}.days.ago`;

  // Get commit count per file
  let output: string;
  try {
    output = execFileSync(
      "git", ["log", `--since=${since}`, "--format=", "--name-only", "--diff-filter=AMRC"],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ).trim();
  } catch {
    return { period: `${days} days`, files: [], totalCommits: 0 };
  }

  if (!output) {
    return { period: `${days} days`, files: [], totalCommits: 0 };
  }

  // Count occurrences of each file
  const fileCounts = new Map<string, number>();
  for (const line of output.split("\n")) {
    const file = line.trim();
    if (!file) continue;
    fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
  }

  // Get first and last change dates for top files
  const sorted = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Get total unique commits in period
  let totalCommits = 0;
  try {
    const commitOutput = execFileSync(
      "git", ["rev-list", "--count", `--since=${since}`, "HEAD"],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 10000,
      },
    ).trim();
    totalCommits = parseInt(commitOutput, 10) || 0;
  } catch {
    // ignore
  }

  const files: FileChurnEntry[] = [];
  for (const [file, commits] of sorted.slice(0, 30)) {
    let firstSeen = "";
    let lastChanged = "";
    try {
      lastChanged = execFileSync(
        "git", ["log", "-1", `--since=${since}`, "--format=%ai", "--", file],
        { cwd: projectRoot, encoding: "utf-8", timeout: 5000 },
      )
        .trim()
        .slice(0, 10);
      const allDates = execFileSync(
        "git", ["log", `--since=${since}`, "--format=%ai", "--", file],
        { cwd: projectRoot, encoding: "utf-8", timeout: 5000 },
      ).trim();
      const dateLines = allDates.split("\n").filter((l) => l.trim());
      firstSeen = dateLines.length > 0 ? dateLines[dateLines.length - 1].trim().slice(0, 10) : "";
    } catch {
      // dates are optional
    }

    files.push({ file, commits, firstSeen, lastChanged });
  }

  return { period: `${days} days`, files, totalCommits };
}

/**
 * Find files that frequently change together with a target file.
 */
export function getCoChanges(
  projectRoot: string,
  targetFile: string,
  days: number = 90,
): CoChangeResult {
  const since = `${days}.days.ago`;
  const relTarget =
    targetFile.startsWith("/")
      ? relative(projectRoot, targetFile)
      : targetFile;

  // Get all commits that touched the target file
  let commitHashes: string[];
  try {
    const output = execFileSync(
      "git", ["log", `--since=${since}`, "--format=%H", "--", relTarget],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 15000,
      },
    ).trim();
    commitHashes = output ? output.split("\n").filter((h) => h.trim()) : [];
  } catch {
    return {
      targetFile: relTarget,
      targetChanges: 0,
      period: `${days} days`,
      coChanges: [],
    };
  }

  if (commitHashes.length === 0) {
    return {
      targetFile: relTarget,
      targetChanges: 0,
      period: `${days} days`,
      coChanges: [],
    };
  }

  // For each commit, get all other files that changed
  const coChangeCount = new Map<string, number>();
  for (const hash of commitHashes) {
    try {
      const filesOutput = execFileSync(
        "git", ["diff-tree", "--no-commit-id", "--name-only", "-r", hash],
        {
          cwd: projectRoot,
          encoding: "utf-8",
          timeout: 5000,
        },
      ).trim();
      if (!filesOutput) continue;

      for (const file of filesOutput.split("\n")) {
        const f = file.trim();
        if (!f || f === relTarget) continue;
        coChangeCount.set(f, (coChangeCount.get(f) || 0) + 1);
      }
    } catch {
      // skip individual commit errors
    }
  }

  // Get total change count per file for correlation calculation
  const fileChangeCounts = new Map<string, number>();
  try {
    const output = execFileSync(
      "git", ["log", `--since=${since}`, "--format=", "--name-only", "--diff-filter=AMRC"],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ).trim();
    for (const line of output.split("\n")) {
      const f = line.trim();
      if (!f) continue;
      fileChangeCounts.set(f, (fileChangeCounts.get(f) || 0) + 1);
    }
  } catch {
    // ignore
  }

  const targetChanges = commitHashes.length;
  const coChanges: CoChangeEntry[] = [];

  for (const [file, count] of coChangeCount.entries()) {
    const totalChanges = fileChangeCounts.get(file) || count;
    const minChanges = Math.min(targetChanges, totalChanges);
    const correlation = minChanges > 0 ? count / minChanges : 0;

    coChanges.push({
      file,
      coChangeCount: count,
      totalChanges,
      correlation: Math.round(correlation * 100) / 100,
    });
  }

  // Sort by co-change count descending
  coChanges.sort((a, b) => b.coChangeCount - a.coChangeCount);

  return {
    targetFile: relTarget,
    targetChanges,
    period: `${days} days`,
    coChanges: coChanges.slice(0, 20),
  };
}
