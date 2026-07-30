/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogResponse, MutationResponse, QuickEntryDto, TagDto } from "../api/client";
import { useTaskMutations } from "./useTaskMutations";

const runMutation = vi.fn();
const refreshCatalog = vi.fn();
const createTaskApi = vi.fn();
const createTagApi = vi.fn();
const getCatalog = vi.fn();
const parseQuickEntryApi = vi.fn();

let catalogState: CatalogResponse | null = null;

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    runMutation: (...args: unknown[]) => runMutation(...args),
    catalog: catalogState,
    refreshCatalog: () => refreshCatalog(),
  }),
}));

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    createTask: (...args: unknown[]) => createTaskApi(...args),
    createTag: (...args: unknown[]) => createTagApi(...args),
    getCatalog: (...args: unknown[]) => getCatalog(...args),
    parseQuickEntry: (...args: unknown[]) => parseQuickEntryApi(...args),
  };
});

function makeCatalog(partial: Partial<CatalogResponse> = {}): CatalogResponse {
  return {
    revision: 1,
    projects: [],
    sections: [],
    tags: [],
    templates: [],
    saved_filters: [],
    ...partial,
  };
}

function makeTag(id: string, name: string): TagDto {
  return {
    id,
    name,
    color: "#8a2be2",
    created_at: "2026-07-28T00:00:00Z",
    updated_at: "2026-07-28T00:00:00Z",
  };
}

function makeProject(id: string, name: string) {
  return {
    id,
    name,
    color: "#000000",
    favorite: false,
    archived: false,
    sort_order: 0,
    created_at: "2026-07-28T00:00:00Z",
    updated_at: "2026-07-28T00:00:00Z",
    view: "list" as const,
  };
}

function quickEntry(partial: Partial<QuickEntryDto> = {}): QuickEntryDto {
  return {
    title: "Buy milk",
    someday: false,
    tag_names: [],
    ...partial,
  };
}

function tagMutation(tag: TagDto): MutationResponse {
  return {
    event: {
      operation_id: "op-tag",
      revision: 2,
      occurred_at: "2026-07-28T00:00:00Z",
      event_type: "tag.created",
      affected: { tag_ids: [tag.id] },
      resync: { tasks: false, catalog: false },
      snapshot: { resource_type: "tag", tag },
    },
  };
}

function taskMutation(): MutationResponse {
  return {
    event: {
      operation_id: "op-task",
      revision: 3,
      occurred_at: "2026-07-28T00:00:00Z",
      event_type: "task.created",
      affected: { task_ids: ["task-1"] },
      resync: { tasks: false, catalog: false },
      snapshot: null,
    },
  };
}

