/**
 * Concise Phase 2 DTO aliases over checked generated OpenAPI types.
 * Hand-written code imports from here or `client.ts`, never deep into generated paths.
 */

import type { components, operations } from "./generated";

type Schemas = components["schemas"];

export type TaskDto = Schemas["TaskDto"];
export type TaskListResponse = Schemas["TaskListResponse"];
export type TaskStatusDto = Schemas["TaskStatusDto"];
export type TaskViewPresetDto = Schemas["TaskViewPresetDto"];
export type TaskSortDto = Schemas["TaskSortDto"];
export type TaskFilterDto = Schemas["TaskFilterDto"];
export type LocalDueTimeDto = Schemas["LocalDueTimeDto"];

export type CreateTaskRequest = Schemas["CreateTaskRequest"];
export type PatchTaskRequest = Schemas["PatchTaskRequest"];
export type MoveTaskRequest = Schemas["MoveTaskRequest"];
export type ReorderTasksRequest = Schemas["ReorderTasksRequest"];
export type BulkTasksRequest = Schemas["BulkTasksRequest"];
export type BulkActionDto = Schemas["BulkActionDto"];
export type BulkTagChangeDto = Schemas["BulkTagChangeDto"];
export type BulkScheduleDto = Schemas["BulkScheduleDto"];
export type OrderAnchorDto = Schemas["OrderAnchorDto"];

export type CatalogResponse = Schemas["CatalogResponse"];
export type ProjectDto = Schemas["ProjectDto"];
export type SectionDto = Schemas["SectionDto"];
export type TagDto = Schemas["TagDto"];
export type TemplateDto = Schemas["TemplateDto"];
export type SavedFilterDto = Schemas["SavedFilterDto"];
export type ProjectViewDto = Schemas["ProjectViewDto"];

export type CreateProjectRequest = Schemas["CreateProjectRequest"];
export type PatchProjectRequest = Schemas["PatchProjectRequest"];
export type CreateSectionRequest = Schemas["CreateSectionRequest"];
export type PatchSectionRequest = Schemas["PatchSectionRequest"];
export type CreateTagRequest = Schemas["CreateTagRequest"];
export type PatchTagRequest = Schemas["PatchTagRequest"];
export type CreateTemplateRequest = Schemas["CreateTemplateRequest"];
export type PatchTemplateRequest = Schemas["PatchTemplateRequest"];
export type ApplyTemplateRequest = Schemas["ApplyTemplateRequest"];
export type TemplateVariableDto = Schemas["TemplateVariableDto"];
export type CreateSavedFilterRequest = Schemas["CreateSavedFilterRequest"];
export type PatchSavedFilterRequest = Schemas["PatchSavedFilterRequest"];

export type CommentDto = Schemas["CommentDto"];
export type CommentListResponse = Schemas["CommentListResponse"];
export type CreateCommentRequest = Schemas["CreateCommentRequest"];
export type PatchCommentRequest = Schemas["PatchCommentRequest"];

export type RelationDto = Schemas["RelationDto"];
export type RelationListResponse = Schemas["RelationListResponse"];
export type AddRelationRequest = Schemas["AddRelationRequest"];

export type TaskActivityDto = Schemas["TaskActivityDto"];
export type TaskActivityResponse = Schemas["TaskActivityResponse"];

export type MutationResponse = Schemas["MutationResponse"];
export type CommittedEventDto = Schemas["CommittedEventDto"];
export type AffectedIdsDto = Schemas["AffectedIdsDto"];
export type ResyncScopeDto = Schemas["ResyncScopeDto"];
export type ResourceRefDto = Schemas["ResourceRefDto"];
export type ResourceSnapshotDto = Schemas["ResourceSnapshotDto"];
export type ResourceTypeDto = Schemas["ResourceTypeDto"];

export type ErrorEnvelope = Schemas["ErrorEnvelope"];
export type ErrorBody = Schemas["ErrorBody"];
export type HealthResponse = Schemas["HealthResponse"];
export type ProfileResponse = Schemas["ProfileResponse"];

export type ParseQuickEntryRequest = Schemas["ParseQuickEntryRequest"];
export type ParseFilterRequest = Schemas["ParseFilterRequest"];
export type ParseTextImportRequest = Schemas["ParseTextImportRequest"];
export type QuickEntryDto = Schemas["QuickEntryDto"];
export type ParsedFilterResponse = Schemas["ParsedFilterResponse"];
export type TextImportResponse = Schemas["TextImportResponse"];
export type TextImportDraftDto = Schemas["TextImportDraftDto"];

/** Query parameters for `GET /api/v1/tasks`. */
export type TaskListParams = NonNullable<operations["list_tasks"]["parameters"]["query"]>;

/** Opaque scope token: omitted = any, "-" = null, UUID = exact match. */
export type ScopeFilter = string;
