import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(import.meta.dirname, "..", "..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8")) as T;
}

function expectIconFile(relativePath: string) {
  const absolutePath = path.join(rootDir, "src-tauri", relativePath);
  const bytes = fs.readFileSync(absolutePath);
  expect(bytes.length).toBeGreaterThan(0);

  if (relativePath.endsWith(".png")) {
    expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    return;
  }

  if (relativePath.endsWith(".ico")) {
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0, 0, 1, 0]);
    return;
  }

  if (relativePath.endsWith(".icns")) {
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("icns");
  }
}

describe("Tauri desktop configuration", () => {
  it("uses a frameless main window with the expected desktop sidecar hooks", () => {
    const config = readJson<{
      build: Record<string, string>;
      app: { windows: Array<Record<string, unknown>> };
      bundle: { externalBin: string[]; resources: string[]; icon: string[] };
    }>("src-tauri/tauri.conf.json");

    const mainWindow = config.app.windows.find((window) => window.label === "main");
    expect(mainWindow).toMatchObject({
      title: "Junban",
      decorations: false,
      shadow: true,
    });
    expect(config.build.beforeBuildCommand).toContain("pnpm tauri:validate-sidecar");
    expect(config.bundle.externalBin).toContain("binaries/junban-node");
    expect(config.bundle.resources).toContain("./gen/sidecar/");
    for (const iconPath of config.bundle.icon) {
      expectIconFile(iconPath);
    }
  });

  it("grants the main window permissions needed by the custom titlebar", () => {
    const capability = readJson<{ windows: string[]; permissions: Array<string | object> }>(
      "src-tauri/capabilities/default.json",
    );
    const permissions = capability.permissions.filter(
      (permission): permission is string => typeof permission === "string",
    );

    expect(capability.windows).toContain("main");
    expect(permissions).toEqual(
      expect.arrayContaining([
        "core:window:allow-minimize",
        "core:window:allow-maximize",
        "core:window:allow-unmaximize",
        "core:window:allow-close",
        "core:window:allow-is-maximized",
        "core:window:allow-start-dragging",
      ]),
    );
  });
});