describe("useTaskMutations createFromQuickEntry", () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof useTaskMutations>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    runMutation.mockReset();
    refreshCatalog.mockReset();
    createTaskApi.mockReset();
    createTagApi.mockReset();
    getCatalog.mockReset();
    catalogState = makeCatalog();
    api = undefined as unknown as ReturnType<typeof useTaskMutations>;

    function Probe() {
      api = useTaskMutations();
      return null;
    }
    act(() => {
      root.render(createElement(Probe));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("includes resolved existing tag and project IDs and preserves scalars", async () => {
    catalogState = makeCatalog({
      tags: [makeTag("tag-1", "Groceries")],
      projects: [makeProject("proj-1", "Home")],
    });
    // Remount so the hook sees the updated catalog closure.
    act(() => {
      root.render(
        createElement(() => {
          api = useTaskMutations();
          return null;
        }),
      );
    });

    runMutation.mockImplementation(async (execute: (opId: string) => Promise<MutationResponse>) => {
      return execute("op-1");
    });
    createTaskApi.mockResolvedValue(taskMutation());

    await act(async () => {
      await api.createFromQuickEntry(
        quickEntry({
          title: "Buy milk",
          priority: 2,
          due_date: "2026-07-29",
          someday: false,
          estimated_minutes: 15,
          dread: 3,
          recurrence_rule: "weekly",
          tag_names: ["groceries"],
          project_name: "home",
        }),
        { description: "from-view" },
      );
    });

    expect(createTagApi).not.toHaveBeenCalled();
    expect(createTaskApi).toHaveBeenCalledTimes(1);
    const [body] = createTaskApi.mock.calls[0] as [Record<string, unknown>, string];
    expect(body).toMatchObject({
      title: "Buy milk",
      priority: 2,
      due_date: "2026-07-29",
      estimated_minutes: 15,
      dread: 3,
      recurrence_rule: "weekly",
      description: "from-view",
      tag_ids: ["tag-1"],
      project_id: "proj-1",
    });
  });

  it("creates a missing tag through the catalog mutation API then uses its ID", async () => {
    catalogState = makeCatalog({ tags: [] });
    act(() => {
      root.render(
        createElement(() => {
          api = useTaskMutations();
          return null;
        }),
      );
    });
    const created = makeTag("tag-new", "errands");

    runMutation.mockImplementation(async (execute: (opId: string) => Promise<MutationResponse>) => {
      return execute("op-x");
    });
    createTagApi.mockResolvedValue(tagMutation(created));
    createTaskApi.mockResolvedValue(taskMutation());

    await act(async () => {
      await api.createFromQuickEntry(quickEntry({ tag_names: ["errands"] }));
    });

    expect(createTagApi).toHaveBeenCalledWith({ name: "errands", color: "#8a2be2" }, "op-x");
    const [body] = createTaskApi.mock.calls[0] as [Record<string, unknown>, string];
    expect(body.tag_ids).toEqual(["tag-new"]);
  });

  it("re-resolves after a failed concurrent tag create instead of inventing a duplicate", async () => {
    catalogState = makeCatalog({ tags: [] });
    act(() => {
      root.render(
        createElement(() => {
          api = useTaskMutations();
          return null;
        }),
      );
    });
    const raced = makeTag("tag-raced", "shared");

    let tagAttempts = 0;
    createTagApi.mockRejectedValueOnce(new Error("conflict"));
    runMutation.mockImplementation(async (execute: (opId: string) => Promise<MutationResponse>) => {
      tagAttempts += 1;
      if (tagAttempts === 1) {
        await execute("op-tag").catch(() => null);
        return null;
      }
      return execute("op-task");
    });
    getCatalog.mockResolvedValue(makeCatalog({ tags: [raced], revision: 9 }));
    createTaskApi.mockResolvedValue(taskMutation());

    await act(async () => {
      await api.createFromQuickEntry(quickEntry({ tag_names: ["shared"] }));
    });

    expect(createTagApi).toHaveBeenCalledTimes(1);
    expect(getCatalog).toHaveBeenCalled();
    expect(refreshCatalog).toHaveBeenCalled();
    const [body] = createTaskApi.mock.calls[0] as [Record<string, unknown>, string];
    expect(body.tag_ids).toEqual(["tag-raced"]);
  });

  it("rejects unknown or ambiguous projects without creating a task", async () => {
    catalogState = makeCatalog({
      projects: [makeProject("p1", "Work"), makeProject("p2", "work")],
    });
    act(() => {
      root.render(
        createElement(() => {
          api = useTaskMutations();
          return null;
        }),
      );
    });

    await expect(
      act(async () => {
        await api.createFromQuickEntry(quickEntry({ project_name: "Work" }));
      }),
    ).rejects.toThrow(/Ambiguous project/);
    expect(createTaskApi).not.toHaveBeenCalled();

    catalogState = makeCatalog({ projects: [] });
    act(() => {
      root.render(
        createElement(() => {
          api = useTaskMutations();
          return null;
        }),
      );
    });
    await expect(
      act(async () => {
        await api.createFromQuickEntry(quickEntry({ project_name: "Missing" }));
      }),
    ).rejects.toThrow(/Unknown project/);
    expect(createTaskApi).not.toHaveBeenCalled();
  });
});
