import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, basename, sep } from "node:path";

/**
 * Canonical form of a project root: absolute, no trailing slash, symlinks
 * resolved, so `/x/proj/`, `/x/proj/../proj` and a symlinked alias all map to
 * the same cache entry and the same containment checks.
 */
export function normalizeRoot(root: string): string {
  const absolute = resolve(root);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Resolve `file` against `root` and reject anything that escapes it,
 * including `../sibling` and a prefix match like `/x/proj-evil` for root
 * `/x/proj`. Symlinks inside the root are resolved before the check, so a
 * link pointing outside is rejected as well; a not-yet-existing file (an
 * output path) is checked by its parent directory.
 */
export function resolveInsideRoot(file: string, root: string): string {
  const candidate = resolve(root, file);
  const canonical = canonicalize(candidate);
  const rel = relative(root, canonical);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(`Path "${file}" resolves outside project root ${root}`);
  }
  return canonical;
}

// realpath of the longest existing prefix, with the rest appended verbatim.
function canonicalize(path: string): string {
  const missing: string[] = [];
  let current = path;
  while (true) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}
