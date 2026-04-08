#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";

const VERSION = process.argv[2];
if (!VERSION || !/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error("Usage: pnpm release:prepare <version>");
  process.exit(1);
}

const root = process.cwd();

// package.json
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
pkg.version = VERSION;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// tauri.conf.json
const tauriPath = path.join(root, "src-tauri", "tauri.conf.json");
const tauri = JSON.parse(fs.readFileSync(tauriPath, "utf-8"));
tauri.version = VERSION;
fs.writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + "\n");

// src/config/defaults.ts
const defaultsPath = path.join(root, "src", "config", "defaults.ts");
let defaults = fs.readFileSync(defaultsPath, "utf-8");
defaults = defaults.replace(
  /export const APP_VERSION = ".*";/,
  `export const APP_VERSION = "${VERSION}";`,
);
fs.writeFileSync(defaultsPath, defaults);

// Cargo.toml
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
let cargo = fs.readFileSync(cargoPath, "utf-8");
cargo = cargo.replace(/^version = ".*"$/m, `version = "${VERSION}"`);
fs.writeFileSync(cargoPath, cargo);

// sources.json
const sourcesPath = path.join(root, "sources.json");
const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));
sources.lastUpdated = new Date().toISOString().split("T")[0];
for (const p of sources.plugins) {
  p.minJunbanVersion = VERSION;
}
fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + "\n");

console.log(`Updated release version references to ${VERSION}`);
