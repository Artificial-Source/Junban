/**
 * @vitest-environment node
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, PLUGIN_EVENT_TYPES } from "../../src/ui/api/events";

describe("committed event authority", () => {
  it("keeps frontend plugin events synchronized with the Rust event authority", () => {
    const rust = readFileSync(join(process.cwd(), "crates/junban-app/src/event.rs"), "utf8");
    const emitted = Array.from(
      rust.matchAll(/pub const PLUGIN_[A-Z_]+: &'static str = "(plugin\.[a-z_]+)";/g),
      (match) => match[1]!,
    ).sort();
    const frontend = [...PLUGIN_EVENT_TYPES].sort();

    expect(emitted.length).toBeGreaterThan(0);
    expect(frontend).toEqual(emitted);
    expect(
      [...KNOWN_EVENT_TYPES].filter((eventType) => eventType.startsWith("plugin.")).sort(),
    ).toEqual(emitted);
  });
});
