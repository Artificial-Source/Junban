/**
 * Quick Add template variable collection (ISSUE-002).
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateDto } from "../api/client";
import { QuickAddModal } from "./QuickAddModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const parseQuickEntry = vi.fn();
const createFromQuickEntry = vi.fn();
const applyTemplate = vi.fn();
const onClose = vi.fn();

const plainTemplate: TemplateDto = {
  id: "tpl-plain",
  name: "Standup",
  title: "Daily standup notes",
  description: "",
  priority: null,
  tag_names: [],
  sort_order: 0,
  created_at: "2026-07-23T10:00:00Z",
  updated_at: "2026-07-23T10:00:00Z",
};

const variableTemplate: TemplateDto = {
  id: "tpl-vars",
  name: "Prep",
  title: "Prepare {{thing}} for {{person}}",
  description: "Also {{thing}}",
  priority: 2,
  tag_names: [],
  sort_order: 1,
  created_at: "2026-07-23T10:00:00Z",
  updated_at: "2026-07-23T10:00:00Z",
};

vi.mock("../hooks/useTaskMutations", () => ({
  useTaskMutations: () => ({
    parseQuickEntry: (...args: unknown[]) => parseQuickEntry(...args),
    createFromQuickEntry: (...args: unknown[]) => createFromQuickEntry(...args),
    applyTemplate: (...args: unknown[]) => applyTemplate(...args),
  }),
}));

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    catalog: {
      templates: [plainTemplate, variableTemplate],
      projects: [],
      sections: [],
      tags: [],
      saved_filters: [],
      revision: 1,
    },
  }),
}));

vi.mock("../hooks/useFocusTrap", () => ({
  useFocusTrap: () => {},
}));

function setInputValue(el: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

function render(ui: ReactElement) {
  act(() => {
    root.render(ui);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  parseQuickEntry.mockReset();
  createFromQuickEntry.mockReset();
  applyTemplate.mockReset().mockResolvedValue({ event: { revision: 2 } });
  onClose.mockReset();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("QuickAddModal template variables", () => {
  it("applies variable-free templates immediately", async () => {
    render(createElement(QuickAddModal, { open: true, onClose }));

    const templatesToggle = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Templates",
    ) as HTMLButtonElement;
    await act(async () => {
      templatesToggle.click();
    });

    const plain = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Standup"),
    ) as HTMLButtonElement;
    await act(async () => {
      plain.click();
      await Promise.resolve();
    });

    expect(applyTemplate).toHaveBeenCalledWith("tpl-plain", []);
    expect(onClose).toHaveBeenCalled();
    expect(container.querySelector("input[name='thing']")).toBeNull();
  });

  it("collects unique required variables before apply", async () => {
    render(createElement(QuickAddModal, { open: true, onClose }));

    const templatesToggle = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Templates",
    ) as HTMLButtonElement;
    await act(async () => {
      templatesToggle.click();
    });

    const prep = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Prep"),
    ) as HTMLButtonElement;
    await act(async () => {
      prep.click();
    });

    expect(applyTemplate).not.toHaveBeenCalled();
    const thing = container.querySelector("input[name='thing']") as HTMLInputElement;
    const person = container.querySelector("input[name='person']") as HTMLInputElement;
    expect(thing).toBeTruthy();
    expect(person).toBeTruthy();
    // Repeated {{thing}} only yields one field.
    expect(container.querySelectorAll("input[name='thing']")).toHaveLength(1);

    const createBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Create task",
    ) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);

    await act(async () => {
      setInputValue(thing, "demo");
      setInputValue(person, "Alex");
    });
    expect(createBtn.disabled).toBe(false);

    await act(async () => {
      createBtn.click();
      await Promise.resolve();
    });

    expect(applyTemplate).toHaveBeenCalledWith("tpl-vars", [
      { name: "thing", value: "demo" },
      { name: "person", value: "Alex" },
    ]);
    expect(onClose).toHaveBeenCalled();
  });
});
