import { describe, it, expect } from "vitest";
import { useMultiSelect } from "../hooks/useMultiSelect";
import { renderHook, act } from "../hooks/test-utils";

describe("useMultiSelect", () => {
  it("starts with empty selection", () => {
    const { result } = renderHook(() => useMultiSelect());
    expect(result.current.count).toBe(0);
    expect(result.current.selectedIds.size).toBe(0);
  });

  it("toggles selection with ctrl+click", () => {
    const { result } = renderHook(() => useMultiSelect());
    act(() => {
      result.current.handleSelect("task-1", { ctrlKey: true, metaKey: false, shiftKey: false });
    });
    expect(result.current.selectedIds.has("task-1")).toBe(true);
    act(() => {
      result.current.handleSelect("task-1", { ctrlKey: true, metaKey: false, shiftKey: false });
    });
    expect(result.current.selectedIds.has("task-1")).toBe(false);
  });

  it("replaces selection with plain click", () => {
    const { result } = renderHook(() => useMultiSelect());
    act(() => {
      result.current.handleSelect("task-1", { ctrlKey: true, metaKey: false, shiftKey: false });
    });
    act(() => {
      result.current.handleSelect("task-2", { ctrlKey: false, metaKey: false, shiftKey: false });
    });
    expect(result.current.selectedIds.has("task-1")).toBe(false);
    expect(result.current.selectedIds.has("task-2")).toBe(true);
  });

  it("clears all", () => {
    const { result } = renderHook(() => useMultiSelect());
    act(() => {
      result.current.handleSelect("task-1", { ctrlKey: false, metaKey: false, shiftKey: false });
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.count).toBe(0);
  });

  it("shift-click selects inclusive range over ordered ids (P2-FE-002)", () => {
    const { result } = renderHook(() => useMultiSelect());
    const ordered = ["a", "b", "c", "d"];
    act(() => {
      result.current.handleSelect(
        "b",
        { ctrlKey: false, metaKey: false, shiftKey: false },
        ordered,
      );
    });
    act(() => {
      result.current.handleSelect("d", { ctrlKey: false, metaKey: false, shiftKey: true }, ordered);
    });
    expect([...result.current.selectedIds].sort()).toEqual(["b", "c", "d"]);
  });
});
