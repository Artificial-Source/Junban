import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const sidecarDir = path.join(rootDir, "src-tauri", "gen", "sidecar");
const backendDir = path.join(sidecarDir, "backend");
const nodeModulesDir = path.join(sidecarDir, "node_modules");
const binariesDir = path.join(rootDir, "src-tauri", "binaries");
const staleTauriOutputDirs = [
  path.join(rootDir, "src-tauri", "target", "debug", "gen", "sidecar"),
  path.join(rootDir, "src-tauri", "target", "release", "gen", "sidecar"),
  path.join(rootDir, "src-tauri", "target", "debug", "bundle", "appimage"),
  path.join(rootDir, "src-tauri", "target", "release", "bundle", "appimage"),
  path.join(rootDir, "src-tauri", "target", "debug", "bundle", "appimage_deb"),
  path.join(rootDir, "src-tauri", "target", "release", "bundle", "appimage_deb"),
];
const removablePnpmPackagePrefixes = ["sharp@", "@img+sharp-", "@img+sharp-libvips-"];

function collectFiles(targetDir, matcher, collected = []) {
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const entryPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      collectFiles(entryPath, matcher, collected);
      continue;
    }

    if (entry.isFile() && matcher(entryPath, entry)) {
      collected.push(entryPath);
    }
  }

  return collected;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function detectTargetTriple() {
  const { platform, arch } = process;

  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";
  if (platform === "win32" && arch === "ia32") return "i686-pc-windows-msvc";

  throw new Error(`Unsupported Tauri sidecar platform: ${platform} ${arch}`);
}

function copyRuntimeAssets(sourceDir, destinationDir) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      copyRuntimeAssets(sourcePath, destinationPath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!sourcePath.endsWith(".json") && !sourcePath.endsWith(".sql")) {
      continue;
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function pruneNodeModulesArtifacts(targetDir) {
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const entryPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "obj.target") {
        fs.rmSync(entryPath, { recursive: true, force: true });
        continue;
      }

      pruneNodeModulesArtifacts(entryPath);
      continue;
    }

    if (
      entry.name.endsWith(".o") ||
      entry.name.endsWith(".a") ||
      entry.name === "test_extension.node"
    ) {
      fs.rmSync(entryPath, { force: true });
    }
  }
}

function pruneBundlingIncompatiblePackages() {
  const pnpmDir = path.join(nodeModulesDir, ".pnpm");
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        removablePnpmPackagePrefixes.some((prefix) => entry.name.startsWith(prefix))
      ) {
        fs.rmSync(path.join(pnpmDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  fs.rmSync(path.join(pnpmDir, "node_modules", "sharp"), { recursive: true, force: true });
  fs.rmSync(path.join(pnpmDir, "node_modules", "@img", "sharp-linux-x64"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(pnpmDir, "node_modules", "@img", "sharp-libvips-linux-x64"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(nodeModulesDir, "sharp"), { recursive: true, force: true });
}

function pruneDanglingSharpLinks(targetDir) {
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const entryPath = path.join(targetDir, entry.name);

    if (entry.isSymbolicLink()) {
      if (entry.name === "sharp" || entry.name.startsWith("sharp-")) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
      continue;
    }

    if (entry.isDirectory()) {
      pruneDanglingSharpLinks(entryPath);
    }
  }
}

function deployProductionNodeModules(targetDir) {
  run("pnpm", ["--filter", ".", "deploy", "--legacy", "--prod", targetDir]);

  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }

    fs.rmSync(path.join(targetDir, entry.name), { recursive: true, force: true });
  }

  pruneNodeModulesArtifacts(nodeModulesDir);
  pruneBundlingIncompatiblePackages();
  pruneDanglingSharpLinks(nodeModulesDir);
}

function copyBetterSqlite3NativeBindings() {
  const sourcePackageDir = fs.realpathSync(path.join(rootDir, "node_modules", "better-sqlite3"));
  const stagedPackageDir = fs.realpathSync(path.join(nodeModulesDir, "better-sqlite3"));
  const bindingPaths = collectFiles(
    sourcePackageDir,
    (entryPath, entry) => entry.name === "better_sqlite3.node" && entryPath.endsWith(".node"),
  );

  if (bindingPaths.length === 0) {
    throw new Error(
      `Could not find a compiled better-sqlite3 native binding under ${sourcePackageDir}`,
    );
  }

  for (const bindingPath of bindingPaths) {
    const relativeBindingPath = path.relative(sourcePackageDir, bindingPath);
    const stagedBindingPath = path.join(stagedPackageDir, relativeBindingPath);
    fs.mkdirSync(path.dirname(stagedBindingPath), { recursive: true });
    fs.copyFileSync(bindingPath, stagedBindingPath);
    fs.chmodSync(stagedBindingPath, fs.statSync(bindingPath).mode);
  }
}

function cleanStaleTauriOutputs() {
  for (const staleDir of staleTauriOutputDirs) {
    fs.rmSync(staleDir, { recursive: true, force: true });
  }
}

function main() {
  cleanStaleTauriOutputs();
  fs.rmSync(sidecarDir, { recursive: true, force: true });
  fs.mkdirSync(sidecarDir, { recursive: true });

  deployProductionNodeModules(sidecarDir);
  copyBetterSqlite3NativeBindings();

  run("pnpm", ["exec", "tsc", "-p", "tsconfig.node-sidecar.json"]);

  copyRuntimeAssets(path.join(rootDir, "src"), backendDir);
  fs.writeFileSync(
    path.join(backendDir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2),
  );

  fs.mkdirSync(binariesDir, { recursive: true });
  const targetTriple = detectTargetTriple();
  const extension = process.platform === "win32" ? ".exe" : "";
  const sidecarBinaryPath = path.join(binariesDir, `junban-node-${targetTriple}${extension}`);

  fs.copyFileSync(fs.realpathSync(process.execPath), sidecarBinaryPath);
  if (process.platform !== "win32") {
    fs.chmodSync(sidecarBinaryPath, 0o755);
  }
}

main();
