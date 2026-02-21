import { readFileSync, existsSync, statSync } from "node:fs";
import { relative } from "node:path";

export interface ClassInfo {
  name: string;
  file: string;
  bases: string[];
  methods: string[];
}

export interface ClassHierarchy {
  classes: Map<string, ClassInfo[]>; // className -> ClassInfo[] (same name in multiple files)
  subclasses: Map<string, Set<string>>; // className -> set of subclass names
  fileClasses: Map<string, ClassInfo[]>; // filePath -> classes in that file
}

// Match class definition - use greedy match up to ): to handle nested brackets
const CLASS_PATTERN = /^class\s+(\w+)\s*(?:\((.*)\)\s*:)?/;
const METHOD_PATTERN = /^\s{4}(?:async\s+)?def\s+(\w+)\s*\(/;

/**
 * Parse base class names from the parenthesized string, handling nested generics.
 * "Sensor[C, R], ABC" -> ["Sensor", "ABC"]
 */
function parseBases(basesStr: string): string[] {
  // Remove all balanced bracket content: Foo[Bar[X], Y] -> Foo
  // Split by comma at depth 0
  const bases: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of basesStr) {
    if (ch === "[") {
      depth++;
      continue;
    }
    if (ch === "]") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) bases.push(trimmed);
      current = "";
      continue;
    }

    if (depth === 0) {
      current += ch;
    }
  }

  const last = current.trim();
  if (last) bases.push(last);

  return bases.filter((b) => !b.includes("=") && b.length > 0);
}

/**
 * Build class hierarchy from a set of Python files.
 */
export function buildClassHierarchy(files: Set<string>): ClassHierarchy {
  const hierarchy: ClassHierarchy = {
    classes: new Map(),
    subclasses: new Map(),
    fileClasses: new Map(),
  };

  for (const file of files) {
    if (!file.endsWith(".py")) continue;

    let content: string;
    try {
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const classesInFile = parseClassDefinitions(file, content);
    if (classesInFile.length === 0) continue;

    hierarchy.fileClasses.set(file, classesInFile);

    for (const cls of classesInFile) {
      if (!hierarchy.classes.has(cls.name)) {
        hierarchy.classes.set(cls.name, []);
      }
      hierarchy.classes.get(cls.name)!.push(cls);

      // Build reverse index: base -> subclasses
      for (const base of cls.bases) {
        if (!hierarchy.subclasses.has(base)) {
          hierarchy.subclasses.set(base, new Set());
        }
        hierarchy.subclasses.get(base)!.add(cls.name);
      }
    }
  }

  return hierarchy;
}

/**
 * Parse class definitions and their methods from Python source.
 */
function parseClassDefinitions(file: string, content: string): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const lines = content.split("\n");

  let currentClass: ClassInfo | null = null;

  for (const line of lines) {
    const classMatch = CLASS_PATTERN.exec(line.trimStart());
    if (classMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      // Save previous class
      if (currentClass) {
        classes.push(currentClass);
      }

      const name = classMatch[1];
      const basesStr = classMatch[2] || "";
      const bases = parseBases(basesStr);

      currentClass = { name, file, bases, methods: [] };
      continue;
    }

    // Track methods inside current class (4-space indent)
    if (currentClass) {
      // End of class: non-empty line at indent 0 that's not a decorator
      if (
        line.length > 0 &&
        !line.startsWith(" ") &&
        !line.startsWith("\t") &&
        !line.startsWith("#") &&
        !line.startsWith("@")
      ) {
        classes.push(currentClass);
        currentClass = null;

        // Check if this line starts a new class
        const newClassMatch = CLASS_PATTERN.exec(line.trimStart());
        if (newClassMatch) {
          const name = newClassMatch[1];
          const basesStr = newClassMatch[2] || "";
          const bases = parseBases(basesStr);
          currentClass = { name, file, bases, methods: [] };
        }
        continue;
      }

      const methodMatch = METHOD_PATTERN.exec(line);
      if (methodMatch) {
        currentClass.methods.push(methodMatch[1]);
      }
    }
  }

  // Don't forget the last class
  if (currentClass) {
    classes.push(currentClass);
  }

  return classes;
}

export interface ClassHierarchyResult {
  className: string;
  file: string;
  bases: string[];
  methods: string[];
  subclasses: SubclassInfo[];
  ancestors: string[];
}

export interface SubclassInfo {
  name: string;
  file: string;
  overriddenMethods: string[];
  newMethods: string[];
}

/**
 * Collect all methods from a class and its full ancestor chain.
 */
function getAllAncestorMethods(
  hierarchy: ClassHierarchy,
  className: string,
): Set<string> {
  const allMethods = new Set<string>();
  const visited = new Set<string>();
  const queue = [className];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const infos = hierarchy.classes.get(current);
    if (!infos) continue;

    for (const info of infos) {
      for (const m of info.methods) {
        allMethods.add(m);
      }
      queue.push(...info.bases);
    }
  }

  return allMethods;
}

