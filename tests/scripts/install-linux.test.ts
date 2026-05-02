import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const rootDir = path.resolve(import.meta.dirname, "..", "..");
const scriptPath = path.join(rootDir, "scripts", "install-linux.sh");
const tempDirs: string[] = [];

type RunOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
  home?: string | null;
  includeAptGet?: boolean;
  includeSudo?: boolean;
  isRoot?: boolean;
  seedStaleLaunchers?: boolean;
};

type MockBinOptions = {
  includeAptGet: boolean;
  includeSudo: boolean;
  isRoot: boolean;
};

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "junban-installer-test-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeExecutable(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function resolveCommand(command: string) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Could not resolve command: ${command}`);
  }
  return result.stdout.trim();
}

function symlinkCommand(mockBin: string, command: string) {
  fs.symlinkSync(resolveCommand(command), path.join(mockBin, command));
}

function createMockBin(mockBin: string, { includeAptGet, includeSudo, isRoot }: MockBinOptions) {
  fs.mkdirSync(mockBin, { recursive: true });
  for (const command of ["chmod", "head", "mkdir", "mktemp", "rm", "sed", "tr"]) {
    symlinkCommand(mockBin, command);
  }

  writeExecutable(
    path.join(mockBin, "uname"),
    `#!/bin/sh
case "\${1:-}" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'x86_64\\n' ;;
  *) printf 'Linux\\n' ;;
esac
`,
  );

  writeExecutable(
    path.join(mockBin, "id"),
    `#!/bin/sh
printf '${isRoot ? "0" : "1000"}\\n'
`,
  );

  writeExecutable(
    path.join(mockBin, "curl"),
    `#!/bin/sh
set -eu
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      out="$1"
      ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
[ -n "$out" ] || exit 2
case "$url" in
  *releases/latest)
    {
      printf '%s\n' '{"assets":['
      printf '%s\n' '{"browser_download_url":'
      printf '%s\n' '"https://downloads.example/Junban_1.0.5_amd64.deb"},'
      printf '%s\n' '{"browser_download_url":'
      printf '%s\n' '"https://downloads.example/Junban_1.0.5_amd64.AppImage"}'
      printf '%s\n' ']}'
    } >"$out"
    ;;
  *.deb)
    if [ "\${JUNBAN_TEST_EMPTY_ASSET:-}" = "deb" ]; then
      : >"$out"
    else
      printf 'deb asset\n' >"$out"
    fi
    ;;
  *.AppImage)
    if [ "\${JUNBAN_TEST_EMPTY_ASSET:-}" = "appimage" ]; then
      : >"$out"
    else
      printf 'appimage asset\n' >"$out"
    fi
    ;;
  *)
    printf 'unexpected url: %s\n' "$url" >&2
    exit 3
    ;;
esac
`,
  );

  if (includeAptGet) {
    writeExecutable(
      path.join(mockBin, "apt-get"),
      `#!/bin/sh
printf '%s\n' "$*" >"\${JUNBAN_TEST_LOG_DIR}/apt-get.args"
`,
    );
  }

  if (includeSudo) {
    writeExecutable(
      path.join(mockBin, "sudo"),
      `#!/bin/sh
printf '%s\n' "$*" >"\${JUNBAN_TEST_LOG_DIR}/sudo.args"
`,
    );
  }
}

