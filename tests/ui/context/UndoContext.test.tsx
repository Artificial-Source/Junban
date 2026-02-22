import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { UndoProvider, useUndoContext } from "../../../src/ui/context/UndoContext.js";

function TestConsumer() {
  const { undoManager, undo, redo, canUndo, canRedo, toast, dismissToast, showToast } =
    useUndoContext();
  return (
    <div>
      <span data-testid="can-undo">{String(canUndo)}</span>
      <span data-testid="can-redo">{String(canRedo)}</span>
      <span data-testid="toast">{toast ? JSON.stringify(toast) : "null"}</span>
      <span data-testid="toast-message">{toast?.message ?? "none"}</span>
      <span data-testid="toast-action-label">{toast?.actionLabel ?? "none"}</span>
      <button data-testid="undo" onClick={() => undo()}>
        Undo
      </button>
      <button data-testid="redo" onClick={() => redo()}>
        Redo
      </button>
      <button data-testid="dismiss" onClick={() => dismissToast()}>
        Dismiss
      </button>
      <button
        data-testid="show-toast"
        onClick={() => showToast("Custom message", { label: "Do it", onClick: () => {} })}
      >
        Show Toast
      </button>
      <button
        data-testid="perform"
        onClick={async () => {
          await undoManager.perform({
            description: "Delete task",
            execute: vi.fn().mockResolvedValue(undefined),
            undo: vi.fn().mockResolvedValue(undefined),
          });
        }}
      >
        Perform
      </button>
      <button
        data-testid="perform-action-a"
        onClick={async () => {
          await undoManager.perform({
            description: "Create task A",
            execute: vi.fn().mockResolvedValue(undefined),
            undo: vi.fn().mockResolvedValue(undefined),
          });
        }}
      >
        Perform A
      </button>
      <button
        data-testid="perform-action-b"
        onClick={async () => {
          await undoManager.perform({
            description: "Create task B",
            execute: vi.fn().mockResolvedValue(undefined),
            undo: vi.fn().mockResolvedValue(undefined),
          });
        }}
      >
        Perform B
      </button>
    </div>
  );
}