/**
 * Get all transitive subclass names via BFS through the subclasses map.
 */
function getAllTransitiveSubclasses(
  hierarchy: ClassHierarchy,
  className: string,
): Set<string> {
  const result = new Set<string>();
  const queue = [className];
  const visited = new Set<string>([className]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const directSubs = hierarchy.subclasses.get(current);
    if (!directSubs) continue;

    for (const sub of directSubs) {
      if (visited.has(sub)) continue;
      visited.add(sub);
      result.add(sub);
      queue.push(sub);
    }
  }

  return result;
}

/**
 * Get full hierarchy info for a class: ancestors, subclasses, method overrides.
 * Uses transitive subclass resolution (includes subclasses of subclasses).
 */
export function getClassInfo(
  hierarchy: ClassHierarchy,
  className: string,
  projectRoot: string,
): ClassHierarchyResult | null {
  const infos = hierarchy.classes.get(className);
  if (!infos || infos.length === 0) return null;

  // Use the first definition (most common case)
  const info = infos[0];

  // Build ancestor chain
  const ancestors: string[] = [];
  const visited = new Set<string>();
  const queue = [...info.bases];
  while (queue.length > 0) {
    const base = queue.shift()!;
    if (visited.has(base)) continue;
    visited.add(base);
    ancestors.push(base);
    const baseInfos = hierarchy.classes.get(base);
    if (baseInfos) {
      for (const bi of baseInfos) {
        queue.push(...bi.bases);
      }
    }
  }

  // Collect all methods from this class + full ancestor chain
  const allMethods = getAllAncestorMethods(hierarchy, className);

  // Find ALL subclasses (transitive) with method override analysis
  const subInfos: SubclassInfo[] = [];
  const allSubs = getAllTransitiveSubclasses(hierarchy, className);

  for (const subName of allSubs) {
    const subDefs = hierarchy.classes.get(subName);
    if (!subDefs) continue;
    for (const subDef of subDefs) {
      const overriddenMethods = subDef.methods.filter((m) =>
        allMethods.has(m),
      );
      const newMethods = subDef.methods.filter(
        (m) => !allMethods.has(m),
      );
      subInfos.push({
        name: subDef.name,
        file: relative(projectRoot, subDef.file),
        overriddenMethods,
        newMethods,
      });
    }
  }

  return {
    className: info.name,
    file: relative(projectRoot, info.file),
    bases: info.bases,
    methods: info.methods,
    subclasses: subInfos,
    ancestors,
  };
}

export interface MethodOverriderEntry {
  className: string;
  file: string;
  relationship: "defines" | "overrides";
}

/**
 * Find all classes that define or override a given method name.
 */
export function getMethodOverriders(
  hierarchy: ClassHierarchy,
  methodName: string,
  projectRoot: string,
): MethodOverriderEntry[] {
  const results: MethodOverriderEntry[] = [];

  for (const [, classInfos] of hierarchy.classes) {
    for (const cls of classInfos) {
      if (!cls.methods.includes(methodName)) continue;

      // Check if any ancestor also defines this method
      const ancestorMethods = getAllAncestorMethods(hierarchy, cls.name);
      // Remove the class's own methods to check only ancestors
      for (const m of cls.methods) {
        ancestorMethods.delete(m);
      }
      // Re-check: does any ancestor have this method?
      // We need to walk ancestors only (not self)
      let ancestorHasMethod = false;
      const visitedBases = new Set<string>();
      const baseQueue = [...cls.bases];
      while (baseQueue.length > 0) {
        const base = baseQueue.shift()!;
        if (visitedBases.has(base)) continue;
        visitedBases.add(base);
        const baseInfos = hierarchy.classes.get(base);
        if (!baseInfos) continue;
        for (const bi of baseInfos) {
          if (bi.methods.includes(methodName)) {
            ancestorHasMethod = true;
            break;
          }
          baseQueue.push(...bi.bases);
        }
        if (ancestorHasMethod) break;
      }

      results.push({
        className: cls.name,
        file: relative(projectRoot, cls.file),
        relationship: ancestorHasMethod ? "overrides" : "defines",
      });
    }
  }

  // Sort: defines first, then overrides, alphabetically within each group
  results.sort((a, b) => {
    if (a.relationship !== b.relationship) {
      return a.relationship === "defines" ? -1 : 1;
    }
    return a.className.localeCompare(b.className);
  });

  return results;
}

/**
 * Get classes defined in a specific file with their hierarchy context.
 */
export function getFileClasses(
  hierarchy: ClassHierarchy,
  filePath: string,
  projectRoot: string,
): ClassHierarchyResult[] {
  const classes = hierarchy.fileClasses.get(filePath);
  if (!classes) return [];

  const results: ClassHierarchyResult[] = [];
  for (const cls of classes) {
    const info = getClassInfo(hierarchy, cls.name, projectRoot);
    if (info) results.push(info);
  }
  return results;
}
