/**
 * Restore cutover must call enterRestartRequired only after an authoritative
 * restart_required response — not before preflight and not on failure.
 *
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { DataTab } from "./DataTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const enterRestartRequired = vi.fn();
const showToast = vi.fn();
const refreshCatalog = vi.fn();
const runMutation = vi.fn();
const restoreBackup = vi.fn();

vi.mock("../../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    runMutation,
    showToast,
    refreshCatalog,
    enterRestartRequired,
  }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    restoreBackup: (body: Blob) => restoreBackup(body),
    previewImport: vi.fn(),
    applyImport: vi.fn(),
    exportTasks: vi.fn(),
    createBackup: vi.fn(),
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  enterRestartRequired.mockReset();
  showToast.mockReset();
  refreshCatalog.mockReset();
  runMutation.mockReset();
  restoreBackup.mockReset();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mount() {
  act(() => {
    root.render(createElement(DataTab));
  });
}

async function stageAndConfirmRestore(fileName = "profile.junban-backup") {
  const input = container.querySelector(
    'input[aria-label="Backup file to restore"]',
  ) as HTMLInputElement | null;
  expect(input).not.toBeNull();

  const file = new File([new Uint8Array([1, 2, 3])], fileName, {
    type: "application/octet-stream",
  });
  await act(async () => {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    input!.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const confirm = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Restore backup",
  );
  expect(confirm).toBeTruthy();
  await act(async () => {
    confirm!.click();
    await Promise.resolve();
  });
}

describe("DataTab restore restart-required", () => {
  it("calls enterRestartRequired after successful restore with restart_required", async () => {
    restoreBackup.mockResolvedValue({ restart_required: true });
    mount();

    expect(enterRestartRequired).not.toHaveBeenCalled();
    await stageAndConfirmRestore();

    expect(restoreBackup).toHaveBeenCalledTimes(1);
    expect(enterRestartRequired).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Restart required");
    expect(showToast).toHaveBeenCalledWith("info", "Restart required after restore");
  });

  it("does not call enterRestartRequired when restore fails", async () => {
    restoreBackup.mockRejectedValue(
      new ApiError("Restore rejected", {
        status: 400,
        code: "bad_backup",
        retryable: false,
        requestId: "req-restore-fail",
      }),
    );
    mount();

    await stageAndConfirmRestore();

    expect(restoreBackup).toHaveBeenCalledTimes(1);
    expect(enterRestartRequired).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Restore rejected");
    expect(container.textContent).not.toContain("Restart required. Stop and start");
  });

  it("does not suppress SSE before the restore response arrives", async () => {
    let resolveRestore: ((value: { restart_required: boolean }) => void) | undefined;
    restoreBackup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRestore = resolve;
        }),
    );
    mount();

    const input = container.querySelector(
      'input[aria-label="Backup file to restore"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([9])], "profile.junban-backup");
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const confirm = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Restore backup",
    );
    expect(confirm).toBeTruthy();

    // Kick off restore without awaiting completion.
    act(() => {
      confirm!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(restoreBackup).toHaveBeenCalledTimes(1);
    expect(enterRestartRequired).not.toHaveBeenCalled();

    await act(async () => {
      resolveRestore?.({ restart_required: true });
      await Promise.resolve();
    });

    expect(enterRestartRequired).toHaveBeenCalledTimes(1);
  });
});
