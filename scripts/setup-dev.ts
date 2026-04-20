import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

async function ensureEnvFile() {
  if (existsSync(".env")) {
    console.log("setup: .env already exists");
    return;
  }

  await copyFile(".env.example", ".env");
  console.log("setup: created .env from .env.example");
}

async function ensureDataDirectories() {
  await mkdir("data/dev", { recursive: true });
  await mkdir("tasks/dev", { recursive: true });
  console.log("setup: ensured dev data directories");
}

function runMigrations() {
  return new Promise<void>((resolve, reject) => {
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(pnpmCommand, ["db:migrate"], {
      stdio: "inherit",
      shell: false,
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Migration process exited with signal ${signal}`));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Migration process exited with code ${code ?? 1}`));
    });

    child.on("error", reject);
  });
}

async function main() {
  await ensureEnvFile();
  await ensureDataDirectories();
  await runMigrations();
  console.log("setup: development environment is ready");
}

main().catch((error) => {
  console.error("setup: failed to prepare development environment");
  console.error(error);
  process.exit(1);
});
