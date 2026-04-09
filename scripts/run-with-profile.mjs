import { spawn } from "node:child_process";

const [, , profile, command, ...args] = process.argv;
const VALID_PROFILES = new Set(["daily", "dev"]);

if (!profile || !command) {
  console.error("Usage: node scripts/run-with-profile.mjs <profile> <command> [...args]");
  process.exit(1);
}

if (!VALID_PROFILES.has(profile)) {
  console.error(
    `Invalid profile \"${profile}\". Expected one of: ${Array.from(VALID_PROFILES).join(", ")}`,
  );
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    JUNBAN_PROFILE: profile,
  },
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
