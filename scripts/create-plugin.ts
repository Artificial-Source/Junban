/**
 * Plugin scaffolding CLI for ASF Saydo.
 *
 * Usage: pnpm plugin:create <plugin-name>
 *
 * Creates a new plugin directory under plugins/ with a manifest.json
 * and a starter index.ts that extends the Plugin base class.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");

// --- Helpers ---

function toTitleCase(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function validateName(name: string): string | null {
  if (!name) {
    return "Plugin name is required.";
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return 'Plugin name must be lowercase alphanumeric with hyphens (e.g. "my-plugin"). No spaces, no uppercase, no special characters.';
  }
  if (name.length < 2) {
    return "Plugin name must be at least 2 characters.";
  }
  if (name.length > 50) {
    return "Plugin name must be 50 characters or fewer.";
  }
  return null;
}

// --- Templates ---

function manifestTemplate(id: string, displayName: string): string {
  const manifest = {
    id,
    name: displayName,
    version: "1.0.0",
    author: "Your Name",
    description: "A Saydo plugin",
    main: "index.ts",
    minSaydoVersion: "1.0.0",
    permissions: ["task:read", "commands"],
    settings: [
      {
        id: "enabled",
        name: "Enabled",
        type: "boolean",
        default: true,
        description: "Enable or disable this plugin",
      },
    ],
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

function indexTemplate(id: string, displayName: string): string {
  // Convert "my-plugin" to "MyPlugin" for the class name
  const className =
    id
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("") + "Plugin";

  return `import { Plugin } from "../../src/plugins/lifecycle.js";

/**
 * ${displayName} — a Saydo plugin.
 *
 * This is the entry point for the plugin. The loader will instantiate
 * this class, inject \`this.app\` (the Plugin API) and \`this.settings\`,
 * then call \`onLoad()\`.
 *
 * Available APIs (depending on permissions in manifest.json):
 *   this.app.tasks      — task CRUD (requires task:read / task:write)
 *   this.app.projects   — project CRUD (requires project:read / project:write)
 *   this.app.tags       — tag CRUD (requires tag:read / tag:write)
 *   this.app.commands   — register commands (requires commands)
 *   this.app.ui         — register panels, views, status items
 *   this.app.events     — listen to task lifecycle events
 *   this.app.storage    — key-value storage scoped to this plugin
 *   this.settings.get() — read plugin settings
 *   this.settings.set() — write plugin settings
 */
export default class ${className} extends Plugin {
  async onLoad(): Promise<void> {
    // Register a sample command accessible from the Command Palette
    this.app.commands.register({
      id: "${id}:hello",
      name: "${displayName}: Hello",
      callback: () => {
        console.log("[${id}] Hello from ${displayName}!");
      },
    });

    console.log("[${id}] Plugin loaded.");
  }

  async onUnload(): Promise<void> {
    // Clean up any resources (listeners, timers, etc.)
    console.log("[${id}] Plugin unloaded.");
  }
}
`;
}

// --- Main ---

function main(): void {
  const args = process.argv.slice(2);
  const name = args[0];

  // Validate
  const error = validateName(name);
  if (error) {
    console.error(`\x1b[31mError:\x1b[0m ${error}`);
    console.error(`\nUsage: pnpm plugin:create <plugin-name>`);
    console.error(`Example: pnpm plugin:create my-plugin`);
    process.exit(1);
  }

  // Check plugins/ directory exists
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  }

  const pluginDir = path.join(PLUGINS_DIR, name);

  // Check if plugin already exists
  if (fs.existsSync(pluginDir)) {
    console.error(
      `\x1b[31mError:\x1b[0m Plugin directory already exists: plugins/${name}/`
    );
    process.exit(1);
  }

  const displayName = toTitleCase(name);

  // Create plugin directory and files
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "manifest.json"),
    manifestTemplate(name, displayName)
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.ts"),
    indexTemplate(name, displayName)
  );

  // Print success
  console.log(`\n\x1b[32m✔\x1b[0m Plugin scaffolded: plugins/${name}/\n`);
  console.log(`  plugins/${name}/`);
  console.log(`  ├── manifest.json`);
  console.log(`  └── index.ts\n`);
  console.log(`\x1b[1mNext steps:\x1b[0m`);
  console.log(`  1. Edit \x1b[36mplugins/${name}/manifest.json\x1b[0m`);
  console.log(
    `     - Set your author name and description`
  );
  console.log(
    `     - Add any permissions you need (see src/plugins/types.ts for the full list)`
  );
  console.log(`  2. Edit \x1b[36mplugins/${name}/index.ts\x1b[0m`);
  console.log(
    `     - Implement your plugin logic in onLoad()`
  );
  console.log(`  3. Restart Saydo — the plugin loader will pick it up automatically.`);
  console.log(
    `\n  Docs: docs/plugins/API.md\n`
  );
}

main();
