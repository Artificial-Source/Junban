/**
 * P2-FE-007: template create/edit/delete through catalog mutations.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TagDto, TemplateDto } from "../api/client";
import { TemplatesSection } from "./TemplatesSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createTemplate = vi.fn();
const patchTemplate = vi.fn();
const deleteTemplate = vi.fn();

vi.mock("../hooks/useCatalogMutations", () => ({
  useCatalogMutations: () => ({
    createTemplate: (...args: unknown[]) => createTemplate(...args),
    patchTemplate: (...args: unknown[]) => patchTemplate(...args),
    deleteTemplate: (...args: unknown[]) => deleteTemplate(...args),
  }),
}));

function makeTemplate(overrides: Partial<TemplateDto> = {}): TemplateDto {
  return {
    id: "tpl-1",
    name: "Bug Report",
    title: "Fix: {{issue}}",
    description: "Steps: {{steps}}",
    priority: 1,
    tag_names: ["bug"],
    sort_order: 0,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
    ...overrides,
  };
}

const tags: TagDto[] = [
  {
    id: "tag-1",
    name: "bug",
    color: "#ff0000",
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
  },
  {
    id: "tag-2",
    name: "frontend",
    color: "#00ff00",
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
  },
];

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
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
  createTemplate.mockReset().mockResolvedValue({ event: { revision: 2 } });
  patchTemplate.mockReset().mockResolvedValue({ event: { revision: 3 } });
  deleteTemplate.mockReset().mockResolvedValue({ event: { revision: 4 } });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("TemplatesSection (P2-FE-007)", () => {
  it("creates a template with name/title/description/priority/tags", async () => {
    render(createElement(TemplatesSection, { templates: [], tags }));

    const newBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("New Template"),
    ) as HTMLButtonElement;
    await act(async () => {
      newBtn.click();
    });

    await act(async () => {
      setInputValue(container.querySelector("#template-name") as HTMLInputElement, "Spike");
      setInputValue(
        container.querySelector("#template-title") as HTMLInputElement,
        "Investigate {{topic}}",
      );
      setInputValue(
        container.querySelector("#template-description") as HTMLTextAreaElement,
        "Notes",
      );
      const priority = container.querySelector("#template-priority") as HTMLSelectElement;
      priority.value = "2";
      priority.dispatchEvent(new Event("change", { bubbles: true }));
      const tagSelect = container.querySelector(
        'select[aria-label="Add template tag"]',
      ) as HTMLSelectElement;
      tagSelect.value = "frontend";
      tagSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const submit = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Create",
    ) as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });

    expect(createTemplate).toHaveBeenCalledWith({
      name: "Spike",
      title: "Investigate {{topic}}",
      description: "Notes",
      priority: 2,
      tag_names: ["frontend"],
    });
  });

  it("edits an existing template", async () => {
    render(createElement(TemplatesSection, { templates: [makeTemplate()], tags }));

    const edit = container.querySelector(
      'button[aria-label="Edit template Bug Report"]',
    ) as HTMLButtonElement;
    await act(async () => {
      edit.click();
    });

    await act(async () => {
      setInputValue(container.querySelector("#template-name") as HTMLInputElement, "Bug v2");
    });

    const submit = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Update",
    ) as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });

    expect(patchTemplate).toHaveBeenCalledWith("tpl-1", {
      name: "Bug v2",
      title: "Fix: {{issue}}",
      description: "Steps: {{steps}}",
      priority: 1,
      tag_names: ["bug"],
    });
  });

  it("deletes through the accessible confirmation dialog", async () => {
    render(createElement(TemplatesSection, { templates: [makeTemplate()], tags }));

    const del = container.querySelector(
      'button[aria-label="Delete template Bug Report"]',
    ) as HTMLButtonElement;
    await act(async () => {
      del.click();
    });

    expect(deleteTemplate).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog?.textContent).toContain("Delete template?");

    const confirm = Array.from(dialog.querySelectorAll("button")).find((btn) =>
      btn.getAttribute("aria-label")?.includes("Delete template"),
    ) as HTMLButtonElement;
    await act(async () => {
      confirm.click();
    });

    expect(deleteTemplate).toHaveBeenCalledWith("tpl-1");
  });

  it("does not expose recurrence controls", () => {
    render(createElement(TemplatesSection, { templates: [makeTemplate()], tags }));
    expect((container.textContent ?? "").toLowerCase()).not.toContain("recurrence");
  });
});
