import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
const MAX_BUFFER = 64 * 1024 * 1024;
// A ref is passed to git positionally, so it must never look like an option
// (`--output=FILE` would make `git diff` write to FILE). Anything git itself
// refuses as a ref name is rejected as well.
export function assertValidGitRef(ref, cwd) {
    if (!ref || ref.startsWith("-") || /[\s\0]/.test(ref)) {
        throw new Error(`Invalid git ref "${ref}"`);
    }
    try {
        execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
            cwd,
            encoding: "utf-8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "ignore"],
        });
    }
    catch {
        throw new Error(`Git ref "${ref}" does not name a commit`);
    }
}
/**
 * Files changed between `ref` and the working tree, relative to `cwd`
 * (which may be a subdirectory of the repository).
 */
export function changedFilesSince(ref, cwd) {
    assertValidGitRef(ref, cwd);
    const output = execFileSync("git", ["-c", "core.quotePath=false", "diff", "--name-only", "--relative", ref, "--"], {
        cwd,
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: MAX_BUFFER,
    }).trim();
    return output ? output.split("\n").filter((f) => f.trim()) : [];
}
// One `git log` walk: commits newest first, each as a header line
// "<hash>\t<iso date>" followed by the files it touched under cwd.
function walkLog(projectRoot, days, pathspec) {
    const args = [
        "-c",
        "core.quotePath=false",
        "log",
        `--since=${days}.days.ago`,
        "--format=%H%x09%aI",
        "--name-only",
        "--relative",
        "--diff-filter=AMRC",
    ];
    if (pathspec !== undefined)
        args.push("--", pathspec);
    const output = execFileSync("git", args, {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 60_000,
        maxBuffer: MAX_BUFFER,
    });
    const commits = [];
    for (const line of output.split("\n")) {
        if (!line)
            continue;
        const tab = line.indexOf("\t");
        if (tab === 40 && /^[0-9a-f]{40}$/.test(line.slice(0, 40))) {
            commits.push({ hash: line.slice(0, 40), date: line.slice(tab + 1, tab + 11), files: [] });
        }
        else if (commits.length > 0) {
            commits[commits.length - 1].files.push(line);
        }
    }
    return commits;
}
/**
 * Get file churn data: how often each file changed in the given period.
 * Throws when the root is not inside a git repository.
 */
export function getFileChurn(projectRoot, days = 90) {
    const period = `${days} days`;
    const commits = walkLog(projectRoot, days);
    const stats = new Map();
    for (const commit of commits) {
        for (const file of commit.files) {
            const entry = stats.get(file);
            if (entry) {
                entry.commits++;
                entry.firstSeen = commit.date; // log is newest first, so the last hit is the oldest
            }
            else {
                stats.set(file, { file, commits: 1, firstSeen: commit.date, lastChanged: commit.date });
            }
        }
    }
    const files = [...stats.values()].sort((a, b) => b.commits - a.commits).slice(0, 30);
    return { period, files, totalCommits: commits.length };
}
/**
 * Find files that frequently change together with a target file.
 * Throws when the root is not inside a git repository.
 */
export function getCoChanges(projectRoot, targetFile, days = 90) {
    const period = `${days} days`;
    // Normalize so "./src/x.py", "src/x.py" and an absolute path all compare equal
    const relTarget = relative(projectRoot, resolve(projectRoot, targetFile));
    const targetCommits = walkLog(projectRoot, days, relTarget);
    const targetChanges = targetCommits.length;
    if (targetChanges === 0) {
        return { targetFile: relTarget, targetChanges: 0, period, coChanges: [] };
    }
    // Files touched by the same commits (the pathspec-limited log only lists
    // the target itself, so re-read those commits without the limit)
    const targetHashes = new Set(targetCommits.map((c) => c.hash));
    const allCommits = walkLog(projectRoot, days);
    const coChangeCount = new Map();
    const fileChangeCounts = new Map();
    for (const commit of allCommits) {
        const together = targetHashes.has(commit.hash);
        for (const file of commit.files) {
            fileChangeCounts.set(file, (fileChangeCounts.get(file) || 0) + 1);
            if (together && file !== relTarget) {
                coChangeCount.set(file, (coChangeCount.get(file) || 0) + 1);
            }
        }
    }
    const coChanges = [];
    for (const [file, count] of coChangeCount.entries()) {
        const totalChanges = fileChangeCounts.get(file) || count;
        const minChanges = Math.min(targetChanges, totalChanges);
        coChanges.push({
            file,
            coChangeCount: count,
            totalChanges,
            correlation: minChanges > 0 ? Math.round((count / minChanges) * 100) / 100 : 0,
        });
    }
    coChanges.sort((a, b) => b.coChangeCount - a.coChangeCount);
    return { targetFile: relTarget, targetChanges, period, coChanges: coChanges.slice(0, 20) };
}