function runInstaller({
  args = [],
  env: envOverrides = {},
  home,
  includeAptGet = false,
  includeSudo = false,
  isRoot = true,
  seedStaleLaunchers = false,
}: RunOptions = {}) {
  const tempDir = createTempDir();
  const mockBin = path.join(tempDir, "bin");
  const logDir = path.join(tempDir, "logs");
  const homeDir = home === undefined ? path.join(tempDir, "home") : home;
  fs.mkdirSync(logDir, { recursive: true });
  if (homeDir) {
    fs.mkdirSync(homeDir, { recursive: true });
    if (seedStaleLaunchers) {
      const applicationsDir = path.join(homeDir, ".local", "share", "applications");
      fs.mkdirSync(applicationsDir, { recursive: true });
      fs.writeFileSync(path.join(applicationsDir, "junban.desktop"), "stale lowercase launcher\n");
      fs.writeFileSync(path.join(applicationsDir, "Junban.desktop"), "stale appimage launcher\n");
    }
  }
  createMockBin(mockBin, { includeAptGet, includeSudo, isRoot });

  const env = { ...process.env };
  for (const key of [
    "JUNBAN_INSTALL_DIR",
    "JUNBAN_INSTALL_KIND",
    "JUNBAN_OS_RELEASE_FILE",
    "JUNBAN_RELEASE_API",
    "JUNBAN_REPO",
    "XDG_DATA_HOME",
  ]) {
    delete env[key];
  }
  env.JUNBAN_RELEASE_API = "https://api.github.com/repos/Artificial-Source/Junban/releases/latest";
  env.JUNBAN_OS_RELEASE_FILE = path.join(tempDir, "missing-os-release");
  env.JUNBAN_TEST_LOG_DIR = logDir;
  env.PATH = mockBin;
  if (homeDir === null) {
    delete env.HOME;
  } else {
    env.HOME = homeDir;
  }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const result = spawnSync("/bin/sh", [scriptPath, ...args], {
    encoding: "utf8",
    env,
  });

  return { homeDir, logDir, result };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Linux installer", () => {
  it("installs the .deb path without requiring HOME", () => {
    const { logDir, result } = runInstaller({ args: ["--deb"], home: null, includeAptGet: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Downloading Junban .deb");
    expect(result.stdout).toContain("Installing Junban with apt-get");
    expect(fs.readFileSync(path.join(logDir, "apt-get.args"), "utf8").trim()).toMatch(
      /^install -y .*junban-latest-amd64\.deb$/,
    );
  });

  it("uses the .deb path in auto mode on Debian-like systems", () => {
    const osReleaseDir = createTempDir();
    const osReleaseFile = path.join(osReleaseDir, "os-release");
    fs.writeFileSync(osReleaseFile, 'PRETTY_NAME="Ubuntu 24.04 LTS"\nID=ubuntu\nID_LIKE=debian\n');

    const { homeDir, logDir, result } = runInstaller({
      args: ["--auto"],
      env: { JUNBAN_OS_RELEASE_FILE: osReleaseFile },
      includeAptGet: true,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Detected Linux distro: Ubuntu 24.04 LTS (ubuntu)");
    expect(result.stdout).toContain("Detected distro family: debian");
    expect(result.stdout).toContain(
      "Selected .deb install because this looks like Debian/Ubuntu and apt-get is available",
    );
    expect(result.stdout).toContain("Downloading Junban .deb");
    expect(fs.readFileSync(path.join(logDir, "apt-get.args"), "utf8").trim()).toMatch(
      /^install -y .*junban-latest-amd64\.deb$/,
    );
    expect(
      fs.readFileSync(
        path.join(homeDir!, ".local", "share", "applications", "Junban.desktop"),
        "utf8",
      ),
    ).toContain('Exec="asf-junban"');
    expect(
      fs.existsSync(path.join(homeDir!, ".local", "share", "applications", "junban.desktop")),
    ).toBe(false);
    expect(fs.existsSync(path.join(homeDir!, "Applications", "Junban.AppImage"))).toBe(false);
  });

  it("fails forced .deb installs when apt-get is unavailable", () => {
    const { result } = runInstaller({ args: ["--deb"] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(".deb installation requires apt-get");
  });

  it("explains that --choose requires an interactive terminal", () => {
    const { result } = runInstaller({ args: ["--choose"] });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Choose what to install");
    expect(result.stdout).toContain("Recommended: AppImage");
    expect(result.stderr).toContain(
      "cannot ask for install choice without an interactive terminal",
    );
  });

  it("explains sudo and the AppImage alternative before non-root .deb installs", () => {
    const { result } = runInstaller({
      args: ["--deb"],
      includeAptGet: true,
      includeSudo: true,
      isRoot: false,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(".deb installation requires administrator privileges");
    expect(result.stdout).toContain("No-sudo alternative");
    expect(result.stderr).toContain(
      "cannot ask for sudo confirmation without an interactive terminal",
    );
  });

  it("installs the AppImage and desktop entry when apt-get is unavailable", () => {
    const { homeDir, result } = runInstaller({ args: ["--auto"], seedStaleLaunchers: true });
    expect(homeDir).toBeTruthy();

    const appimagePath = path.join(homeDir!, "Applications", "Junban.AppImage");
    const applicationsDir = path.join(homeDir!, ".local", "share", "applications");
    const desktopPath = path.join(applicationsDir, "Junban.desktop");
    const legacyHiddenPath = path.join(applicationsDir, "ASF Junban.desktop");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Detected Linux distro: Linux (unknown)");
    expect(result.stdout).toContain(
      "Selected AppImage install because this distro is not Debian/Ubuntu-like",
    );
    expect(result.stdout).toContain("Downloading Junban AppImage");
    expect(fs.readFileSync(appimagePath, "utf8")).toBe("appimage asset\n");
    expect(fs.statSync(appimagePath).mode & 0o111).toBeGreaterThan(0);
    expect(fs.readFileSync(desktopPath, "utf8")).toContain(`Exec="${appimagePath}"`);
    expect(fs.readFileSync(desktopPath, "utf8")).toContain("Icon=asf-junban");
    expect(fs.existsSync(path.join(applicationsDir, "junban.desktop"))).toBe(false);
    expect(fs.readFileSync(legacyHiddenPath, "utf8")).toContain("Hidden=true");
  });

  it("rejects empty downloaded AppImage assets", () => {
    const { result } = runInstaller({
      args: ["--appimage"],
      env: { JUNBAN_TEST_EMPTY_ASSET: "appimage" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("downloaded AppImage asset is empty");
  });

  it("respects AppImage install directory override and escapes the desktop Exec path", () => {
    const installDir = path.join(createTempDir(), 'Applications "quoted"');
    const { homeDir, result } = runInstaller({
      args: ["--appimage"],
      env: { JUNBAN_INSTALL_DIR: installDir },
    });
    expect(homeDir).toBeTruthy();

    const appimagePath = path.join(installDir, "Junban.AppImage");
    const desktopPath = path.join(homeDir!, ".local", "share", "applications", "Junban.desktop");
    const escapedAppimagePath = appimagePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(appimagePath, "utf8")).toBe("appimage asset\n");
    expect(fs.readFileSync(desktopPath, "utf8")).toContain(`Exec="${escapedAppimagePath}"`);
  });
});
