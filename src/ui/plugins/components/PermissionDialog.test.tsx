/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginPermission } from "../types";
import { PermissionDialog } from "./PermissionDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PermissionDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("discloses exact scopes and returns the original canonical permission list", () => {
    const permissions: PluginPermission[] = [
      {
        capability: "events:subscribe",
        scope: { event_kinds: ["task-created", "task-updated"] },
      },
      {
        capability: "http",
        scope: {
          origins: ["https://api.example.com", "https://sync.example.com"],
          methods: ["GET", "POST"],
        },
      },
      {
        capability: "services:consume",
        scope: {
          services: [
            { plugin_id: "calendar", service_id: "events" },
            { plugin_id: "notes", service_id: "search" },
          ],
        },
      },
    ];
    const onApprove = vi.fn();

    act(() => {
      root.render(
        createElement(PermissionDialog, {
          pluginName: "Scoped Plugin",
          permissions,
          onApprove,
          onCancel: vi.fn(),
        }),
      );
    });

    expect(container.textContent).toContain("Event kinds: task-created, task-updated");
    expect(container.textContent).toContain(
      "HTTP origins: https://api.example.com, https://sync.example.com; methods: GET, POST",
    );
    expect(container.textContent).toContain("Services: calendar/events, notes/search");

    const approve = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Approve",
    );
    act(() => approve?.click());

    expect(onApprove).toHaveBeenCalledOnce();
    expect(onApprove.mock.calls[0]?.[0]).toBe(permissions);
  });

  it("keeps unscoped fixture rows visually concise", () => {
    act(() => {
      root.render(
        createElement(PermissionDialog, {
          pluginName: "Fixture Plugin",
          permissions: [{ capability: "tasks:read", scope: {} }],
          onApprove: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    expect(container.textContent).toContain("task:read");
    expect(container.textContent).not.toContain("Event kinds:");
    expect(container.textContent).not.toContain("Services:");
    expect(container.textContent).not.toContain("HTTP origins:");
  });
});
