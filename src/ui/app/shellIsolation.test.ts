/**
 * P2-CLOSE-001 / P2-CLOSE-002: shell isolation tracks real overlays and excludes toasts.
 */
import { describe, expect, it } from "vitest";
import { isShellBlocking, isTaskDetailLayerActive, isolateShellSiblings } from "./shellIsolation";

describe("isTaskDetailLayerActive (P2-CLOSE-001)", () => {
  it("is inactive when nothing is selected", () => {
    expect(isTaskDetailLayerActive(null, null, false)).toBe(false);
    expect(isTaskDetailLayerActive(null, { id: "t1" }, true)).toBe(false);
  });

  it("is active while the matching detail panel is open", () => {
    expect(isTaskDetailLayerActive("t1", { id: "t1" }, false)).toBe(true);
  });

  it("is active while the loading cover is shown for the selection", () => {
    expect(isTaskDetailLayerActive("t1", null, true)).toBe(true);
    expect(isTaskDetailLayerActive("t1", { id: "other" }, true)).toBe(true);
  });

  it("is inactive after a rejected/empty detail load (selection alone must not lock)", () => {
    // selectedTaskId set, detail null, loading finished — no overlay rendered.
    expect(isTaskDetailLayerActive("t1", null, false)).toBe(false);
    expect(
      isShellBlocking({
        drawerOpen: false,
        quickAddOpen: false,
        searchOpen: false,
        paletteOpen: false,
        projectModalOpen: false,
        taskDetailActive: isTaskDetailLayerActive("t1", null, false),
      }),
    ).toBe(false);
  });
});

describe("isolateShellSiblings (P2-CLOSE-001 / P2-CLOSE-002)", () => {
  it("does not lock the shell when detail layer is inactive after a failed load", () => {
    const root = document.createElement("div");
    const main = document.createElement("main");
    main.textContent = "shell";
    const overlay = document.createElement("div");
    overlay.setAttribute("data-app-overlay", "");
    root.append(main, overlay);
    document.body.append(root);

    const taskDetailActive = isTaskDetailLayerActive("missing-task", null, false);
    expect(taskDetailActive).toBe(false);

    // AppLayout only isolates while blocking; a failed load must skip isolation.
    if (
      isShellBlocking({
        drawerOpen: false,
        quickAddOpen: false,
        searchOpen: false,
        paletteOpen: false,
        projectModalOpen: false,
        taskDetailActive,
      })
    ) {
      isolateShellSiblings(root);
    }

    // jsdom may report unset inert as undefined rather than false.
    expect(main.inert).toBeFalsy();
    expect(main.hasAttribute("aria-hidden")).toBe(false);
    root.remove();
  });

  it("keeps the toast live region operable while a detail overlay blocks the shell", () => {
    const root = document.createElement("div");
    const main = document.createElement("main");
    const detail = document.createElement("div");
    detail.setAttribute("data-app-overlay", "");
    detail.setAttribute("data-testid", "detail");
    const toasts = document.createElement("div");
    toasts.setAttribute("data-app-overlay", "");
    toasts.setAttribute("aria-live", "polite");
    const undo = document.createElement("button");
    undo.type = "button";
    undo.textContent = "Undo";
    toasts.append(undo);
    root.append(main, detail, toasts);
    document.body.append(root);

    const restore = isolateShellSiblings(root);

    expect(main.inert).toBe(true);
    expect(main.getAttribute("aria-hidden")).toBe("true");
    // Toast exclusion: not inert, not aria-hidden, Undo stays usable.
    expect(toasts.inert).toBeFalsy();
    expect(toasts.hasAttribute("aria-hidden")).toBe(false);
    expect(toasts.getAttribute("aria-live")).toBe("polite");
    expect(undo.disabled).toBe(false);
    expect(undo.closest("[inert]")).toBeNull();

    restore();
    expect(main.inert).toBeFalsy();
    root.remove();
  });
});
