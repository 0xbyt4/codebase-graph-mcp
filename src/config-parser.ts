import JSON5 from "json5";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ConfigDependency {
  configFile: string;
  targetFile: string;
  reason: string;
}

/**
 * Parse all JSON5 config files in a project and resolve references
 * to Python modules (plugins, actions, hooks, etc.).
 */
export function parseConfigDependencies(
  projectRoot: string,
): ConfigDependency[] {
  const configDir = join(projectRoot, "config");
  if (!existsSync(configDir) || !statSync(configDir).isDirectory()) {
    return [];
  }

  const results: ConfigDependency[] = [];

  const entries = readdirSync(configDir);
  for (const entry of entries) {
    if (!entry.endsWith(".json5") && !entry.endsWith(".json")) continue;
    const configPath = join(configDir, entry);
    try {
      const content = readFileSync(configPath, "utf-8");
      const parsed = JSON5.parse(content);
      const deps = resolveConfigObject(parsed, configPath, projectRoot);
      results.push(...deps);
    } catch {
      // Skip unparseable config files
    }
  }

  return results;
}

function resolveConfigObject(
  obj: unknown,
  configFile: string,
  projectRoot: string,
): ConfigDependency[] {
  if (!obj || typeof obj !== "object") return [];

  const results: ConfigDependency[] = [];
  const root = obj as Record<string, unknown>;

  // cortex_llm.type -> llm/plugins/*.py
  if (root.cortex_llm && typeof root.cortex_llm === "object") {
    const llm = root.cortex_llm as Record<string, unknown>;
    if (typeof llm.type === "string") {
      const resolved = resolveClassInPluginDir(
        llm.type,
        "src/llm/plugins",
        projectRoot,
      );
      if (resolved) {
        results.push({
          configFile,
          targetFile: resolved,
          reason: `cortex_llm.type = "${llm.type}"`,
        });
      }
    }
  }

  // agent_inputs[].type -> inputs/plugins/*.py
  if (Array.isArray(root.agent_inputs)) {
    for (const input of root.agent_inputs) {
      if (input && typeof input === "object" && typeof input.type === "string") {
        const resolved = resolveClassInPluginDir(
          input.type,
          "src/inputs/plugins",
          projectRoot,
        );
        if (resolved) {
          results.push({
            configFile,
            targetFile: resolved,
            reason: `agent_inputs[].type = "${input.type}"`,
          });
        }
      }
    }
  }

  // agent_actions[].name + connector -> actions/{name}/interface.py + actions/{name}/connector/{connector}.py
  if (Array.isArray(root.agent_actions)) {
    for (const action of root.agent_actions) {
      if (!action || typeof action !== "object") continue;
      const act = action as Record<string, unknown>;

      if (typeof act.name === "string") {
        const deps = resolveActionConfig(
          act.name,
          typeof act.connector === "string" ? act.connector : undefined,
          projectRoot,
        );
        for (const dep of deps) {
          results.push({ configFile, ...dep });
        }
      }
    }
  }

  // simulators[].type -> simulators/plugins/*.py
  if (Array.isArray(root.simulators)) {
    for (const sim of root.simulators) {
      if (sim && typeof sim === "object" && typeof sim.type === "string") {
        const resolved = resolveClassInPluginDir(
          sim.type,
          "src/simulators/plugins",
          projectRoot,
        );
        if (resolved) {
          results.push({
            configFile,
            targetFile: resolved,
            reason: `simulators[].type = "${sim.type}"`,
          });
        }
      }
    }
  }

  // backgrounds[].type -> backgrounds/plugins/*.py
  if (Array.isArray(root.backgrounds)) {
    for (const bg of root.backgrounds) {
      if (bg && typeof bg === "object" && typeof bg.type === "string") {
        const resolved = resolveClassInPluginDir(
          bg.type,
          "src/backgrounds/plugins",
          projectRoot,
        );
        if (resolved) {
          results.push({
            configFile,
            targetFile: resolved,
            reason: `backgrounds[].type = "${bg.type}"`,
          });
        }
      }
    }
  }

  // lifecycle_hooks[].module_name -> hooks/{module_name}.py
  if (Array.isArray(root.lifecycle_hooks)) {
    for (const hook of root.lifecycle_hooks) {
      if (
        hook &&
        typeof hook === "object" &&
        typeof hook.module_name === "string"
      ) {
        const resolved = resolveHookConfig(hook.module_name, projectRoot);
        if (resolved) {
          results.push({
            configFile,
            targetFile: resolved,
            reason: `lifecycle_hooks[].module_name = "${hook.module_name}"`,
          });
        }
      }
    }
  }

  // modes.{mode_name} - recursively process each mode as a config object
  if (root.modes && typeof root.modes === "object") {
    const modes = root.modes as Record<string, unknown>;
    for (const modeName of Object.keys(modes)) {
      const modeConfig = modes[modeName];
      if (modeConfig && typeof modeConfig === "object") {
        const modeDeps = resolveConfigObject(modeConfig, configFile, projectRoot);
        results.push(...modeDeps);
      }
    }
  }

  return results;
}

/**
 * Scan .py files in a plugin directory for a class definition matching className.
 * Returns the absolute path if found.
 */
export function resolveClassInPluginDir(
  className: string,
  pluginsDir: string,
  projectRoot: string,
): string | null {
  const absDir = resolve(projectRoot, pluginsDir);
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    return null;
  }

  const classPattern = new RegExp(`^class\\s+${escapeRegex(className)}\\b`);

  const files = readdirSync(absDir);
  for (const file of files) {
    if (!file.endsWith(".py")) continue;
    const filePath = join(absDir, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (classPattern.test(line.trim())) {
          return filePath;
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return null;
}

/**
 * Resolve action config to interface and connector file paths.
 */
export function resolveActionConfig(
  name: string,
  connector: string | undefined,
  projectRoot: string,
): { targetFile: string; reason: string }[] {
  const results: { targetFile: string; reason: string }[] = [];

  const interfacePath = join(
    projectRoot,
    "src",
    "actions",
    name,
    "interface.py",
  );
  if (existsSync(interfacePath) && statSync(interfacePath).isFile()) {
    results.push({
      targetFile: interfacePath,
      reason: `agent_actions[].name = "${name}" -> interface`,
    });
  }

  if (connector) {
    const connectorPath = join(
      projectRoot,
      "src",
      "actions",
      name,
      "connector",
      `${connector}.py`,
    );
    if (existsSync(connectorPath) && statSync(connectorPath).isFile()) {
      results.push({
        targetFile: connectorPath,
        reason: `agent_actions[].connector = "${connector}"`,
      });
    }
  }

  return results;
}

/**
 * Resolve hook module_name to file path.
 */
export function resolveHookConfig(
  moduleName: string,
  projectRoot: string,
): string | null {
  const hookPath = join(projectRoot, "src", "hooks", `${moduleName}.py`);
  if (existsSync(hookPath) && statSync(hookPath).isFile()) {
    return hookPath;
  }
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
