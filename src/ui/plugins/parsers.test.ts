/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  isStaleAuthorityError,
  parseContribution,
  parseInstalledPlugin,
  parsePluginSurface,
  parseSettingDeclarations,
} from "./parsers";
import { UI_DEPTH_MAX, UI_NODE_MAX } from "./types";

describe("plugin parsers", () => {
  it("parses installed plugins and marks bundled ids as builtin", () => {
    const plugin = parseInstalledPlugin({
      plugin_id: "pomodoro",
      name: "Pomodoro Timer",
      description: "Timer",
      version: "1.0.0",
      package_sha256: "a".repeat(64),
      publisher_key_id: "pub",
      package_generation: 2,
      activation_epoch: 3,
      desired_enabled: true,
      runtime_state: "active",
      requested_permissions: [{ capability: "tasks:read", scope: {} }],
      granted_permissions: [{ capability: "tasks:read", scope: {} }],
      dependencies: [],
      dependencies_satisfied: true,
      settings: [
        {
          id: "mode",
          label: "Mode",
          description: "Timer mode",
          schema: {
            type: "select",
            default: "focus",
            options: [{ id: "focus", label: "Focus" }],
          },
        },
      ],
      failure_count: 0,
      last_error_code: null,
      next_retry_at: null,
      installed_at: "2026-08-04T15:00:00.000Z",
      updated_at: "2026-08-04T15:00:00.000Z",
    });
    expect(plugin.builtin).toBe(true);
    expect(plugin.packageGeneration).toBe(2);
    expect(plugin.settingDeclarations[0]).toEqual({
      id: "mode",
      label: "Mode",
      description: "Timer mode",
      schema: {
        type: "select",
        default: "focus",
        options: [{ id: "focus", label: "Focus" }],
      },
    });
  });

  it("rejects unknown capabilities fail-closed", () => {
    expect(() =>
      parseInstalledPlugin({
        plugin_id: "x",
        name: "X",
        description: "d",
        version: "1",
        package_sha256: "a".repeat(64),
        publisher_key_id: "p",
        package_generation: 1,
        activation_epoch: 1,
        desired_enabled: false,
        runtime_state: "disabled",
        requested_permissions: [{ capability: "root:all", scope: {} }],
        granted_permissions: [],
        dependencies: [],
        dependencies_satisfied: true,
        settings: [],
        failure_count: 0,
        installed_at: "t",
        updated_at: "t",
      }),
    ).toThrow(/capability/);
  });

  it("rejects contributions that shadow first-party commands/routes", () => {
    expect(() =>
      parseContribution({
        contribution_id: "p:quick-add",
        plugin_id: "p",
        local_id: "quick-add",
        kind: "command",
        title: "Bad",
        description: null,
        location: null,
        actions: [],
        package_generation: 1,
        activation_epoch: 1,
        host_session_id: "sess",
      }),
    ).toThrow(/shadow/);

    expect(() =>
      parseContribution({
        contribution_id: "p:calendar",
        plugin_id: "p",
        local_id: "calendar",
        kind: "view",
        title: "Bad",
        description: null,
        location: "tools",
        actions: [],
        package_generation: 1,
        activation_epoch: 1,
        host_session_id: "sess",
      }),
    ).toThrow(/shadow/);
  });

  it("parses WIT surface and enforces bounds", () => {
    const surface = parsePluginSurface({
      "surface-id": "main",
      "root-index": 0,
      nodes: [
        {
          id: "root",
          "parent-index": null,
          content: { tag: "stack", val: { gap: 2, align: "center" } },
        },
        {
          id: "label",
          "parent-index": 0,
          content: { tag: "text", val: { text: "Hello", tone: "neutral", size: "medium" } },
        },
        {
          id: "go",
          "parent-index": 0,
          content: {
            tag: "button",
            val: { label: "Go", "action-id": "run", tone: "accent", icon: null },
          },
        },
      ],
    });
    expect(surface.nodes).toHaveLength(3);
    expect(surface.nodes[1]?.content.tag).toBe("text");
  });

  it("rejects surfaces exceeding node bound", () => {
    const nodes: unknown[] = [
      {
        id: "root",
        "parent-index": null,
        content: { tag: "stack", val: { gap: 0, align: "start" } },
      },
    ];
    for (let i = 1; i <= UI_NODE_MAX; i += 1) {
      nodes.push({
        id: `n${i}`,
        "parent-index": 0,
        content: { tag: "text", val: { text: "x", tone: "neutral", size: "small" } },
      });
    }
    expect(() => parsePluginSurface({ "surface-id": "x", "root-index": 0, nodes })).toThrow(
      /node count/,
    );
  });

  it("rejects deep parent chains beyond depth bound", () => {
    const nodes: unknown[] = [
      {
        id: "root",
        "parent-index": null,
        content: { tag: "stack", val: { gap: 0, align: "start" } },
      },
    ];
    for (let i = 1; i <= UI_DEPTH_MAX + 1; i += 1) {
      nodes.push({
        id: `d${i}`,
        "parent-index": i - 1,
        content: { tag: "stack", val: { gap: 0, align: "start" } },
      });
    }
    expect(() => parsePluginSurface({ "surface-id": "x", "root-index": 0, nodes })).toThrow(
      /depth/,
    );
  });

  it("rejects HTML-like control characters in text", () => {
    expect(() =>
      parsePluginSurface({
        "surface-id": "x",
        "root-index": 0,
        nodes: [
          {
            id: "root",
            "parent-index": null,
            content: {
              tag: "text",
              val: { text: "bad\u0000text", tone: "neutral", size: "small" },
            },
          },
        ],
      }),
    ).toThrow(/control/);
  });

  it("parses setting declarations fail-closed on missing or unknown schemas", () => {
    expect(() => parseSettingDeclarations(undefined)).toThrow(/declarations/);
    const decls = parseSettingDeclarations([
      {
        id: "workMinutes",
        label: "Work Duration",
        description: "",
        schema: { type: "integer", default: 25, min: 1, max: 120, step: 1 },
      },
    ]);
    expect(decls[0]?.schema.type).toBe("integer");
    expect(
      parseSettingDeclarations([
        {
          id: "token",
          label: "Token",
          description: "",
          schema: { type: "text", min_bytes: 0, max_bytes: 128, secret: true },
        },
      ])[0]?.schema,
    ).toEqual({ type: "text", default: null, minBytes: 0, maxBytes: 128, secret: true });
    expect(() =>
      parseSettingDeclarations([
        {
          id: "token",
          label: "Token",
          description: "",
          schema: {
            type: "text",
            default: "must-not-cross-output-contract",
            min_bytes: 0,
            max_bytes: 128,
            secret: true,
          },
        },
      ]),
    ).toThrow(/default/);
    expect(() =>
      parseSettingDeclarations([
        {
          id: "x",
          label: "X",
          description: "",
          schema: { type: "css", default: "color:red" },
        },
      ]),
    ).toThrow(/schema/);
  });

  it("detects stale authority errors", () => {
    expect(isStaleAuthorityError({ status: 409 })).toBe(true);
    expect(isStaleAuthorityError({ status: 400, code: "plugin_authority_invalid" })).toBe(true);
    expect(isStaleAuthorityError({ status: 500 })).toBe(false);
  });
});