describe("UndoContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when used outside provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      "useUndoContext must be used within UndoProvider",
    );
    spy.mockRestore();
  });

  it("provides initial state with canUndo and canRedo as false", () => {
    render(
      <UndoProvider>
        <TestConsumer />
      </UndoProvider>,
    );

    expect(screen.getByTestId("can-undo").textContent).toBe("false");
    expect(screen.getByTestId("can-redo").textContent).toBe("false");
    expect(screen.getByTestId("toast").textContent).toBe("null");
  });

  it("canUndo becomes true after performing an action", async () => {
    render(
      <UndoProvider>
        <TestConsumer />
      </UndoProvider>,
    );

    expect(screen.getByTestId("can-undo").textContent).toBe("false");

    await act(async () => {
      screen.getByTestId("perform").click();
    });

    expect(screen.getByTestId("can-undo").textContent).toBe("true");
    expect(screen.getByTestId("can-redo").textContent).toBe("false");
  });

  it("undo executes action.undo and shows toast with description", async () => {
    render(
      <UndoProvider>
        <TestConsumer />
      </UndoProvider>,
    );

    // Perform an action first
    await act(async () => {
      screen.getByTestId("perform").click();
    });

    expect(screen.getByTestId("can-undo").textContent).toBe("true");

    // Undo it
    await act(async () => {
      screen.getByTestId("undo").click();
    });

    expect(screen.getByTestId("can-undo").textContent).toBe("false");
    expect(screen.getByTestId("can-redo").textContent).toBe("true");

    // Toast should show "Undone: Delete task"
    expect(screen.getByTestId("toast-message").textContent).toBe("Undone: Delete task");
    expect(screen.getByTestId("toast-action-label").textContent).toBe("Redo");
  });

  it("redo executes action.execute and shows toast with description", async () => {
    render(
      <UndoProvider>
        <TestConsumer />
      </UndoProvider>,
    );

    // Perform an action
    await act(async () => {
      screen.getByTestId("perform").click();
    });

    // Undo it
    await act(async () => {
      screen.getByTestId("undo").click();
    });

    expect(screen.getByTestId("can-redo").textContent).toBe("true");

    // Redo it
    await act(async () => {
      screen.getByTestId("redo").click();
    });

    expect(screen.getByTestId("can-redo").textContent).toBe("false");
    expect(screen.getByTestId("can-undo").textContent).toBe("true");

    // Toast should show "Redone: Delete task"
    expect(screen.getByTestId("toast-message").textContent).toBe("Redone: Delete task");
  });

  it("undo does nothing when stack is empty", async () => {
    render(
      <UndoProvider>
        <TestConsumer />
      </UndoProvider>,
    );

    // Try to undo with nothing in the stack
    await act(async () => {
      screen.getByTestId("undo").click();
    });

    // Toast should remain null (no action to undo)
    expect(screen.getByTestId("toast").textContent).toBe("null");
    expect(screen.getByTestId("can-undo").textContent).toBe("false");
  });

  it("redo does nothing when redo stack is empty", async () => {
    render(
      <UndoProvider>
        <TestConsumer />
      </UndoProvider>,
    );

    // Try to redo with nothing in the stack
    await act(async () => {
      screen.getByTestId("redo").click();
    });

    expect(screen.getByTestId("toast").textContent).toBe("null");
    expect(screen.getByTestId("can-redo").textContent).toBe("false");
  });

  it("dismissToast clears the toast", async () => {
    render(
      <UndoProvider>
        <TestConsumer />
      </UndoProvider>,
    );

    // Perform and undo to create a toast
    await act(async () => {
      screen.getByTestId("perform").click();
    });

    await act(async () => {
      screen.getByTestId("undo").click();
    });

    expect(screen.getByTestId("toast-message").textContent).not.toBe("none");

    // Dismiss the toast
    act(() => {
      screen.getByTestId("dismiss").click();
    });

    expect(screen.getByTestId("toast").textContent).toBe("null");
  });

  it("showToast displays a custom toast message with action", () => {
    render(
      <UndoProvider>
        <TestConsumer />
      </UndoProvider>,
    );

    act(() => {
      screen.getByTestId("show-toast").click();
    });

    expect(screen.getByTestId("toast-message").textContent).toBe("Custom message");
    expect(screen.getByTestId("toast-action-label").textContent).toBe("Do it");
  });

  it("multiple actions build up undo stack", async () => {
    render(
      <UndoProvider>
        <TestConsumer />
      </UndoProvider>,
    );

    // Perform two actions
    await act(async () => {
      screen.getByTestId("perform-action-a").click();
    });

    await act(async () => {
      screen.getByTestId("perform-action-b").click();
    });

    expect(screen.getByTestId("can-undo").textContent).toBe("true");

    // Undo the most recent (B)
    await act(async () => {
      screen.getByTestId("undo").click();
    });

    expect(screen.getByTestId("toast-message").textContent).toBe("Undone: Create task B");
    expect(screen.getByTestId("can-undo").textContent).toBe("true"); // A still in stack

    // Undo A
    await act(async () => {
      screen.getByTestId("undo").click();
    });

    expect(screen.getByTestId("toast-message").textContent).toBe("Undone: Create task A");
    expect(screen.getByTestId("can-undo").textContent).toBe("false"); // stack empty
    expect(screen.getByTestId("can-redo").textContent).toBe("true"); // both in redo stack
  });

  it("performing a new action clears the redo stack", async () => {
    render(
      <UndoProvider>
        <TestConsumer />
      </UndoProvider>,
    );

    // Perform A, undo it, then perform B
    await act(async () => {
      screen.getByTestId("perform-action-a").click();
    });

    await act(async () => {
      screen.getByTestId("undo").click();
    });

    expect(screen.getByTestId("can-redo").textContent).toBe("true");

    // Performing a new action should clear redo stack
    await act(async () => {
      screen.getByTestId("perform-action-b").click();
    });

    expect(screen.getByTestId("can-redo").textContent).toBe("false");
    expect(screen.getByTestId("can-undo").textContent).toBe("true");
  });
});
