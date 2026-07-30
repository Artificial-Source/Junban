/**
 * Catalog mutation helpers for projects, sections, tags, templates, saved filters.
 */
import { useCallback } from "react";
import type {
  CreateProjectRequest,
  PatchProjectRequest,
  CreateSectionRequest,
  PatchSectionRequest,
  CreateTagRequest,
  PatchTagRequest,
  CreateTemplateRequest,
  PatchTemplateRequest,
  CreateSavedFilterRequest,
  PatchSavedFilterRequest,
} from "../api/client";
import {
  createProject as createProjectApi,
  patchProject as patchProjectApi,
  deleteProject as deleteProjectApi,
  createSection as createSectionApi,
  patchSection as patchSectionApi,
  deleteSection as deleteSectionApi,
  createTag as createTagApi,
  patchTag as patchTagApi,
  deleteTag as deleteTagApi,
  createTemplate as createTemplateApi,
  patchTemplate as patchTemplateApi,
  deleteTemplate as deleteTemplateApi,
  createSavedFilter as createSavedFilterApi,
  patchSavedFilter as patchSavedFilterApi,
  deleteSavedFilter as deleteSavedFilterApi,
} from "../api/client";
import { useWorkspace } from "../context/WorkspaceContext";

export function useCatalogMutations() {
  const { runMutation } = useWorkspace();

  const createProject = useCallback(
    async (body: CreateProjectRequest) =>
      runMutation((opId) => createProjectApi(body, opId), {
        undoLabel: "Create project",
        successToast: "Project created",
      }),
    [runMutation],
  );

  const patchProject = useCallback(
    async (projectId: string, body: PatchProjectRequest) =>
      runMutation((opId) => patchProjectApi(projectId, body, opId), {
        undoLabel: "Edit project",
        successToast: "Project updated",
      }),
    [runMutation],
  );

  const deleteProject = useCallback(
    async (projectId: string) =>
      runMutation((opId) => deleteProjectApi(projectId, opId), { successToast: "Project deleted" }),
    [runMutation],
  );

  const createSection = useCallback(
    async (body: CreateSectionRequest) =>
      runMutation((opId) => createSectionApi(body, opId), {
        undoLabel: "Create section",
        successToast: "Section created",
      }),
    [runMutation],
  );

  const patchSection = useCallback(
    async (sectionId: string, body: PatchSectionRequest) =>
      runMutation((opId) => patchSectionApi(sectionId, body, opId), {
        undoLabel: "Edit section",
        successToast: "Section updated",
      }),
    [runMutation],
  );

  const deleteSection = useCallback(
    async (sectionId: string) =>
      runMutation((opId) => deleteSectionApi(sectionId, opId), {
        undoLabel: "Delete section",
        successToast: "Section deleted",
      }),
    [runMutation],
  );

  const createTag = useCallback(
    async (body: CreateTagRequest) =>
      runMutation((opId) => createTagApi(body, opId), {
        undoLabel: "Create tag",
        successToast: "Tag created",
      }),
    [runMutation],
  );

  const patchTag = useCallback(
    async (tagId: string, body: PatchTagRequest) =>
      runMutation((opId) => patchTagApi(tagId, body, opId), {
        undoLabel: "Edit tag",
        successToast: "Tag updated",
      }),
    [runMutation],
  );

  const deleteTag = useCallback(
    async (tagId: string) =>
      runMutation((opId) => deleteTagApi(tagId, opId), { successToast: "Tag deleted" }),
    [runMutation],
  );

  const createTemplate = useCallback(
    async (body: CreateTemplateRequest) =>
      runMutation((opId) => createTemplateApi(body, opId), {
        undoLabel: "Create template",
        successToast: "Template created",
      }),
    [runMutation],
  );

  const patchTemplate = useCallback(
    async (templateId: string, body: PatchTemplateRequest) =>
      runMutation((opId) => patchTemplateApi(templateId, body, opId), {
        undoLabel: "Edit template",
        successToast: "Template updated",
      }),
    [runMutation],
  );

  const deleteTemplate = useCallback(
    async (templateId: string) =>
      runMutation((opId) => deleteTemplateApi(templateId, opId), {
        successToast: "Template deleted",
      }),
    [runMutation],
  );

  const createSavedFilter = useCallback(
    async (body: CreateSavedFilterRequest) =>
      runMutation((opId) => createSavedFilterApi(body, opId), {
        undoLabel: "Create filter",
        successToast: "Filter saved",
      }),
    [runMutation],
  );

  const patchSavedFilter = useCallback(
    async (filterId: string, body: PatchSavedFilterRequest) =>
      runMutation((opId) => patchSavedFilterApi(filterId, body, opId), {
        undoLabel: "Edit filter",
        successToast: "Filter updated",
      }),
    [runMutation],
  );

  const deleteSavedFilter = useCallback(
    async (filterId: string) =>
      runMutation((opId) => deleteSavedFilterApi(filterId, opId), {
        successToast: "Filter deleted",
      }),
    [runMutation],
  );

  return {
    createProject,
    patchProject,
    deleteProject,
    createSection,
    patchSection,
    deleteSection,
    createTag,
    patchTag,
    deleteTag,
    createTemplate,
    patchTemplate,
    deleteTemplate,
    createSavedFilter,
    patchSavedFilter,
    deleteSavedFilter,
  };
}
